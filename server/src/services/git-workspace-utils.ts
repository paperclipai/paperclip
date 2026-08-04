import fs from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** True when `cwd/.git` exists as either a directory (normal checkout) or a file (worktree/submodule gitlink). */
export async function hasGitMetadata(cwd: string | null | undefined): Promise<boolean> {
  const normalized = readNonEmptyString(cwd);
  if (!normalized) return false;
  return fs
    .lstat(path.resolve(normalized, ".git"))
    .then((entry) => entry.isDirectory() || entry.isFile())
    .catch(() => false);
}

export type EnsureLocalPathGitWorkspaceResult =
  | { outcome: "already_initialized"; safeDirectoryWarning?: string }
  | { outcome: "initialized"; safeDirectoryWarning?: string }
  | { outcome: "failed"; error: string };

/**
 * Best-effort `git init` for a `local_path` project workspace directory, plus registering the
 * resolved path as a git `safe.directory` for this process's user. Project folders are often
 * owned by the interactive Windows user rather than the service account, so without
 * `safe.directory` git refuses to operate on them with a "dubious ownership" error even after
 * `git init` succeeds.
 *
 * Never throws: callers that must not block on filesystem/permission failures (e.g. workspace
 * creation) can rely on the `"failed"` outcome instead of a try/catch.
 */
export async function ensureLocalPathGitWorkspaceInitialized(
  cwd: string | null | undefined,
): Promise<EnsureLocalPathGitWorkspaceResult> {
  const normalized = readNonEmptyString(cwd);
  if (!normalized) return { outcome: "failed", error: "no cwd provided" };
  const resolved = path.resolve(normalized);

  const alreadyInitialized = await hasGitMetadata(resolved);

  if (!alreadyInitialized) {
    try {
      await execFile("git", ["init"], { cwd: resolved });
    } catch (err) {
      return { outcome: "failed", error: err instanceof Error ? err.message : String(err) };
    }
  }

  // Best-effort: a pre-existing repo owned by another OS user still needs safe.directory
  // registration, so this must run regardless of whether `git init` just ran above. Registration
  // failure should not block workspace creation -- heartbeat's own validation is the safety net --
  // but it must still be surfaced to the caller so it can be logged instead of silently discarded.
  let safeDirectoryWarning: string | undefined;
  try {
    await execFile("git", ["config", "--global", "--add", "safe.directory", resolved]);
  } catch (err) {
    safeDirectoryWarning = err instanceof Error ? err.message : String(err);
  }

  return { outcome: alreadyInitialized ? "already_initialized" : "initialized", safeDirectoryWarning };
}
