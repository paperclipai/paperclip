import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface BranchAuditWorktree {
  path: string;
  branch: string | null;
  head: string | null;
  state: "active" | "prunable" | "detached" | "bare";
  reason: string | null;
  locked: boolean;
}

export interface BranchAuditRow {
  name: string;
  upstream: string | null;
  mergedIntoBase: boolean | null;
  aheadCount: number | null;
  behindCount: number | null;
  uniqueCommitCount: number | null;
  worktreePath: string | null;
  worktreeState: BranchAuditWorktree["state"] | null;
  lastCommit: string | null;
  lastSubject: string | null;
}

export interface BranchAuditReport {
  repoRoot: string;
  baseRef: string;
  generatedAt: Date;
  worktrees: BranchAuditWorktree[];
  branches: BranchAuditRow[];
}

function readNonEmptyString(value: string | null | undefined) {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function runGit(repoRoot: string, args: string[]) {
  const result = await execFileAsync("git", ["-C", repoRoot, ...args], { cwd: repoRoot });
  return result.stdout.trimEnd();
}

function parseWorktreeRef(ref: string | null) {
  if (!ref) return null;
  return ref.replace(/^refs\/heads\//, "");
}

function parseWorktreeList(output: string): BranchAuditWorktree[] {
  const blocks = output
    .split(/\n\n+/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);

  return blocks.map((block) => {
    let path: string | null = null;
    let branch: string | null = null;
    let head: string | null = null;
    let state: BranchAuditWorktree["state"] = "detached";
    let reason: string | null = null;
    let locked = false;

    for (const line of block.split(/\n/)) {
      if (line.startsWith("worktree ")) {
        path = readNonEmptyString(line.slice("worktree ".length));
        continue;
      }
      if (line.startsWith("HEAD ")) {
        head = readNonEmptyString(line.slice("HEAD ".length));
        continue;
      }
      if (line.startsWith("branch ")) {
        branch = parseWorktreeRef(readNonEmptyString(line.slice("branch ".length)));
        state = "active";
        continue;
      }
      if (line === "detached") {
        state = "detached";
        continue;
      }
      if (line === "bare") {
        state = "bare";
        continue;
      }
      if (line.startsWith("prunable")) {
        state = "prunable";
        reason = readNonEmptyString(line.slice("prunable".length));
        continue;
      }
      if (line.startsWith("locked")) {
        locked = true;
        reason = reason ?? readNonEmptyString(line.slice("locked".length));
      }
    }

    if (!path) {
      throw new Error(`Malformed git worktree output block: ${block}`);
    }

    return {
      path,
      branch,
      head,
      state,
      reason,
      locked,
    };
  });
}

function parseAheadBehind(raw: string) {
  const [behindRaw, aheadRaw] = raw.trim().split(/\s+/);
  const parsedBehindCount = behindRaw ? Number.parseInt(behindRaw, 10) : null;
  const parsedAheadCount = aheadRaw ? Number.parseInt(aheadRaw, 10) : null;
  return {
    behindCount: parsedBehindCount !== null && Number.isFinite(parsedBehindCount) ? parsedBehindCount : null,
    aheadCount: parsedAheadCount !== null && Number.isFinite(parsedAheadCount) ? parsedAheadCount : null,
  };
}

function normalizeProtectedBranchName(baseRef: string) {
  return baseRef
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\//, "")
    .replace(/^[^/]+\//, "");
}

export async function listGitWorktrees(repoRoot: string): Promise<BranchAuditWorktree[]> {
  const output = await runGit(repoRoot, ["worktree", "list", "--porcelain"]);
  return parseWorktreeList(output);
}

export async function pruneGitWorktrees(repoRoot: string) {
  await runGit(repoRoot, ["worktree", "prune"]);
}

export async function collectBranchAudit(
  repoRoot: string,
  options?: {
    baseRef?: string;
  },
): Promise<BranchAuditReport> {
  const baseRef = readNonEmptyString(options?.baseRef) ?? "master";
  const [worktrees, refsOutput] = await Promise.all([
    listGitWorktrees(repoRoot),
    runGit(repoRoot, ["for-each-ref", "refs/heads", "--format=%(refname:short)%00%(upstream:short)%00%(objectname)%00%(subject)"]),
  ]);

  const worktreeByBranch = new Map<string, BranchAuditWorktree>();
  for (const worktree of worktrees) {
    if (worktree.branch && !worktreeByBranch.has(worktree.branch)) {
      worktreeByBranch.set(worktree.branch, worktree);
    }
  }

  const branches = await Promise.all(
    refsOutput
      .split(/\n/)
      .filter((line) => line.length > 0)
      .map(async (line): Promise<BranchAuditRow> => {
        const [nameRaw, upstreamRaw, lastCommitRaw, lastSubjectRaw] = line.split("\u0000");
        const name = nameRaw.trim();
        const worktree = worktreeByBranch.get(name) ?? null;

        let mergedIntoBase: boolean | null = null;
        try {
          await runGit(repoRoot, ["merge-base", "--is-ancestor", name, baseRef]);
          mergedIntoBase = true;
        } catch (error) {
          const code = typeof error === "object" && error && "code" in error
            ? (error as { code?: unknown }).code
            : null;
          if (code === 1) {
            mergedIntoBase = false;
          } else {
            mergedIntoBase = null;
          }
        }

        let aheadCount: number | null = null;
        let behindCount: number | null = null;
        try {
          const counts = parseAheadBehind(await runGit(repoRoot, ["rev-list", "--left-right", "--count", `${baseRef}...${name}`]));
          aheadCount = counts.aheadCount;
          behindCount = counts.behindCount;
        } catch {
          aheadCount = null;
          behindCount = null;
        }

        return {
          name,
          upstream: readNonEmptyString(upstreamRaw),
          mergedIntoBase,
          aheadCount,
          behindCount,
          uniqueCommitCount: aheadCount,
          worktreePath: worktree?.path ?? null,
          worktreeState: worktree?.state ?? null,
          lastCommit: readNonEmptyString(lastCommitRaw),
          lastSubject: readNonEmptyString(lastSubjectRaw),
        };
      }),
  );

  branches.sort((left, right) => left.name.localeCompare(right.name));
  return {
    repoRoot,
    baseRef,
    generatedAt: new Date(),
    worktrees,
    branches,
  };
}

export async function deleteMergedLocalBranches(
  repoRoot: string,
  options?: {
    baseRef?: string;
    preserveAttachedWorktrees?: boolean;
  },
) {
  const report = await collectBranchAudit(repoRoot, { baseRef: options?.baseRef });
  const protectedBranch = normalizeProtectedBranchName(report.baseRef);
  const preserveAttachedWorktrees = options?.preserveAttachedWorktrees !== false;
  const deleted: string[] = [];
  const skipped: Array<{ branch: string; reason: string }> = [];

  for (const branch of report.branches) {
    if (branch.name === protectedBranch) {
      skipped.push({ branch: branch.name, reason: "base branch" });
      continue;
    }
    if (branch.mergedIntoBase !== true) {
      skipped.push({ branch: branch.name, reason: "not merged" });
      continue;
    }
    if (preserveAttachedWorktrees && branch.worktreeState === "active") {
      skipped.push({ branch: branch.name, reason: "active worktree" });
      continue;
    }
    try {
      await runGit(repoRoot, ["branch", "-d", branch.name]);
      deleted.push(branch.name);
    } catch (error) {
      skipped.push({
        branch: branch.name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    report,
    deleted,
    skipped,
  };
}
