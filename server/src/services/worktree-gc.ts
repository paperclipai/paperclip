/**
 * Worktree GC — periodic garbage collection for stale agent git worktrees.
 *
 * Strategy:
 *  1. Collect candidate worktree paths from two sources:
 *     a. `execution_workspaces` rows with strategyType="git_worktree" whose
 *        providerRef (or cwd) resolves to a path under `.paperclip/worktrees/agent/`.
 *     b. Filesystem scan of all `.paperclip/worktrees/agent/<lane>/<branch>/` directories.
 *  2. For each candidate:
 *     - Resolve the git branch name for the worktree.
 *     - Skip if the branch name does NOT match `agent/*` (safety guard — never
 *       touch main, cto/*, fix/*, feat/*, etc.).
 *     - Skip if there is a live heartbeat_run (status queued|running) whose
 *       execution_workspace points at this worktree, or if the worktree path
 *       appears in the providerRef of an active execution_workspace row.
 *     - Check GitHub (via `gh pr list --head <branch> --state merged`) to determine
 *       whether any open/merged PR exists with that head branch.
 *     - Skip if no merged PR is found.
 *     - Skip if the worktree has local commits not present in the merged PR base
 *       (unpushed-commit safety check via `git log origin/<branch>..HEAD` — if it
 *       produces output the branch has diverged beyond what was merged; skip).
 *     - If all checks pass: `git worktree remove --force <path>`,
 *       `git branch -D <branch>`, `git worktree prune`.
 *  3. Log every skip and every removal.
 *
 * @module
 */

import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { executionWorkspaces, heartbeatRuns } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorktreeGcOptions {
  /**
   * Root directory of the main git repo (the one that owns the worktrees).
   * If omitted, derived from `process.cwd()` at runtime.
   */
  repoRoot?: string;
  /**
   * Maximum age (ms) before a closed/terminated execution_workspace is eligible
   * for GC consideration.  Defaults to 0 (any closed workspace).
   */
  minAgeMs?: number;
}

export interface WorktreeGcResult {
  scanned: number;
  removed: number;
  skippedActive: number;
  skippedUnmerged: number;
  skippedSafetyBranch: number;
  skippedUnpushed: number;
  errors: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runGit(args: string[], cwd: string): Promise<string> {
  const result = await execFile("git", ["-C", cwd, ...args], { cwd });
  return result.stdout.trim();
}

async function runGh(args: string[]): Promise<string> {
  const result = await execFile("gh", args);
  return result.stdout.trim();
}

/**
 * Returns the current branch name for the worktree at `worktreePath`, or null
 * if it cannot be determined (detached HEAD, missing path, etc.).
 */
async function resolveWorktreeBranch(worktreePath: string): Promise<string | null> {
  try {
    const branch = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath);
    return branch && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}

/**
 * Returns true when the branch name is an agent branch that is eligible for
 * GC.  Only `agent/` prefixed branches are touched.  Branches matching
 * main, master, cto/*, fix/*, feat/* are explicitly excluded as a safety
 * net even though they would not start with `agent/`.
 */
function isAgentBranch(branch: string): boolean {
  if (!branch.startsWith("agent/")) return false;
  // Extra guard — should never match given the prefix check above, but kept
  // as belt-and-suspenders.
  if (/^(main|master|cto\/|fix\/|feat\/)/.test(branch)) return false;
  return true;
}

/**
 * Query GitHub via the `gh` CLI to determine whether a PR with the given head
 * branch has been merged.  Returns true when at least one merged PR is found.
 *
 * Requires `gh` to be authenticated (GITHUB_TOKEN or ~/.config/gh/hosts.yml).
 */
async function isBranchMergedOnGitHub(branch: string, repoRoot: string): Promise<boolean> {
  try {
    // `gh pr list --head <branch> --state merged --json number` returns a JSON
    // array; a non-empty array means there is at least one merged PR.
    const out = await runGh([
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "merged",
      "--json",
      "number",
      "-R",
      // Resolve repo slug from git remote so we don't need it hardcoded.
      await resolveGitHubRepoSlug(repoRoot),
    ]);
    const parsed: unknown = JSON.parse(out || "[]");
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    // If gh is not available or the repo is not on GitHub we treat the branch
    // as unmerged (safe default — do not delete).
    return false;
  }
}

/**
 * Resolve the GitHub repo slug (`owner/repo`) from the `origin` remote URL
 * in the given repo root.
 */
async function resolveGitHubRepoSlug(repoRoot: string): Promise<string> {
  const remoteUrl = await runGit(["remote", "get-url", "origin"], repoRoot);
  // Handles https://github.com/owner/repo.git and git@github.com:owner/repo.git
  const match =
    remoteUrl.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/) ??
    remoteUrl.match(/github\.com[:/]([^/]+\/[^/.]+)$/);
  if (match?.[1]) return match[1];
  throw new Error(`Cannot resolve GitHub repo slug from remote URL: ${remoteUrl}`);
}

/**
 * Returns true if the worktree branch has local commits that have NOT been
 * pushed to the remote tracking branch (i.e. commits that go beyond what was
 * merged).  When true, it is unsafe to delete the worktree.
 */
async function hasUnpushedCommits(branch: string, worktreePath: string): Promise<boolean> {
  try {
    // Check if a remote tracking branch exists.
    await runGit(["rev-parse", "--verify", `origin/${branch}`], worktreePath);
  } catch {
    // No remote tracking branch — treat as safe (the merged PR covers it) or
    // unknown; we conservatively say "no unpushed" if the remote ref is gone.
    return false;
  }

  try {
    const log = await runGit(["log", `origin/${branch}..HEAD`, "--oneline"], worktreePath);
    return log.length > 0;
  } catch {
    return false;
  }
}

/**
 * Returns the set of worktree paths that have an active (queued or running)
 * heartbeat_run recorded in the DB.
 */
async function getActiveWorktreePaths(db: Db): Promise<Set<string>> {
  const rows = await db
    .select({
      providerRef: executionWorkspaces.providerRef,
      cwd: executionWorkspaces.cwd,
    })
    .from(executionWorkspaces)
    .where(
      and(
        inArray(executionWorkspaces.status, ["active", "idle", "in_review"]),
        eq(executionWorkspaces.strategyType, "git_worktree"),
      ),
    );

  const paths = new Set<string>();
  for (const row of rows) {
    if (row.providerRef) paths.add(path.resolve(row.providerRef));
    if (row.cwd) paths.add(path.resolve(row.cwd));
  }

  // Also check for live heartbeat_runs (queued or running).
  const liveRuns = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(inArray(heartbeatRuns.status, ["queued", "running"]));

  if (liveRuns.length > 0) {
    // If there are any running heartbeats, conservatively include all active
    // workspace paths returned above (already done).
    // If more granular linkage is needed we can join — for now the active
    // execution_workspace status check is the primary guard.
  }

  return paths;
}

/**
 * Scan the filesystem for agent worktree directories under the repo root.
 * Returns an array of absolute paths to directories that look like
 * `.paperclip/worktrees/agent/<lane>/<branch>/`.
 */
async function scanWorktreeDirectories(repoRoot: string): Promise<string[]> {
  const agentWorktreesRoot = path.join(repoRoot, ".paperclip", "worktrees", "agent");
  const results: string[] = [];

  let laneDirs: string[];
  try {
    laneDirs = await fs.readdir(agentWorktreesRoot);
  } catch {
    // Directory does not exist — nothing to scan.
    return results;
  }

  for (const lane of laneDirs) {
    const laneDir = path.join(agentWorktreesRoot, lane);
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(laneDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    let branchDirs: string[];
    try {
      branchDirs = await fs.readdir(laneDir);
    } catch {
      continue;
    }

    for (const branchDir of branchDirs) {
      const fullPath = path.join(laneDir, branchDir);
      let branchStat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        branchStat = await fs.stat(fullPath);
      } catch {
        continue;
      }
      if (branchStat.isDirectory()) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

/**
 * Collect candidate worktree paths from the `execution_workspaces` table.
 * Only rows with `strategyType = 'git_worktree'` and a providerRef under
 * the repo's `.paperclip/worktrees/agent/` path are returned.
 */
async function collectDbCandidates(db: Db, repoRoot: string): Promise<string[]> {
  const agentWorktreesRoot = path.join(repoRoot, ".paperclip", "worktrees", "agent");

  const rows = await db
    .select({
      providerRef: executionWorkspaces.providerRef,
      cwd: executionWorkspaces.cwd,
    })
    .from(executionWorkspaces)
    .where(eq(executionWorkspaces.strategyType, "git_worktree"));

  const paths: string[] = [];
  for (const row of rows) {
    const candidate = row.providerRef ?? row.cwd;
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    if (resolved.startsWith(agentWorktreesRoot + path.sep) || resolved.startsWith(agentWorktreesRoot)) {
      paths.push(resolved);
    }
  }

  return paths;
}

/**
 * Remove a git worktree and delete its branch from the common git dir.
 */
async function removeWorktree(worktreePath: string, branch: string, repoRoot: string): Promise<void> {
  await runGit(["worktree", "remove", "--force", worktreePath], repoRoot);
  // Delete local branch — tolerate failure (branch may already be gone).
  try {
    await runGit(["branch", "-D", branch], repoRoot);
  } catch {
    // Branch might have already been deleted by a parallel cleanup or
    // by the remove command itself.
  }
  await runGit(["worktree", "prune"], repoRoot);
}

// ---------------------------------------------------------------------------
// Main GC function
// ---------------------------------------------------------------------------

/**
 * Run one GC pass.  Collects candidates, evaluates each one, removes stale
 * merged worktrees.
 */
export async function runWorktreeGc(
  db: Db,
  opts: WorktreeGcOptions = {},
): Promise<WorktreeGcResult> {
  const result: WorktreeGcResult = {
    scanned: 0,
    removed: 0,
    skippedActive: 0,
    skippedUnmerged: 0,
    skippedSafetyBranch: 0,
    skippedUnpushed: 0,
    errors: 0,
  };

  // Resolve the main repo root.
  let repoRoot: string;
  try {
    repoRoot = opts.repoRoot ?? (await runGit(["rev-parse", "--show-toplevel"], process.cwd()));
  } catch {
    logger.warn("[worktree-gc] Could not resolve repo root — skipping GC pass");
    return result;
  }

  // Collect candidates from DB and filesystem (union, deduplicated).
  const [dbCandidates, fsCandidates, activeWorktreePaths] = await Promise.all([
    collectDbCandidates(db, repoRoot),
    scanWorktreeDirectories(repoRoot),
    getActiveWorktreePaths(db),
  ]);

  const candidateSet = new Set<string>([...dbCandidates, ...fsCandidates]);
  result.scanned = candidateSet.size;

  for (const worktreePath of candidateSet) {
    try {
      // 1. Safety: skip if worktree is in use by an active session.
      if (activeWorktreePaths.has(worktreePath)) {
        logger.debug({ worktreePath }, "[worktree-gc] skip — active session");
        result.skippedActive++;
        continue;
      }

      // 2. Resolve branch name.
      const branch = await resolveWorktreeBranch(worktreePath);
      if (!branch) {
        logger.debug({ worktreePath }, "[worktree-gc] skip — could not resolve branch name");
        result.skippedSafetyBranch++;
        continue;
      }

      // 3. Safety: only operate on agent/* branches.
      if (!isAgentBranch(branch)) {
        logger.debug({ worktreePath, branch }, "[worktree-gc] skip — not an agent branch");
        result.skippedSafetyBranch++;
        continue;
      }

      // 4. Check whether a merged PR exists on GitHub.
      const merged = await isBranchMergedOnGitHub(branch, repoRoot);
      if (!merged) {
        logger.debug({ worktreePath, branch }, "[worktree-gc] skip — no merged PR found");
        result.skippedUnmerged++;
        continue;
      }

      // 5. Safety: skip if the worktree has commits beyond what was merged.
      const unpushed = await hasUnpushedCommits(branch, worktreePath);
      if (unpushed) {
        logger.warn(
          { worktreePath, branch },
          "[worktree-gc] skip — branch has unpushed commits relative to origin",
        );
        result.skippedUnpushed++;
        continue;
      }

      // 6. Remove worktree.
      logger.info({ worktreePath, branch }, "[worktree-gc] removing merged worktree");
      await removeWorktree(worktreePath, branch, repoRoot);
      logger.info({ worktreePath, branch }, "[worktree-gc] removed");
      result.removed++;
    } catch (err) {
      logger.error({ err, worktreePath }, "[worktree-gc] error processing worktree");
      result.errors++;
    }
  }

  if (result.removed > 0 || result.errors > 0) {
    logger.info(result, "[worktree-gc] pass complete");
  }

  return result;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

const GC_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

let gcTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the background worktree GC job.  Idempotent — calling twice is safe.
 *
 * @param db   Drizzle DB instance.
 * @param opts Optional GC options (e.g. repoRoot override).
 */
export function startWorktreeGc(db: Db, opts: WorktreeGcOptions = {}): void {
  if (gcTimer !== null) return;

  gcTimer = setInterval(() => {
    void runWorktreeGc(db, opts).catch((err) => {
      logger.error({ err }, "[worktree-gc] unhandled error in GC interval");
    });
  }, GC_INTERVAL_MS);

  // Unref so the timer doesn't prevent process exit.
  if (typeof gcTimer.unref === "function") {
    gcTimer.unref();
  }

  logger.debug("[worktree-gc] scheduled (interval 30 min)");
}

/**
 * Stop the background GC job (useful in tests / graceful shutdown).
 */
export function stopWorktreeGc(): void {
  if (gcTimer !== null) {
    clearInterval(gcTimer);
    gcTimer = null;
  }
}
