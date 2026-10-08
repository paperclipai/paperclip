import fs from "node:fs/promises";
import path from "node:path";

/**
 * Why a workspace cwd cannot serve a run that requires git.
 *
 * These three causes used to share a single message — "has no .git metadata" —
 * which described only the third one. An unplugged external disk and a folder
 * that was never created both reported a repository problem, and the reader
 * went looking for a broken checkout that did not exist (LUN-7697).
 *
 * Kept in its own module, with no server dependencies, so the operational
 * integrity check and the pre-launch guard classify a path the same way rather
 * than drifting into two opinions.
 */
export type WorkspaceGitReadiness =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "workspace_volume_not_mounted"
        | "missing_workspace_path"
        | "missing_git_metadata";
      /** Sentence fragment completing `… "<cwd>" <detail>.` */
      detail: string;
    };

const EXTERNAL_VOLUME_PREFIX = `${path.sep}Volumes${path.sep}`;

function readNonEmptyString(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

/** True when `<cwd>/.git` exists, as a directory (checkout) or file (worktree). */
export async function hasGitMetadata(cwd: string | null | undefined) {
  const normalized = readNonEmptyString(cwd);
  if (!normalized) return false;
  return fs
    .lstat(path.resolve(normalized, ".git"))
    .then((entry) => entry.isDirectory() || entry.isFile())
    .catch(() => false);
}

/**
 * The mount point a path lives under, when that path is on an external volume.
 * macOS mounts removable disks at `/Volumes/<name>`; once the disk is ejected
 * the whole subtree reads as ENOENT, which is indistinguishable from a deleted
 * directory unless the mount point itself is inspected.
 */
export function externalVolumeMountPointFor(candidate: string): string | null {
  if (!candidate.startsWith(EXTERNAL_VOLUME_PREFIX)) return null;
  const [volumeName] = candidate
    .slice(EXTERNAL_VOLUME_PREFIX.length)
    .split(path.sep);
  if (!volumeName) return null;
  return `${EXTERNAL_VOLUME_PREFIX}${volumeName}`;
}

/**
 * Every path a workspace cwd stands for, following symlinks by hand.
 *
 * `realpath` is useless here: the interesting case is a link whose *target* is
 * gone, and `realpath` throws on exactly that. A checkout reached through
 * `~/dev/<repo> -> /Volumes/<disk>/dev/<repo>` only names the disk in its
 * target, so the chain is what gets classified, not the entry point.
 */
export async function collectWorkspacePathChain(
  cwd: string,
  maxHops = 8,
): Promise<string[]> {
  const chain: string[] = [];
  let current = path.resolve(cwd);
  for (let hop = 0; hop <= maxHops; hop += 1) {
    chain.push(current);
    let link: string;
    try {
      const entry = await fs.lstat(current);
      if (!entry.isSymbolicLink()) break;
      link = await fs.readlink(current);
    } catch {
      break;
    }
    const next = path.resolve(path.dirname(current), link);
    if (chain.includes(next)) break;
    current = next;
  }
  return chain;
}

/** Classify a cwd against the three causes in {@link WorkspaceGitReadiness}. */
export async function inspectWorkspaceGitReadiness(
  cwd: string,
): Promise<WorkspaceGitReadiness> {
  if (await hasGitMetadata(cwd)) return { ok: true };
  for (const candidate of await collectWorkspacePathChain(cwd)) {
    const mountPoint = externalVolumeMountPointFor(candidate);
    if (!mountPoint) continue;
    const mounted = await fs
      .stat(mountPoint)
      .then((stats) => stats.isDirectory())
      .catch(() => false);
    if (!mounted) {
      return {
        ok: false,
        reason: "workspace_volume_not_mounted",
        detail: `is on external volume "${mountPoint}", which is not mounted`,
      };
    }
  }
  const exists = await fs
    .stat(path.resolve(cwd))
    .then((stats) => stats.isDirectory())
    .catch(() => false);
  if (!exists) {
    return {
      ok: false,
      reason: "missing_workspace_path",
      detail: "does not exist",
    };
  }
  return {
    ok: false,
    reason: "missing_git_metadata",
    detail: "has no .git metadata",
  };
}
