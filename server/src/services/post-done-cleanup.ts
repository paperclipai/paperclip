import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { executionWorkspaces } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

const execFileAsync = promisify(execFile);

// Allowlist of safe characters in branch names. Shell metacharacters are rejected.
const BRANCH_NAME_RE = /^[a-zA-Z0-9/_\-.]+$/;

const DEFAULT_ALLOWED_ROOTS = ["~/Documents/Projects/"];

function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/**
 * Returns true only when `cwd` is an absolute path that, after collapsing any
 * `../` segments, remains under one of the allowed roots. This prevents
 * traversal attacks such as `~/Documents/Projects/../../etc`.
 */
function isUnderAllowedRoot(cwd: string, allowedRoots: string[]): boolean {
  const normalized = path.normalize(cwd);
  const withTrailing = normalized.endsWith(path.sep) ? normalized : normalized + path.sep;

  return allowedRoots.some((root) => {
    const expanded = expandHome(root);
    const normalizedRoot = path.normalize(expanded);
    const rootWithTrailing = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep;
    return withTrailing.startsWith(rootWithTrailing);
  });
}

export interface RunPostDoneCleanupOpts {
  db: Db;
  issueId: string;
  issueIdentifier: string;
  /** Defaults to ["~/Documents/Projects/"]. Must be absolute paths or ~/ prefixes. */
  allowedRoots?: string[];
}

export async function runPostDoneCleanup(opts: RunPostDoneCleanupOpts): Promise<void> {
  const { db, issueId, issueIdentifier } = opts;
  const allowedRoots = opts.allowedRoots ?? DEFAULT_ALLOWED_ROOTS;

  const rows = await db
    .select()
    .from(executionWorkspaces)
    .where(eq(executionWorkspaces.sourceIssueId, issueId))
    .limit(1);

  const workspace = rows[0];
  if (!workspace) return;

  const now = new Date();

  // Gate: only local_fs workspaces get shell-level cleanup.
  if (workspace.providerType !== "local_fs") {
    await db
      .update(executionWorkspaces)
      .set({ status: "closed", closedAt: now, cleanupReason: "non_local_provider_skipped", updatedAt: now })
      .where(eq(executionWorkspaces.id, workspace.id));
    return;
  }

  const cwd = workspace.cwd;

  // Validate cwd before any shell call: must be absolute and under an allowed root.
  if (!cwd || !path.isAbsolute(cwd) || !isUnderAllowedRoot(cwd, allowedRoots)) {
    await db
      .update(executionWorkspaces)
      .set({
        status: "closed",
        closedAt: now,
        cleanupReason: "skipped_cwd_not_allowed",
        metadata: {
          ...(workspace.metadata ?? {}),
          cleanup: { branchDeleted: false, worktreeRemoved: false, skippedReason: "cwd_not_allowed" },
        },
        updatedAt: now,
      })
      .where(eq(executionWorkspaces.id, workspace.id));
    return;
  }

  // Validate branchName regex before any shell call.
  const branchName = workspace.branchName;
  const isBranchValid = typeof branchName === "string" && BRANCH_NAME_RE.test(branchName);

  let mainRepoCwd: string | null = null;
  let worktreeRemoved = false;
  let branchDeleted = false;
  let skippedReason: string | undefined;

  // Discover the main repo's working directory so worktree + branch ops target
  // the correct root, even when running from inside a worktree.
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--git-common-dir"], {});
    const gitCommonDir = stdout.trim();
    // When inside a worktree, git-common-dir returns an absolute path to
    // .git/worktrees/<n>/../.. — i.e., the main repo's .git dir parent.
    // When in the main repo, it returns ".git" (relative).
    if (path.isAbsolute(gitCommonDir)) {
      // strip the trailing .git if present
      mainRepoCwd = gitCommonDir.endsWith(".git") ? path.dirname(gitCommonDir) : path.dirname(path.dirname(gitCommonDir));
    } else {
      mainRepoCwd = cwd;
    }
  } catch {
    logger.warn({ issueIdentifier, cwd }, "post-done-cleanup: failed to discover main repo git dir, skipping git ops");
    skippedReason = "git_common_dir_failed";
  }

  // Remove worktree only for git_worktree strategy.
  if (mainRepoCwd && workspace.strategyType === "git_worktree") {
    try {
      await execFileAsync("git", ["-C", mainRepoCwd, "worktree", "remove", "--force", cwd], {});
      worktreeRemoved = true;
    } catch (err) {
      logger.warn({ issueIdentifier, cwd, err }, "post-done-cleanup: worktree remove failed");
    }
  }

  // Delete branch using -d (safe: refuses if not fully merged, never -D).
  if (isBranchValid && mainRepoCwd) {
    try {
      await execFileAsync("git", ["-C", mainRepoCwd, "branch", "-d", branchName], {});
      branchDeleted = true;
    } catch (err: unknown) {
      const errMsg =
        err instanceof Error
          ? err.message + ((err as NodeJS.ErrnoException & { stderr?: string }).stderr ?? "")
          : String(err);
      if (errMsg.includes("not fully merged")) {
        skippedReason = "branch_not_merged";
      } else {
        logger.warn({ issueIdentifier, branchName, err }, "post-done-cleanup: branch delete failed");
        skippedReason = skippedReason ?? "branch_delete_failed";
      }
    }
  } else if (!isBranchValid && branchName !== null && branchName !== undefined) {
    logger.warn({ issueIdentifier, branchName }, "post-done-cleanup: branch name failed regex, skipping delete");
    skippedReason = skippedReason ?? "branch_name_invalid";
  }

  await db
    .update(executionWorkspaces)
    .set({
      status: "closed",
      closedAt: now,
      cleanupReason: skippedReason ?? "cleanup_completed",
      metadata: {
        ...(workspace.metadata ?? {}),
        cleanup: { branchDeleted, worktreeRemoved, skippedReason: skippedReason ?? null },
      },
      updatedAt: now,
    })
    .where(eq(executionWorkspaces.id, workspace.id));
}
