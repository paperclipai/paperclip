import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";

const execFileAsync = promisify(execFile);
const WORKSPACE_METADATA_FILENAME = "paperclip-workspace.json";
const PATH_SEGMENT_RE = /[^a-zA-Z0-9._-]+/g;
const MAX_SEGMENT_PREFIX_LENGTH = 32;

type ManagedWorkspaceMode = "git_worktree" | "directory_copy";

export interface TaskScopedProjectWorkspace {
  cwd: string;
  mode: ManagedWorkspaceMode;
  rootDir: string;
  warnings: string[];
}

function readNonEmptyString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function sanitizeSegment(value: string | null | undefined, fallback: string): string {
  const trimmed = readNonEmptyString(value);
  if (!trimmed) return fallback;
  const normalized = trimmed
    .replace(PATH_SEGMENT_RE, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, MAX_SEGMENT_PREFIX_LENGTH);
  return normalized || fallback;
}

function scopeSegment(value: string | null | undefined): string {
  const trimmed = readNonEmptyString(value) ?? "scope";
  return `${sanitizeSegment(trimmed.toLowerCase(), "scope")}-${fingerprint(trimmed)}`;
}

function buildManagedWorkspaceRoot(input: {
  agentId: string;
  projectId: string | null;
  taskKey: string | null;
  workspaceId: string;
}) {
  return path.join(
    resolveDefaultAgentWorkspaceDir(input.agentId),
    "project-workspaces",
    sanitizeSegment(input.projectId, "project"),
    scopeSegment(input.taskKey ?? input.projectId ?? input.workspaceId),
    sanitizeSegment(input.workspaceId, "workspace"),
  );
}

function buildManagedBranchName(input: {
  agentId: string;
  workspaceId: string;
  taskKey: string | null;
  projectId: string | null;
}) {
  const scope = scopeSegment(input.taskKey ?? input.projectId ?? input.workspaceId);
  return [
    "paperclip",
    sanitizeSegment(input.agentId, "agent"),
    sanitizeSegment(input.workspaceId, "workspace"),
    scope,
  ].join("/");
}

async function runGit(cwd: string, args: string[]) {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
    });
    return {
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  } catch (err) {
    const error = err as Error & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    const stdout = typeof error.stdout === "string" ? error.stdout.trim() : "";
    const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
    const reason = stderr || stdout || error.message || String(err);
    throw new Error(`git ${args.join(" ")} failed in "${cwd}": ${reason}`);
  }
}

async function tryRunGit(cwd: string, args: string[]) {
  try {
    return await runGit(cwd, args);
  } catch {
    return null;
  }
}

async function gitCommandSucceeds(cwd: string, args: string[]) {
  return (await tryRunGit(cwd, args)) !== null;
}

async function detectGitProjectWorkspace(projectCwd: string) {
  const repoRootResult = await tryRunGit(projectCwd, ["rev-parse", "--show-toplevel"]);
  if (!repoRootResult?.stdout) return null;

  const repoRoot = path.resolve(repoRootResult.stdout);
  const relativeCwd = path.relative(repoRoot, path.resolve(projectCwd));
  if (relativeCwd.startsWith("..") || path.isAbsolute(relativeCwd)) return null;

  return {
    repoRoot,
    relativeCwd: relativeCwd === "" ? "" : relativeCwd,
  };
}

async function listDirtyEntries(repoRoot: string) {
  const dirty = await tryRunGit(repoRoot, ["status", "--porcelain", "--untracked-files=all"]);
  if (!dirty?.stdout) return [];
  return dirty.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function detectInterruptedOperation(repoRoot: string): Promise<"rebase" | "merge" | null> {
  const hasRebaseHead = await gitCommandSucceeds(repoRoot, [
    "rev-parse", "--verify", "--quiet", "REBASE_HEAD",
  ]);
  if (hasRebaseHead) return "rebase";

  const hasMergeHead = await gitCommandSucceeds(repoRoot, [
    "rev-parse", "--verify", "--quiet", "MERGE_HEAD",
  ]);
  if (hasMergeHead) return "merge";

  return null;
}

async function ensureDirectoryAbsent(dir: string) {
  await fs.rm(dir, { recursive: true, force: true });
}

async function writeWorkspaceMetadata(rootDir: string, metadata: Record<string, unknown>) {
  await fs.mkdir(rootDir, { recursive: true });
  await fs.writeFile(
    path.join(rootDir, WORKSPACE_METADATA_FILENAME),
    JSON.stringify(metadata, null, 2),
    "utf8",
  );
}

async function ensureGitWorktree(input: {
  repoRoot: string;
  managedRoot: string;
  agentId: string;
  workspaceId: string;
  taskKey: string | null;
  projectId: string | null;
}) {
  const checkoutRoot = path.join(input.managedRoot, "repo");
  const branchName = buildManagedBranchName(input);
  const existingTopLevel = await tryRunGit(checkoutRoot, ["rev-parse", "--show-toplevel"]);
  if (existingTopLevel?.stdout && path.resolve(existingTopLevel.stdout) === path.resolve(checkoutRoot)) {
    return {
      checkoutRoot,
      branchName,
      created: false,
    };
  }

  await ensureDirectoryAbsent(checkoutRoot);
  await fs.mkdir(input.managedRoot, { recursive: true });

  await tryRunGit(input.repoRoot, ["worktree", "prune"]);
  const branchExists = await gitCommandSucceeds(
    input.repoRoot,
    ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
  );
  if (branchExists) {
    await runGit(input.repoRoot, ["worktree", "add", "--checkout", checkoutRoot, branchName]);
  } else {
    await runGit(input.repoRoot, ["worktree", "add", "--checkout", "-b", branchName, checkoutRoot, "HEAD"]);
  }

  return {
    checkoutRoot,
    branchName,
    created: true,
  };
}

async function ensureDirectoryCopyWorkspace(input: {
  projectCwd: string;
  managedRoot: string;
}) {
  const checkoutRoot = path.join(input.managedRoot, "copy");
  const stats = await fs.stat(checkoutRoot).catch(() => null);
  if (stats?.isDirectory()) {
    return {
      checkoutRoot,
      created: false,
    };
  }

  await ensureDirectoryAbsent(checkoutRoot);
  await fs.mkdir(input.managedRoot, { recursive: true });
  await fs.cp(input.projectCwd, checkoutRoot, { recursive: true });

  return {
    checkoutRoot,
    created: true,
  };
}

export async function ensureTaskScopedProjectWorkspace(input: {
  agentId: string;
  projectId: string | null;
  taskKey: string | null;
  workspaceId: string;
  projectCwd: string;
  repoUrl: string | null;
  repoRef: string | null;
}): Promise<TaskScopedProjectWorkspace> {
  const managedRoot = buildManagedWorkspaceRoot(input);
  const gitWorkspace = await detectGitProjectWorkspace(input.projectCwd);

  if (gitWorkspace) {
    const dirtyEntries = await listDirtyEntries(gitWorkspace.repoRoot);
    const interruptedOp = await detectInterruptedOperation(gitWorkspace.repoRoot);
    const { checkoutRoot, branchName, created } = await ensureGitWorktree({
      repoRoot: gitWorkspace.repoRoot,
      managedRoot,
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      taskKey: input.taskKey,
      projectId: input.projectId,
    });
    await writeWorkspaceMetadata(managedRoot, {
      mode: "git_worktree",
      agentId: input.agentId,
      projectId: input.projectId,
      taskKey: input.taskKey,
      workspaceId: input.workspaceId,
      sourceProjectCwd: input.projectCwd,
      sourceRepoRoot: gitWorkspace.repoRoot,
      relativeCwd: gitWorkspace.relativeCwd || null,
      repoUrl: input.repoUrl,
      repoRef: input.repoRef,
      branchName,
    });

    const candidateCwd = gitWorkspace.relativeCwd
      ? path.join(checkoutRoot, gitWorkspace.relativeCwd)
      : checkoutRoot;
    const candidateExists = await fs
      .stat(candidateCwd)
      .then((stats) => stats.isDirectory())
      .catch(() => false);
    const cwd = candidateExists ? candidateCwd : checkoutRoot;
    const warnings: string[] = [];
    if (created) {
      warnings.push(
        `Using isolated git worktree "${cwd}" for project workspace "${input.projectCwd}".`,
      );
      if (interruptedOp) {
        warnings.push(
          `Shared project workspace "${input.projectCwd}" has an interrupted ${interruptedOp} in progress. The isolated worktree is unaffected, but the shared checkout needs manual cleanup before direct use.`,
        );
      }
      if (dirtyEntries.length > 0) {
        warnings.push(
          `Shared project workspace "${input.projectCwd}" has ${dirtyEntries.length} uncommitted change(s); they were left in the shared checkout and not copied into the isolated task workspace.`,
        );
      }
    }
    if (!candidateExists && gitWorkspace.relativeCwd) {
      warnings.push(
        `Project workspace subdirectory "${input.projectCwd}" was not present inside isolated checkout "${checkoutRoot}". Using checkout root instead.`,
      );
    }
    return {
      cwd,
      mode: "git_worktree",
      rootDir: managedRoot,
      warnings,
    };
  }

  const { checkoutRoot, created } = await ensureDirectoryCopyWorkspace({
    projectCwd: input.projectCwd,
    managedRoot,
  });
  await writeWorkspaceMetadata(managedRoot, {
    mode: "directory_copy",
    agentId: input.agentId,
    projectId: input.projectId,
    taskKey: input.taskKey,
    workspaceId: input.workspaceId,
    sourceProjectCwd: input.projectCwd,
    repoUrl: input.repoUrl,
    repoRef: input.repoRef,
  });

  const warnings = created
    ? [
        `Using isolated directory copy "${checkoutRoot}" for non-git project workspace "${input.projectCwd}". Changes stay in the task workspace and are not auto-synced back to the shared source directory.`,
      ]
    : [];

  return {
    cwd: checkoutRoot,
    mode: "directory_copy",
    rootDir: managedRoot,
    warnings,
  };
}
