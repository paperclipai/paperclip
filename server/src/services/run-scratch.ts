import type { Dirent } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { retainedAiCredentialCleanupHomeInside } from "./retained-ai-credential-cleanup.js";

export const HEARTBEAT_RUN_SCRATCH_MARKER = ".paperclip-run-scratch.json";
export const RUN_TEMP_ROOT_DIRNAME = ".pctmp";
export const RUN_TEMP_SEGMENT_CHARS = 8;

/** Absolute socket paths must stay far below the kernel's 107-byte sun_path limit. */
export const MAX_RUN_TEMP_SOCKET_PATH_BYTES = 107;

export interface HeartbeatRunScratchMetadata {
  version: 1;
  companyId: string;
  agentId: string;
  runId: string;
  issueId: string | null;
  issueIdentifier: string | null;
  createdAt: string;
}

export interface HeartbeatRunScratch {
  dir: string;
  markerPath: string;
  metadata: HeartbeatRunScratchMetadata;
}

export interface HeartbeatRunScratchEnvResult {
  env: Record<string, string>;
  tempKeysApplied: string[];
}

export type HeartbeatRunScratchCleanupResult =
  | { removed: true; dir: string }
  | { removed: false; dir: string; reason: "missing" | "unmarked" | "owner_mismatch" | "process_group_alive" | "ai_home_retained" | "symlink" | "mount_point_present" | "unsafe_tree" };

const TEMP_ENV_KEYS = ["TMPDIR", "TEMP", "TMP"] as const;
const ISSUE_SEGMENT_MAX_CHARS = 32;

function sanitizePathSegment(value: string | null | undefined, fallback: string): string {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, ISSUE_SEGMENT_MAX_CHARS)
    .replace(/[.-]+$/g, "");
  return normalized || fallback;
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Per-run scratch directories live on the instance's home filesystem, outside
 * any tmpfs the OS periodically reclaims, so a live run never loses its
 * PostgreSQL sockets or credential homes to a tmpfiles timer.
 */
export function runTempRoot(): string {
  return path.join(os.homedir(), RUN_TEMP_ROOT_DIRNAME);
}

/** Short, deterministic directory name derived from the run id. */
export function runTempSegment(runId: string): string {
  return sanitizePathSegment(runId.slice(0, RUN_TEMP_SEGMENT_CHARS), "run");
}

export function runTempDirPath(runId: string, root = runTempRoot()): string {
  return path.join(root, runTempSegment(runId));
}

/** The longest Unix-domain socket path a run's scratch directory may produce. */
export function runTempSocketPathBudget(runId: string, root = runTempRoot()): number {
  return Buffer.byteLength(path.join(runTempDirPath(runId, root), "x", ".s.PGSQL.65535"));
}

/**
 * Confine scratch operations to the roots this runner owns: the per-run temp
 * root (any direct child) and, for directories created before the migration,
 * the OS temp root with the historical `paperclip-run-` prefix.
 */
export function classifyRunScratchDir(dir: string, rootOverride?: string): "run_temp" | "tmp" | null {
  const resolved = path.resolve(dir);
  const tempRoot = path.resolve(rootOverride ?? runTempRoot());
  if (path.dirname(resolved) === tempRoot) return "run_temp";
  const tmpRoot = path.resolve(os.tmpdir());
  if (isPathInside(tmpRoot, resolved) && path.basename(resolved).startsWith("paperclip-run-")) return "tmp";
  return null;
}

async function readMarker(markerPath: string): Promise<HeartbeatRunScratchMetadata | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(markerPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const rec = parsed as Record<string, unknown>;
    if (
      rec.version !== 1 ||
      typeof rec.companyId !== "string" ||
      typeof rec.agentId !== "string" ||
      typeof rec.runId !== "string" ||
      typeof rec.createdAt !== "string"
    ) {
      return null;
    }
    return {
      version: 1,
      companyId: rec.companyId,
      agentId: rec.agentId,
      runId: rec.runId,
      issueId: typeof rec.issueId === "string" ? rec.issueId : null,
      issueIdentifier: typeof rec.issueIdentifier === "string" ? rec.issueIdentifier : null,
      createdAt: rec.createdAt,
    };
  } catch {
    return null;
  }
}

export async function prepareHeartbeatRunScratch(input: {
  companyId: string;
  agentId: string;
  runId: string;
  issueId?: string | null;
  issueIdentifier?: string | null;
  now?: Date;
  root?: string;
}): Promise<HeartbeatRunScratch> {
  const root = path.resolve(input.root ?? runTempRoot());
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700).catch(() => undefined);
  const segment = runTempSegment(input.runId);
  let dir = path.join(root, segment);
  try {
    await fs.mkdir(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // The deterministic name is either an earlier attempt of this same run
    // (safe to reuse) or a collision with a different run (fall back to a
    // short unique suffix so both runs keep working).
    const existing = await readMarker(path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER));
    if (!existing || existing.runId !== input.runId || existing.companyId !== input.companyId) {
      dir = await fs.mkdtemp(path.join(root, `${segment}-`));
    }
  }
  await fs.chmod(dir, 0o700).catch(() => undefined);
  const markerPath = path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER);
  const metadata: HeartbeatRunScratchMetadata = {
    version: 1,
    companyId: input.companyId,
    agentId: input.agentId,
    runId: input.runId,
    issueId: input.issueId ?? null,
    issueIdentifier: input.issueIdentifier ?? null,
    createdAt: (input.now ?? new Date()).toISOString(),
  };
  await fs.writeFile(markerPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  return { dir, markerPath, metadata };
}

/**
 * The run scratch directory is the authoritative temp directory for the agent
 * process: TMPDIR, TMP and TEMP always point at it so no CLI falls back to a
 * shared tmpfs location.
 */
export function buildHeartbeatRunScratchEnv(
  scratch: HeartbeatRunScratch,
): HeartbeatRunScratchEnvResult {
  const env: Record<string, string> = {
    PAPERCLIP_RUN_SCRATCH_DIR: scratch.dir,
    PAPERCLIP_TASK_SCRATCH_DIR: scratch.dir,
    PAPERCLIP_SCRATCH_DIR: scratch.dir,
    PAPERCLIP_TMPDIR: scratch.dir,
  };
  const tempKeysApplied: string[] = [];
  for (const key of TEMP_ENV_KEYS) {
    env[key] = scratch.dir;
    tempKeysApplied.push(key);
  }
  return { env, tempKeysApplied };
}

type PathStatLike = {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  dev: number;
  ino: number;
};

interface TreeIdentity {
  dev: number;
  ino: number;
}

function identityOf(stats: { dev: number; ino: number }): TreeIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

/** Anchor for directory-entry operations: resolves inside the fd's directory. */
const PROC_SELF_FD = "/proc/self/fd";

function anchoredDirPath(fd: number): string {
  return `${PROC_SELF_FD}/${fd}`;
}

function anchoredEntryPath(fd: number, name: string): string {
  return `${PROC_SELF_FD}/${fd}/${name}`;
}

/**
 * Operations of the anchored removal walker. Directories are opened once and
 * every entry operation then goes through `/proc/self/fd/<fd>/<name>`
 * (openat-style semantics): the lookup resolves inside the directory the fd
 * refers to, so no path component the walker does not hold open — including
 * the scratch root itself — can be swapped for a symlink to redirect a
 * deletion into a foreign tree. Platforms without `/proc/self/fd` make every
 * walk fail closed (the directory is kept).
 */
export interface RunScratchWalkerOps {
  /** Open a directory; a symlinked final component is refused unless `follow`. */
  openDir(p: string, opts?: { follow?: boolean }): Promise<number>;
  /** Identity of the directory held by `fd`. */
  statDir(fd: number): Promise<TreeIdentity>;
  /** `lstat` a path without following the final component. */
  lstatPath(p: string): Promise<PathStatLike>;
  /** `stat` a path, following symlinks. */
  statPath(p: string): Promise<PathStatLike>;
  /** Entries of the directory held by `fd`. */
  listDir(fd: number): Promise<Dirent[]>;
  unlink(p: string): Promise<void>;
  rmdir(p: string): Promise<void>;
  writeFile(p: string, data: string, options?: { mode?: number }): Promise<void>;
  closeDir(fd: number): Promise<void>;
}

export function createDefaultRunScratchWalkerOps(): RunScratchWalkerOps {
  const handles = new Map<number, FileHandle>();
  return {
    async openDir(p, opts) {
      const handle = await fs.open(
        p,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | (opts?.follow ? 0 : fsConstants.O_NOFOLLOW),
      );
      handles.set(handle.fd, handle);
      return handle.fd;
    },
    async statDir(fd) {
      const handle = handles.get(fd);
      if (!handle) throw new Error(`run scratch walker fd ${fd} is not open`);
      return identityOf(await handle.stat());
    },
    lstatPath: (p) => fs.lstat(p),
    statPath: (p) => fs.stat(p),
    listDir: (fd) => fs.readdir(anchoredDirPath(fd), { withFileTypes: true }),
    unlink: (p) => fs.unlink(p),
    rmdir: (p) => fs.rmdir(p),
    writeFile: (p, data, options) => fs.writeFile(p, data, { mode: options?.mode }),
    async closeDir(fd) {
      const handle = handles.get(fd);
      handles.delete(fd);
      await handle?.close();
    },
  };
}

/**
 * Test overrides either replace operations outright or wrap the same base
 * instance the walker uses, so wrappers observe and delegate with one shared
 * set of open directory handles.
 */
export type RunScratchWalkerOpsOverride =
  | Partial<RunScratchWalkerOps>
  | ((base: RunScratchWalkerOps) => Partial<RunScratchWalkerOps>);

function resolveWalkerOps(overrides?: RunScratchWalkerOpsOverride): RunScratchWalkerOps {
  const base = createDefaultRunScratchWalkerOps();
  const partial = typeof overrides === "function" ? overrides(base) : overrides;
  return { ...base, ...partial };
}

function direntType(entry: Dirent): "dir" | "link" | "other" | "unknown" {
  if (entry.isDirectory()) return "dir";
  if (entry.isSymbolicLink()) return "link";
  if (
    entry.isFile() || entry.isFIFO() || entry.isSocket() ||
    entry.isBlockDevice() || entry.isCharacterDevice()
  ) {
    return "other";
  }
  return "unknown";
}

interface WalkResult {
  complete: boolean;
  /** Some listed name no longer matched what the anchored stat saw. */
  unstable: boolean;
}

async function removeEntriesWithinDevice(
  dirFd: number,
  rootDevice: number,
  ops: RunScratchWalkerOps,
  skipTopNames?: Set<string>,
): Promise<WalkResult> {
  let entries: Dirent[];
  try {
    entries = await ops.listDir(dirFd);
  } catch {
    return { complete: false, unstable: false };
  }
  let complete = true;
  let unstable = false;
  for (const entry of entries) {
    if (skipTopNames?.has(entry.name)) continue;
    const entryPath = anchoredEntryPath(dirFd, entry.name);
    // The anchored lstat resolves the name inside the directory the verified
    // fd holds open: a directory swapped for a symlink anywhere between the
    // root and here cannot redirect this lookup into a foreign tree.
    const stats = await ops.lstatPath(entryPath).catch(() => null);
    if (!stats) continue; // gone since the listing: nothing to remove
    const statIsDirectory = stats.isDirectory() && !stats.isSymbolicLink();
    const listedType = direntType(entry);
    if (listedType !== "unknown" && (listedType === "dir") !== statIsDirectory) {
      // The name changed type since the listing (for example a child
      // directory swapped for a symlink): keep the tree and retry later.
      complete = false;
      unstable = true;
      continue;
    }
    if (!statIsDirectory) {
      // Files and symlinks are unlinked by name through the anchored path.
      // unlink never follows a symlink and the anchored path cannot leave
      // the verified directory: the worst outcome is unlinking a
      // concurrently replaced name inside this same directory.
      await ops.unlink(entryPath).catch(() => {
        complete = false;
      });
      continue;
    }
    // Open the child through the anchored path refusing a symlinked final
    // component: the fd then pins the child inode for the whole descent, so
    // later swaps of any path component cannot redirect the removal below.
    let childFd: number;
    try {
      childFd = await ops.openDir(entryPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue; // vanished since the listing
      // Refused (the name no longer is the listed directory) or anchoring
      // unavailable: keep fail-closed.
      complete = false;
      unstable = true;
      continue;
    }
    try {
      const identity = await ops.statDir(childFd);
      if (identity.dev !== stats.dev || identity.ino !== stats.ino) {
        // The opened directory is not the inode the anchored lstat saw.
        complete = false;
        unstable = true;
        continue;
      }
      if (identity.dev !== rootDevice) {
        // A different device is a mount point: keep it and everything below.
        complete = false;
        continue;
      }
      const child = await removeEntriesWithinDevice(childFd, rootDevice, ops);
      if (!child.complete) {
        complete = false;
        unstable = unstable || child.unstable;
        continue;
      }
      try {
        await ops.rmdir(entryPath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") continue;
        if (code === "ENOTEMPTY") {
          // A concurrent writer refilled the emptied directory.
          complete = false;
          continue;
        }
        // ENOTDIR: the name stopped being the emptied directory.
        complete = false;
        unstable = true;
        continue;
      }
    } finally {
      await ops.closeDir(childFd).catch(() => undefined);
    }
  }
  return { complete, unstable };
}

interface VerifiedDir {
  fd: number;
  identity: TreeIdentity;
}

/**
 * Open `dir` refusing a symlinked final component and prove the fd refers to
 * the inode the pre-flight lstat saw. A missing path throws ENOENT (callers
 * decide whether that means already removed); a swapped or unusable path
 * yields null so the tree is kept.
 */
async function openVerifiedDirectory(
  dir: string,
  ops: RunScratchWalkerOps,
): Promise<VerifiedDir | null> {
  const pre = await ops.lstatPath(dir);
  if (!pre.isDirectory() || pre.isSymbolicLink()) return null;
  let fd: number;
  try {
    fd = await ops.openDir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    return null;
  }
  const identity = await ops.statDir(fd);
  if (identity.dev !== pre.dev || identity.ino !== pre.ino) {
    await ops.closeDir(fd).catch(() => undefined);
    return null;
  }
  return { fd, identity };
}

/**
 * Remove the directory's name from its parent through a parent fd held open
 * (openat semantics): an ancestor swapped for a symlink cannot redirect the
 * rmdir, and the entry is proven to still be the verified directory before
 * the removal.
 */
async function removeDirNameViaParent(
  dir: string,
  expected: TreeIdentity,
  ops: RunScratchWalkerOps,
): Promise<"removed" | "missing" | "kept" | "unstable"> {
  const parent = path.dirname(dir);
  const name = path.basename(dir);
  // The parent itself is opened by path (the run temp root may legitimately
  // live behind a symlinked home); the pre/post identity comparison refuses
  // a parent whose path changed between the stat and the open.
  let parentFd: number;
  let parentPre: PathStatLike;
  try {
    parentPre = await ops.statPath(parent);
    parentFd = await ops.openDir(parent, { follow: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  try {
    const parentIdentity = await ops.statDir(parentFd);
    if (parentIdentity.dev !== parentPre.dev || parentIdentity.ino !== parentPre.ino) {
      return "unstable";
    }
    const entryPath = anchoredEntryPath(parentFd, name);
    const entry = await ops.lstatPath(entryPath).catch(() => null);
    if (!entry) return "missing";
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.dev !== expected.dev || entry.ino !== expected.ino) {
      return "unstable";
    }
    try {
      await ops.rmdir(entryPath);
      return "removed";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return "missing";
      if (code === "ENOTEMPTY") return "kept";
      if (code === "ENOTDIR") return "unstable";
      throw error;
    }
  } finally {
    await ops.closeDir(parentFd).catch(() => undefined);
  }
}

/**
 * Recursively remove a directory tree without following symlinks and without
 * crossing mount points. Every entry operation is anchored to a directory fd
 * held open for the descent, so swapping any path component for a symlink
 * cannot redirect a deletion outside the tree. Returns `complete: false`
 * when something had to be kept (mount point, concurrent writer, unstable
 * tree); the directory itself then remains.
 */
export async function removeRunTempTree(
  dir: string,
  opts?: { walkerOps?: RunScratchWalkerOpsOverride },
): Promise<{ complete: boolean }> {
  const ops = resolveWalkerOps(opts?.walkerOps);
  let verified: VerifiedDir | null = null;
  try {
    verified = await openVerifiedDirectory(dir, ops);
    if (!verified) return { complete: false };
    const walk = await removeEntriesWithinDevice(verified.fd, verified.identity.dev, ops);
    if (!walk.complete) return { complete: false };
    const removed = await removeDirNameViaParent(dir, verified.identity, ops);
    return { complete: removed === "removed" || removed === "missing" };
  } finally {
    if (verified) await ops.closeDir(verified.fd).catch(() => undefined);
  }
}

/**
 * Remove a marked run scratch directory while keeping the ownership marker —
 * and its retry evidence — until every other entry is gone. The whole removal
 * is anchored to directory fds: the marker is unlinked and restored through
 * the verified directory itself, never through a path a swap could redirect,
 * and the final rmdir targets the proven entry inside a parent fd held open.
 * An interrupted removal (mount point, concurrent writer, unstable tree)
 * leaves a still-marked directory a later retry can act on, instead of an
 * unrecoverable unmarked orphan.
 */
async function removeMarkedRunScratchDir(
  dir: string,
  marker: HeartbeatRunScratchMetadata,
  walkerOps?: RunScratchWalkerOpsOverride,
): Promise<{ complete: boolean; cause?: "blocked" | "unstable" }> {
  const ops = resolveWalkerOps(walkerOps);
  let verified: VerifiedDir | null = null;
  try {
    verified = await openVerifiedDirectory(dir, ops);
    if (!verified) return { complete: false, cause: "unstable" };
    const walk = await removeEntriesWithinDevice(
      verified.fd,
      verified.identity.dev,
      ops,
      new Set([HEARTBEAT_RUN_SCRATCH_MARKER]),
    );
    if (!walk.complete) return { complete: false, cause: walk.unstable ? "unstable" : "blocked" };
    // Unlink the marker through the anchored path only once every other
    // entry is gone: it always targets the verified directory itself, never
    // a swapped-in tree, so the retry evidence cannot vanish elsewhere.
    const markerFailed = await ops.unlink(anchoredEntryPath(verified.fd, HEARTBEAT_RUN_SCRATCH_MARKER)).then(
      () => false,
      (error: NodeJS.ErrnoException) => error.code !== "ENOENT",
    );
    if (markerFailed) return { complete: false, cause: "blocked" };
    let removed: "removed" | "missing" | "kept" | "unstable";
    try {
      removed = await removeDirNameViaParent(dir, verified.identity, ops);
    } catch (error) {
      await restoreMarkerThroughFd(ops, verified.fd, marker);
      throw error;
    }
    if (removed === "removed" || removed === "missing") return { complete: true };
    // The emptied directory could not be removed by name (a concurrent
    // writer refilled it, or the name was swapped after the walk): restore
    // the marker through the anchored fd — the original directory, wherever
    // it now lives, keeps the ownership evidence a later retry needs.
    await restoreMarkerThroughFd(ops, verified.fd, marker);
    return { complete: false, cause: removed === "kept" ? "blocked" : "unstable" };
  } finally {
    if (verified) await ops.closeDir(verified.fd).catch(() => undefined);
  }
}

async function restoreMarkerThroughFd(
  ops: RunScratchWalkerOps,
  fd: number,
  marker: HeartbeatRunScratchMetadata,
): Promise<void> {
  await ops
    .writeFile(anchoredEntryPath(fd, HEARTBEAT_RUN_SCRATCH_MARKER), `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 })
    .catch(() => undefined);
}

export async function cleanupHeartbeatRunScratch(input: {
  scratch: HeartbeatRunScratch;
  processGroupId?: number | null;
  isProcessGroupAlive?: (processGroupId: number | null | undefined) => boolean;
  /** Persist recovery evidence after ownership/liveness checks, before removal. */
  beforeRemove?: () => Promise<void>;
  walkerOps?: RunScratchWalkerOpsOverride;
  runTempRootOverride?: string;
}): Promise<HeartbeatRunScratchCleanupResult> {
  const dir = path.resolve(input.scratch.dir);
  if (classifyRunScratchDir(dir, input.runTempRootOverride) === null) {
    return { removed: false, dir, reason: "unmarked" };
  }
  try {
    const stats = await fs.lstat(dir);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return { removed: false, dir, reason: "symlink" };
  } catch {
    return { removed: false, dir, reason: "missing" };
  }

  const marker = await readMarker(path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER));
  if (!marker) return { removed: false, dir, reason: "unmarked" };
  if (
    marker.companyId !== input.scratch.metadata.companyId ||
    marker.agentId !== input.scratch.metadata.agentId ||
    marker.runId !== input.scratch.metadata.runId
  ) {
    return { removed: false, dir, reason: "owner_mismatch" };
  }
  if (input.isProcessGroupAlive?.(input.processGroupId) === true) {
    return { removed: false, dir, reason: "process_group_alive" };
  }
  // A retained managed AI home inside this directory still holds a credential
  // the run could not write back; the directory survives until the retained
  // cleanup retires the home.
  if (await retainedAiCredentialCleanupHomeInside(dir)) {
    return { removed: false, dir, reason: "ai_home_retained" };
  }

  await input.beforeRemove?.();
  const removal = await removeMarkedRunScratchDir(dir, input.scratch.metadata, input.walkerOps);
  if (!removal.complete) {
    return { removed: false, dir, reason: removal.cause === "unstable" ? "unsafe_tree" : "mount_point_present" };
  }
  return { removed: true, dir };
}

/** "unknown" means this instance cannot establish ownership; it is never removed. */
export type RunScratchSweepRunState = "terminal" | "active" | "unknown";

export interface SweepRunScratchResult {
  scanned: number;
  removed: string[];
  kept: number;
  truncated: boolean;
}

export const RUN_SCRATCH_SWEEP_MAX_SCAN = 500;
export const RUN_SCRATCH_SWEEP_MAX_REMOVE = 100;

// Instances with separate databases share the temp root, so a run absent from
// this instance's database may belong to another live instance. Keep those.
const sweepCursors = new Map<string, number>();

/**
 * Remove leftover run scratch directories whose owning run is terminal (or
 * whose run row is long gone). Earlier process attempts of a run that crossed
 * a restart leave directories that the live attempt's cleanup never sees.
 * Managed AI credential homes live inside the per-run directory, so this sweep
 * also retires those homes once their run is terminal.
 *
 * Safety: only real (non-symlink) directories directly under a root owned by
 * this runner — the per-run temp root, or the OS temp root with the historical
 * `paperclip-run-` prefix — with a valid regular-file marker, are considered.
 * Active runs and unmarked directories are always kept. A terminal run is
 * only removed after its process group is proven exited (`isRunProcessGroupAlive`)
 * and no retained credential home still depends on the directory. Work per
 * sweep is bounded.
 */
/**
 * Legacy roots live in the shared OS temp directory, where the run id in the
 * marker alone does not prove this runner created the tree or that no foreign
 * writer can act on it: only a directory owned by this process's user and
 * closed to group/other writes, carrying a marker owned by the same user and
 * not world-writable, may be removed.
 */
async function legacySweepCandidateIsSafelyOwned(
  dir: string,
  markerStat: { uid: number; mode: number },
): Promise<boolean> {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid === null) return false;
  if (markerStat.uid !== uid || (markerStat.mode & 0o002) !== 0) return false;
  try {
    const stats = await fs.lstat(dir);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
    return stats.uid === uid && (stats.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

export async function sweepOrphanedRunScratch(input: {
  resolveRunStates: (runIds: string[]) => Promise<Map<string, RunScratchSweepRunState>>;
  /**
   * Answers whether the owning run's process group is still alive. `true`
   * keeps the directory even for a terminal run; `false` or `undefined`
   * (no group id known to the caller) allows removal.
   */
  isRunProcessGroupAlive?: (runId: string) => boolean | undefined;
  /** Restrict the sweep to one run's directories (used when that run ends). */
  runId?: string;
  /** Overrides the legacy OS temp root (tests). */
  tmpRoot?: string;
  /** Overrides the per-run temp root (tests). */
  runTempRootOverride?: string;
  /** Overrides the operations used by the removal walk (tests). */
  walkerOps?: RunScratchWalkerOpsOverride;
  maxScan?: number;
  maxRemove?: number;
}): Promise<SweepRunScratchResult> {
  const legacyRoot = path.resolve(input.tmpRoot ?? os.tmpdir());
  const tempRoot = path.resolve(input.runTempRootOverride ?? runTempRoot());
  const maxScan = input.maxScan ?? RUN_SCRATCH_SWEEP_MAX_SCAN;
  const maxRemove = input.maxRemove ?? RUN_SCRATCH_SWEEP_MAX_REMOVE;
  const result: SweepRunScratchResult = { scanned: 0, removed: [], kept: 0, truncated: false };

  const runNeedle = input.runId !== undefined ? `-${sanitizePathSegment(input.runId.slice(0, 12), "run")}-` : null;
  const tempSegment = input.runId !== undefined ? runTempSegment(input.runId) : null;

  const roots: Array<{ root: string; legacy: boolean }> = [];
  if (legacyRoot !== tempRoot) roots.push({ root: legacyRoot, legacy: true });
  roots.push({ root: tempRoot, legacy: false });

  const candidates: Array<{ dir: string; marker: HeartbeatRunScratchMetadata }> = [];
  for (const { root, legacy } of roots) {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    const named = entries
      .filter((entry) =>
        entry.isDirectory() && !entry.isSymbolicLink() &&
        (!legacy || entry.name.startsWith("paperclip-run-")) &&
        (legacy
          ? runNeedle === null || entry.name.includes(runNeedle)
          : tempSegment === null || entry.name === tempSegment || entry.name.startsWith(`${tempSegment}-`))
      )
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    if (named.length === 0) continue;

    // Each root gets its own bounded budget, so a crowded legacy temp root
    // cannot starve the per-run temp root of its scan window.
    let rootScanned = 0;
    let rootTruncated = false;
    // A global sweep rotates its start so entries that are always kept cannot
    // starve later ones. A per-run sweep pre-filtered by name starts at zero.
    const start = runNeedle === null && named.length > 0 ? (sweepCursors.get(root) ?? 0) % named.length : 0;
    for (let i = 0; i < named.length; i += 1) {
      const entry = named[(start + i) % named.length]!;
      if (runNeedle === null && rootScanned >= maxScan) {
        rootTruncated = true;
        sweepCursors.set(root, start + i);
        break;
      }
      rootScanned += 1;
      const dir = path.join(root, entry.name);
      try {
        const markerPath = path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER);
        const markerStat = await fs.lstat(markerPath);
        if (!markerStat.isFile()) {
          result.kept += 1;
          continue;
        }
        const marker = await readMarker(markerPath);
        if (!marker || (input.runId !== undefined && marker.runId !== input.runId)) {
          result.kept += 1;
          continue;
        }
        if (legacy && !(await legacySweepCandidateIsSafelyOwned(dir, markerStat))) {
          result.kept += 1;
          continue;
        }
        candidates.push({ dir, marker });
      } catch {
        result.kept += 1;
      }
    }
    result.scanned += rootScanned;
    result.truncated = result.truncated || rootTruncated;
    if (runNeedle === null && !rootTruncated) sweepCursors.set(root, 0);
  }
  if (candidates.length === 0) return result;

  const states = await input.resolveRunStates([...new Set(candidates.map((c) => c.marker.runId))]);
  for (const { dir, marker } of candidates) {
    const state = states.get(marker.runId) ?? "active";
    const removable = state === "terminal" && input.isRunProcessGroupAlive?.(marker.runId) !== true &&
      !(await retainedAiCredentialCleanupHomeInside(dir));
    if (!removable || result.removed.length >= maxRemove) {
      if (removable) result.truncated = true;
      result.kept += 1;
      continue;
    }
    try {
      // Re-check just before removal: never remove through a swapped symlink.
      const stat = await fs.lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        result.kept += 1;
        continue;
      }
      const removal = await removeMarkedRunScratchDir(dir, marker, input.walkerOps);
      if (!removal.complete) {
        result.kept += 1;
        continue;
      }
      result.removed.push(dir);
    } catch {
      result.kept += 1;
    }
  }
  return result;
}
