import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type EnsureLocalWorkspaceGitRepoStatus =
  | "already_repo"
  | "initialized"
  | "skipped_missing"
  | "failed";

export interface EnsureLocalWorkspaceGitRepoResult {
  status: EnsureLocalWorkspaceGitRepoStatus;
  detail?: string;
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Make a local onboarding workspace runnable by local adapters.
 *
 * Local CLI adapters (notably `codex_local`) refuse to run with
 * "Not inside a trusted directory and --skip-git-repo-check was not specified"
 * when their working directory is not a git work tree. Greenfield/empty-folder
 * onboarding produces exactly such a directory, which blocks the very first
 * starter audit from launching. Rather than bypass the adapter's trust check,
 * we make the chosen workspace a real git repository — which is what a
 * Paperclip project workspace should be anyway, since agents commit work there.
 *
 * Best-effort and non-fatal by contract: it never throws, only initializes a
 * directory that exists and is not already inside a git work tree (so a
 * subdirectory of an existing repo is left alone, never nested), and reports
 * the outcome so the caller can log it.
 */
export async function ensureLocalWorkspaceGitRepo(
  cwd: string | null | undefined,
): Promise<EnsureLocalWorkspaceGitRepoResult> {
  const target = typeof cwd === "string" ? cwd.trim() : "";
  if (!target) return { status: "skipped_missing" };
  if (!(await pathExists(target))) return { status: "skipped_missing" };

  try {
    const inside = (
      await execFileAsync("git", ["-C", target, "rev-parse", "--is-inside-work-tree"])
    ).stdout.trim();
    if (inside === "true") return { status: "already_repo" };
  } catch {
    // Not a git work tree (or git unavailable) — fall through to init below.
  }

  try {
    await execFileAsync("git", ["-C", target, "init"]);
    return { status: "initialized" };
  } catch (error) {
    return {
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
