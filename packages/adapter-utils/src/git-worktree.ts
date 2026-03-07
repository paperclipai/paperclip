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

  // Check if worktree already exists at this path
  const worktreeExists = await fs
    .stat(path.join(absWorktree, ".git"))
    .then(() => true)
    .catch(() => false);

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
 * Remove a git worktree and optionally delete its branch.
 */
export async function removeGitWorktree(opts: WorktreeRemoveOptions): Promise<void> {
  const { repoCwd, worktreePath, onLog } = opts;
  const absWorktree = path.resolve(repoCwd, worktreePath);

  try {
    await git(repoCwd, ["worktree", "remove", absWorktree, "--force"]);
    await onLog("stderr", `[paperclip] Removed worktree at ${absWorktree}\n`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await onLog("stderr", `[paperclip] Warning: failed to remove worktree at ${absWorktree}: ${reason}\n`);
  }
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
  return agentName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

/**
 * Build the standard worktree path for a Paperclip agent run.
 */
export function worktreePath(repoCwd: string, agentName: string, runId: string): string {
  const slug = agentSlug(agentName);
  const shortRun = runId.slice(0, 8);
  return path.join(path.dirname(repoCwd), `.paperclip-worktrees`, `${slug}-${shortRun}`);
}

/**
 * Build the standard branch name for a Paperclip agent run.
 */
export function worktreeBranch(agentName: string, taskId: string | null): string {
  const slug = agentSlug(agentName);
  const suffix = taskId ? taskId.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 20) : "general";
  return `paperclip/${slug}/${suffix}`;
}

/**
 * Detect whether `dir` is inside a `.paperclip-worktrees` directory.
 */
export function isPaperclipWorktree(dir: string): boolean {
  return dir.includes(`${path.sep}.paperclip-worktrees${path.sep}`) ||
    dir.includes("/.paperclip-worktrees/");
}

/**
 * Remove all Paperclip worktrees for a specific agent from a repository.
 *
 * Scans the `.paperclip-worktrees` directory next to `repoCwd` and removes
 * any worktree whose directory name starts with the agent's slug.
 */
export async function cleanupAgentWorktrees(opts: {
  repoCwd: string;
  agentName: string;
  onLog: (stream: "stdout" | "stderr", msg: string) => Promise<void>;
}): Promise<number> {
  const { repoCwd, agentName, onLog } = opts;
  const slug = agentSlug(agentName);
  const worktreesDir = path.join(path.dirname(repoCwd), ".paperclip-worktrees");

  let entries: string[];
  try {
    entries = await fs.readdir(worktreesDir);
  } catch {
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.startsWith(slug)) continue;
    const wtPath = path.join(worktreesDir, entry);
    try {
      await removeGitWorktree({ repoCwd, worktreePath: wtPath, onLog });
      removed++;
    } catch {
      // Non-fatal; worktree may already be gone
    }
  }

  await pruneGitWorktrees(repoCwd);
  return removed;
}
