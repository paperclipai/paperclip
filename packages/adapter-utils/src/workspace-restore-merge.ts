import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { shouldExcludePath } from "./exclude-patterns.js";
import { resolvePaperclipInstanceRootForAdapter } from "./server-utils.js";

type SnapshotEntry =
  | { kind: "dir" }
  | { kind: "file"; mode: number; hash: string }
  | { kind: "symlink"; target: string };

export interface DirectorySnapshot {
  exclude: string[];
  entries: Map<string, SnapshotEntry>;
}

async function hashFile(filePath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function walkDirectory(
  root: string,
  exclude: readonly string[],
  relative = "",
  out: Map<string, SnapshotEntry> = new Map(),
): Promise<Map<string, SnapshotEntry>> {
  const current = relative ? path.join(root, relative) : root;
  const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const nextRelative = relative ? path.posix.join(relative, entry.name) : entry.name;
    if (shouldExcludePath(nextRelative, exclude)) continue;

    const fullPath = path.join(root, nextRelative);
    const stats = await fs.lstat(fullPath);
    if (!stats.isDirectory() && !stats.isSymbolicLink() && !stats.isFile()) {
      continue;
    }

    if (stats.isDirectory()) {
      out.set(nextRelative, { kind: "dir" });
      await walkDirectory(root, exclude, nextRelative, out);
      continue;
    }

    if (stats.isSymbolicLink()) {
      out.set(nextRelative, {
        kind: "symlink",
        target: await fs.readlink(fullPath),
      });
      continue;
    }

    out.set(nextRelative, {
      kind: "file",
      mode: stats.mode,
      hash: await hashFile(fullPath),
    });
  }

  return out;
}

async function readSnapshotEntry(root: string, relative: string): Promise<SnapshotEntry | null> {
  const fullPath = path.join(root, relative);
  let stats;
  try {
    stats = await fs.lstat(fullPath);
  } catch {
    return null;
  }

  if (stats.isDirectory()) return { kind: "dir" };
  if (stats.isSymbolicLink()) {
    return {
      kind: "symlink",
      target: await fs.readlink(fullPath),
    };
  }
  if (!stats.isFile()) return null;

  return {
    kind: "file",
    mode: stats.mode,
    hash: await hashFile(fullPath),
  };
}

function entriesMatch(left: SnapshotEntry | null | undefined, right: SnapshotEntry | null | undefined): boolean {
  if (!left || !right) return false;
  if (left.kind !== right.kind) return false;
  if (left.kind === "dir") return true;
  if (left.kind === "symlink" && right.kind === "symlink") {
    return left.target === right.target;
  }
  if (left.kind === "file" && right.kind === "file") {
    return left.mode === right.mode && left.hash === right.hash;
  }
  return false;
}

const LOCK_STALE_MS = 30_000;

/**
 * The stable `code` a lock-timeout error carries, so a caller can identify it
 * without matching on the error message text (the message embeds the lock
 * directory path).
 */
export const WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE = "ERR_WORKSPACE_RESTORE_LOCK_TIMEOUT";

/**
 * The closed set of codes a failed workspace restore can carry off the
 * sandbox. Every code is safe to store on a run record readable by any
 * same-company actor: none embeds a filesystem path, a raw error message, or
 * a process id.
 */
export type WorkspaceRestoreFailureCode =
  | "restore_permission_denied"
  | "restore_lock_timeout"
  | "restore_failed";

/**
 * The outcome of one workspace restore. `ok: true` on a clean restore. `ok:
 * false` carries one allowlisted {@link WorkspaceRestoreFailureCode} — never a
 * raw error, a path, or a process id.
 */
export type WorkspaceRestoreOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: WorkspaceRestoreFailureCode };

/**
 * Classifies a caught workspace-restore error into one allowlisted code. Maps
 * `EACCES` and `EPERM` to a permission failure, the merge-lock timeout
 * (matched by {@link WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE}, never by the error
 * message text) to a lock-timeout failure, and every other error to a generic
 * failure. Never reads or returns `Error.message`, a filesystem path, or a
 * process id.
 */
export function classifyWorkspaceRestoreFailure(error: unknown): WorkspaceRestoreFailureCode {
  const code = error && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined;
  if (code === "EACCES" || code === "EPERM") return "restore_permission_denied";
  if (code === WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE) return "restore_lock_timeout";
  return "restore_failed";
}

/**
 * The fixed, allowlisted line an ACP adapter writes to the run log when a
 * workspace restore fails. Every call site must pass this to `onLog` instead
 * of the caught error's own message: the caught error can carry a host
 * filesystem path or the lock owner's process id, and the run log is
 * readable by any same-company actor. Never add the code's raw
 * `Error.message` to this text.
 */
export function describeWorkspaceRestoreFailure(code: WorkspaceRestoreFailureCode): string {
  switch (code) {
    case "restore_permission_denied":
      return "the restore could not write to the workspace (permission denied)";
    case "restore_lock_timeout":
      return "the restore timed out waiting for the workspace merge lock";
    case "restore_failed":
      return "the restore failed";
  }
}

async function isLockStale(lockDir: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(path.join(lockDir, "owner.json"), "utf8");
    const owner = JSON.parse(raw) as { pid?: unknown };
    const pid = typeof owner.pid === "number" && Number.isFinite(owner.pid) && owner.pid > 0 ? owner.pid : null;
    if (pid === null) {
      // Owner record is unparseable / missing pid — treat as stale.
      return true;
    }
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  } catch {
    // owner.json is missing or unreadable. A live holder also passes through
    // this exact state, briefly, between its own `fs.mkdir(lockDir)` and its
    // `fs.writeFile(owner.json)` below. Reading "missing" as "stale" here would
    // let a concurrent acquirer delete a live holder's lock directory during
    // that window. Mirror the materializePaperclipSkillCopy lock pattern: fall
    // back to the lock directory's own mtime, and only call it stale once the
    // directory itself has outlived the stale threshold.
    const stat = await fs.stat(lockDir).catch(() => null);
    return !stat || Date.now() - stat.mtimeMs > LOCK_STALE_MS;
  }
}

async function acquireDirectoryMergeLock(lockDir: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + LOCK_STALE_MS;
  while (true) {
    try {
      await fs.mkdir(lockDir);
      await fs.writeFile(
        path.join(lockDir, "owner.json"),
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
        "utf8",
      );
      return async () => {
        await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
      };
    } catch (error) {
      const code = error && typeof error === "object" ? (error as { code?: unknown }).code : null;
      if (code !== "EEXIST") throw error;
      // Stale-lock detection: if the owner PID is dead (SIGKILL / OOM / crash),
      // the lockDir would otherwise persist forever and stall restores. Mirror
      // the materializePaperclipSkillCopy lock pattern — remove and retry.
      if (await isLockStale(lockDir)) {
        await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) {
        const timeoutError: NodeJS.ErrnoException = new Error(
          `Timed out waiting for workspace restore lock at ${lockDir}`,
        );
        timeoutError.code = WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE;
        throw timeoutError;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

const DIRECTORY_MERGE_LOCK_ROOT_MODE = 0o700;

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Resolves the private, instance-scoped root for every directory-merge lock:
 * `<instance root>/locks/directory-merge`. Every process that can mutate one
 * target directory must resolve to the same `PAPERCLIP_HOME` and
 * `PAPERCLIP_INSTANCE_ID`. That shared resolution is what keeps mutual
 * exclusion true for all five callers of `withDirectoryMergeLock`, including
 * the three Codex credential call sites that never touch a workspace.
 *
 * This never falls back to `os.tmpdir()` and never places the lock beside the
 * target directory: both paths funnel through this one instance-scoped root,
 * so a read-only target parent (the workspace-restore bug) cannot block a
 * lock acquisition.
 *
 * The root reads `PAPERCLIP_HOME` and `PAPERCLIP_INSTANCE_ID` from `env`, so an
 * environment-parameterized caller (a Codex credential call site that builds
 * its own `env` object instead of reading `process.env`) resolves its lock
 * root under the same instance root as the directory it protects. This never
 * reads `process.env` when the caller passes an `env`: every fallback inside
 * the resolver also reads from that same `env` object. A caller that omits
 * `env` gets `process.env`, which keeps the resolution unchanged for the
 * workspace-restore call site.
 *
 * The root is validated, not trusted: `lstat` rejects a symlink and rejects
 * any non-directory before use (fail closed). `fs.mkdir` does not change the
 * mode of a directory that already exists, so an existing valid directory
 * keeps whatever mode it already has; only a freshly created root gets mode
 * `0o700`.
 *
 * The existence check and the `mkdir` below are two separate calls, so a
 * racing writer can plant a symlink at `lockRoot` in between them. `fs.mkdir`
 * with `recursive: true` does not fail on a leaf that already exists as a
 * symlink to a real directory, so a successful `mkdir` call alone does not
 * prove the path is a plain directory. The `lstat` after `mkdir` closes that
 * window: it validates what is actually at `lockRoot` (never a `stat`, which
 * would follow the symlink) before any caller treats it as the lock root.
 */
async function resolveDirectoryMergeLockRoot(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  const lockRoot = path.join(instanceRoot, "locks", "directory-merge");
  const existing = await fs.lstat(lockRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error(`Directory merge lock root at ${lockRoot} is not a plain directory.`);
    }
    return lockRoot;
  }
  await fs.mkdir(lockRoot, { recursive: true, mode: DIRECTORY_MERGE_LOCK_ROOT_MODE });
  const created = await fs.lstat(lockRoot);
  if (created.isSymbolicLink() || !created.isDirectory()) {
    throw new Error(`Directory merge lock root at ${lockRoot} is not a plain directory.`);
  }
  return lockRoot;
}

export async function withDirectoryMergeLock<T>(
  targetDir: string,
  fn: (canonicalTargetDir: string) => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  // Canonicalize before we hash or lock: a retargeted symlink must not let the
  // lock protect one directory while the caller mutates another.
  const canonicalTargetDir = await fs.realpath(targetDir);
  const lockRoot = await resolveDirectoryMergeLockRoot(env);
  const lockKey = createHash("sha256").update(canonicalTargetDir).digest("hex");
  const releaseLock = await acquireDirectoryMergeLock(path.join(lockRoot, `${lockKey}.lock`));
  try {
    return await fn(canonicalTargetDir);
  } finally {
    await releaseLock();
  }
}

async function copySnapshotEntry(sourceDir: string, targetDir: string, relative: string, entry: SnapshotEntry): Promise<void> {
  const sourcePath = path.join(sourceDir, relative);
  const targetPath = path.join(targetDir, relative);

  if (entry.kind === "dir") {
    const existing = await fs.lstat(targetPath).catch(() => null);
    if (existing?.isDirectory()) {
      return;
    }
    if (existing) {
      await fs.rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
    }
    await fs.mkdir(targetPath, { recursive: true });
    return;
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
  if (entry.kind === "symlink") {
    await fs.symlink(entry.target, targetPath);
    return;
  }

  await fs.copyFile(sourcePath, targetPath, fsConstants.COPYFILE_FICLONE).catch(async () => {
    await fs.copyFile(sourcePath, targetPath);
  });
  await fs.chmod(targetPath, entry.mode);
}

export async function captureDirectorySnapshot(
  rootDir: string,
  options: { exclude?: string[] } = {},
): Promise<DirectorySnapshot> {
  const exclude = [...new Set(options.exclude ?? [])];
  return {
    exclude,
    entries: await walkDirectory(rootDir, exclude),
  };
}

export async function mergeDirectoryWithBaseline(input: {
  baseline: DirectorySnapshot;
  sourceDir: string;
  targetDir: string;
  beforeApply?: () => Promise<void>;
  afterApply?: () => Promise<void>;
}): Promise<void> {
  const source = await captureDirectorySnapshot(input.sourceDir, { exclude: input.baseline.exclude });
  await withDirectoryMergeLock(input.targetDir, async (canonicalTargetDir) => {
    await input.beforeApply?.();
    const current = await captureDirectorySnapshot(canonicalTargetDir, { exclude: input.baseline.exclude });
    const deletedLeafEntries = [...input.baseline.entries.entries()]
      .filter(([relative, entry]) => entry.kind !== "dir" && !source.entries.has(relative))
      .sort(([left], [right]) => right.length - left.length);

    for (const [relative, baselineEntry] of deletedLeafEntries) {
      if (!entriesMatch(current.entries.get(relative), baselineEntry)) continue;
      await fs.rm(path.join(canonicalTargetDir, relative), { recursive: true, force: true }).catch(() => undefined);
    }

    const deletedDirs = [...input.baseline.entries.entries()]
      .filter(([relative, entry]) => entry.kind === "dir" && !source.entries.has(relative))
      .sort(([left], [right]) => right.length - left.length);

    for (const [relative] of deletedDirs) {
      await fs.rmdir(path.join(canonicalTargetDir, relative)).catch(() => undefined);
    }

    const changedSourceEntries = [...source.entries.entries()]
      .filter(([relative, entry]) => !entriesMatch(input.baseline.entries.get(relative), entry))
      .sort(([left], [right]) => left.localeCompare(right));

    for (const [relative, entry] of changedSourceEntries) {
      await copySnapshotEntry(input.sourceDir, canonicalTargetDir, relative, entry);
    }

    await input.afterApply?.();
  });
}

export async function directoryEntryMatchesBaseline(
  rootDir: string,
  relative: string,
  baselineEntry: SnapshotEntry,
): Promise<boolean> {
  return entriesMatch(await readSnapshotEntry(rootDir, relative), baselineEntry);
}
