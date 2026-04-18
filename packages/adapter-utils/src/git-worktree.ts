import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GIT_EXEC_TIMEOUT_MS = 30_000;

export interface WorktreeResult {
  cwd: string;
  branch: string;
  created: boolean;
}

export interface WorktreeOptions {
  repoCwd: string;
  branchName: string;
  worktreePath: string;
  baseBranch?: string;
  onLog: (stream: "stdout" | "stderr", msg: string) => Promise<void>;
}

export interface WorktreeRemoveOptions {
  repoCwd: string;
  worktreePath: string;
  /** If provided, the branch is deleted after the worktree is removed. */
  deleteBranch?: { branchName: string };
  onLog: (stream: "stdout" | "stderr", msg: string) => Promise<void>;
}

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, { cwd, timeout: GIT_EXEC_TIMEOUT_MS });
}

/**
 * Check whether a directory is inside a git repository.
 */
export async function isGitRepository(dir: string): Promise<boolean> {
  try {
    await git(dir, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the root of the git repository containing `dir`.
 */
export async function gitRepoRoot(dir: string): Promise<string> {
  const { stdout } = await git(dir, ["rev-parse", "--show-toplevel"]);
  return stdout.trim();
}

/**
 * Create a git worktree for an agent run, or reuse one if it already exists.
 *
 * The worktree is created at `worktreePath` on a new branch `branchName`
 * based on `baseBranch` (defaults to HEAD). If the branch or worktree
 * already exists, it is reused without error.
 */
export async function ensureGitWorktree(opts: WorktreeOptions): Promise<WorktreeResult> {
  const { repoCwd, branchName, worktreePath, baseBranch, onLog } = opts;
  const absWorktree = path.resolve(repoCwd, worktreePath);

  // Check if worktree already exists by querying git directly.
  // Resolve symlinks (e.g., /tmp → /private/tmp on macOS) for reliable comparison.
  const existingWorktrees = await listGitWorktrees(repoCwd);
  const realAbsWorktree = await fs.realpath(path.dirname(absWorktree)).then(
    (real) => path.join(real, path.basename(absWorktree)),
    () => absWorktree,
  );
  const worktreeExists = existingWorktrees.some(
    (wt) => path.resolve(wt) === realAbsWorktree,
  );

  if (worktreeExists) {
    await onLog("stderr", `[paperclip] Reusing existing worktree at ${absWorktree}\n`);
    return { cwd: absWorktree, branch: branchName, created: false };
  }

  // Check if the branch already exists
  const branchExists = await git(repoCwd, ["rev-parse", "--verify", `refs/heads/${branchName}`])
    .then(() => true)
    .catch(() => false);

  // Ensure parent directory exists
  await fs.mkdir(path.dirname(absWorktree), { recursive: true });

  // Prune stale worktree bookkeeping before adding. If a previous worktree
  // directory was deleted without `git worktree remove`, the branch is still
  // recorded as checked-out and `worktree add` will fail.
  await pruneGitWorktrees(repoCwd);

  try {
    if (branchExists) {
      // Branch exists but no worktree — attach worktree to existing branch
      await git(repoCwd, ["worktree", "add", absWorktree, branchName]);
    } else {
      // Create new branch + worktree
      const base = baseBranch || "HEAD";
      await git(repoCwd, ["worktree", "add", "-b", branchName, absWorktree, base]);
    }

    await onLog("stderr", `[paperclip] Created worktree at ${absWorktree} on branch ${branchName}\n`);
    return { cwd: absWorktree, branch: branchName, created: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await onLog("stderr", `[paperclip] Failed to create worktree: ${reason}\n`);
    throw new Error(`Failed to create git worktree at "${absWorktree}": ${reason}`);
  }
}

/**
 * Remove a git worktree. Optionally delete the associated branch via `deleteBranch`.
 *
 * Returns `true` if the worktree was successfully removed, `false` otherwise.
 */
export async function removeGitWorktree(opts: WorktreeRemoveOptions): Promise<boolean> {
  const { repoCwd, worktreePath, deleteBranch, onLog } = opts;
  const absWorktree = path.resolve(repoCwd, worktreePath);

  let removed = false;
  try {
    await git(repoCwd, ["worktree", "remove", absWorktree, "--force"]);
    await onLog("stderr", `[paperclip] Removed worktree at ${absWorktree}\n`);
    removed = true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await onLog("stderr", `[paperclip] Warning: failed to remove worktree at ${absWorktree}: ${reason}\n`);
  }

  if (deleteBranch) {
    try {
      await git(repoCwd, ["branch", "-d", deleteBranch.branchName]);
      await onLog("stderr", `[paperclip] Deleted branch ${deleteBranch.branchName}\n`);
    } catch {
      // Non-fatal: branch may still have unmerged changes or already be gone
    }
  }

  return removed;
}

/**
 * List all worktrees for a repository.
 */
export async function listGitWorktrees(repoCwd: string): Promise<string[]> {
  try {
    const { stdout } = await git(repoCwd, ["worktree", "list", "--porcelain"]);
    return stdout
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));
  } catch {
    return [];
  }
}

/**
 * Prune stale worktrees whose directories no longer exist.
 */
export async function pruneGitWorktrees(repoCwd: string): Promise<void> {
  try {
    await git(repoCwd, ["worktree", "prune"]);
  } catch {
    // Non-fatal
  }
}

/**
 * Build a sanitized slug from an agent name, suitable for branch names.
 */
export function agentSlug(agentName: string): string {
  const slug = agentName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return slug || "agent";
}

/**
 * Sanitize a task/issue ID into a suffix safe for branch names and paths.
 * Returns `"general"` when no ID is provided.
 */
export function taskSuffix(taskId: string | null | undefined): string {
  if (!taskId || taskId.trim().length === 0) return "general";
  return taskId.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 20);
}

/**
 * Build the standard worktree directory path for a Paperclip agent run.
 *
 * The worktree is placed next to the repo root under `.paperclip-worktrees/`.
 */
export function worktreeDir(repoCwd: string, agentName: string, taskId: string | null): string {
  const slug = agentSlug(agentName);
  const suffix = taskSuffix(taskId);
  const normalizedRoot = path.resolve(repoCwd);
  return path.join(path.dirname(normalizedRoot), `.paperclip-worktrees`, `${slug}-${suffix}`);
}

/**
 * Build the standard branch name for a Paperclip agent run.
 */
export function worktreeBranch(agentName: string, taskId: string | null): string {
  const slug = agentSlug(agentName);
  const suffix = taskSuffix(taskId);
  return `paperclip/${slug}/${suffix}`;
}

/**
 * Check whether a directory path looks like a Paperclip-managed worktree.
 */
export function isPaperclipWorktree(dir: string): boolean {
  return path.resolve(dir).includes(`${path.sep}.paperclip-worktrees${path.sep}`);
}
