import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * DirtyGuard inspects a checkout for state that makes a branch switch
 * unsafe. It is used by the legacy `project_primary` strategy. Worktrees
 * never branch-switch, so they do not exercise this guard.
 *
 * The contract from the GST-951 plan §7 is:
 *  - A switch attempt is forbidden if the tree is dirty, has untracked
 *    files tracked by another issue, or has an in-progress merge/rebase/
 *    cherry-pick/revert/auto-merge.
 *  - On violation, raise a first-class `workspace_dirty` blocker on the
 *    *current* issue, naming the owning branch.
 *  - Never `git stash`, `git reset`, or `--force` to make the switch
 *    happen.
 */

export type DirtyGuardReason =
  | "porcelain_modified"
  | "porcelain_untracked"
  | "merge_in_progress"
  | "rebase_in_progress"
  | "cherry_pick_in_progress"
  | "revert_in_progress"
  | "auto_merge_in_progress";

export interface DirtyGuardFinding {
  reason: DirtyGuardReason;
  detail: string;
}

export interface DirtyGuardReport {
  clean: boolean;
  findings: DirtyGuardFinding[];
  /** Branch currently checked out in this working tree, if any. */
  currentBranch: string | null;
}

const IN_PROGRESS_FILES: Array<{ file: string; reason: DirtyGuardReason }> = [
  { file: "MERGE_HEAD", reason: "merge_in_progress" },
  { file: "REBASE_HEAD", reason: "rebase_in_progress" },
  { file: "CHERRY_PICK_HEAD", reason: "cherry_pick_in_progress" },
  { file: "REVERT_HEAD", reason: "revert_in_progress" },
  { file: "AUTO_MERGE", reason: "auto_merge_in_progress" },
];

interface RunGitOptions {
  cwd: string;
  args: string[];
}

interface RunGitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runGit(opts: RunGitOptions): Promise<RunGitResult> {
  return await new Promise<RunGitResult>((resolve, reject) => {
    const child = spawn("git", opts.args, { cwd: opts.cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function resolveGitDir(cwd: string): Promise<string | null> {
  const proc = await runGit({ cwd, args: ["rev-parse", "--git-dir"] });
  if (proc.code !== 0) return null;
  const value = proc.stdout.trim();
  if (!value) return null;
  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

interface PorcelainParse {
  modified: string[];
  untracked: string[];
  currentBranch: string | null;
}

function parsePorcelainV2(output: string): PorcelainParse {
  const modified: string[] = [];
  const untracked: string[] = [];
  let currentBranch: string | null = null;
  const lines = output.split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length).trim();
      currentBranch = head === "(detached)" ? null : head;
      continue;
    }
    if (line.startsWith("# ")) continue;
    if (line.startsWith("? ")) {
      untracked.push(line.slice(2).trim());
      continue;
    }
    if (line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("u ")) {
      const parts = line.split(" ");
      const pathField = parts[parts.length - 1] ?? "";
      modified.push(pathField);
    }
  }
  return { modified, untracked, currentBranch };
}

export interface InspectWorkspaceCleanlinessInput {
  cwd: string;
}

export async function inspectWorkspaceCleanliness(
  input: InspectWorkspaceCleanlinessInput,
): Promise<DirtyGuardReport> {
  const findings: DirtyGuardFinding[] = [];
  const gitDir = await resolveGitDir(input.cwd);

  const porcelain = await runGit({
    cwd: input.cwd,
    args: ["status", "--porcelain=v2", "--branch", "--untracked-files=all"],
  });
  let parse: PorcelainParse = { modified: [], untracked: [], currentBranch: null };
  if (porcelain.code === 0) {
    parse = parsePorcelainV2(porcelain.stdout);
  }
  if (parse.modified.length > 0) {
    findings.push({
      reason: "porcelain_modified",
      detail: `Modified or unmerged entries: ${parse.modified.slice(0, 6).join(", ")}${parse.modified.length > 6 ? "…" : ""}`,
    });
  }
  if (parse.untracked.length > 0) {
    findings.push({
      reason: "porcelain_untracked",
      detail: `Untracked paths: ${parse.untracked.slice(0, 6).join(", ")}${parse.untracked.length > 6 ? "…" : ""}`,
    });
  }

  if (gitDir) {
    for (const { file, reason } of IN_PROGRESS_FILES) {
      const absolutePath = path.join(gitDir, file);
      if (existsSync(absolutePath)) {
        findings.push({
          reason,
          detail: `${file} present in ${gitDir}`,
        });
      }
    }
  }

  return {
    clean: findings.length === 0,
    findings,
    currentBranch: parse.currentBranch,
  };
}

export class WorkspaceDirtyError extends Error {
  readonly code = "workspace_dirty";
  readonly cwd: string;
  readonly findings: DirtyGuardFinding[];
  readonly currentBranch: string | null;
  /**
   * The execution-workspace id that currently owns the branch on this
   * checkout, if discoverable. The caller uses this when raising the
   * blocker so the dependent issue points at the right tree.
   */
  readonly owningExecutionWorkspaceId: string | null;

  constructor(input: {
    cwd: string;
    findings: DirtyGuardFinding[];
    currentBranch: string | null;
    owningExecutionWorkspaceId: string | null;
  }) {
    const summary = input.findings.map((f) => `${f.reason}: ${f.detail}`).join("; ");
    super(
      `Refusing to switch branches: working tree at ${input.cwd} is dirty or has in-progress git state (${summary || "unknown"}).`,
    );
    this.cwd = input.cwd;
    this.findings = input.findings;
    this.currentBranch = input.currentBranch;
    this.owningExecutionWorkspaceId = input.owningExecutionWorkspaceId;
  }
}

export interface AssertWorkspaceCleanInput {
  cwd: string;
  owningExecutionWorkspaceId?: string | null;
}

export async function assertWorkspaceCleanForBranchSwitch(
  input: AssertWorkspaceCleanInput,
): Promise<DirtyGuardReport> {
  const report = await inspectWorkspaceCleanliness({ cwd: input.cwd });
  if (!report.clean) {
    throw new WorkspaceDirtyError({
      cwd: input.cwd,
      findings: report.findings,
      currentBranch: report.currentBranch,
      owningExecutionWorkspaceId: input.owningExecutionWorkspaceId ?? null,
    });
  }
  return report;
}
