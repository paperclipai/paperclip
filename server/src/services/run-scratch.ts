import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import fss from "node:fs";
import { constants as fsConstants } from "node:fs";
import { randomBytes } from "node:crypto";
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
  /** Link count of the directory inode: 0 once the held directory is deleted. */
  nlink: number;
}

function identityOf(stats: { dev: number; ino: number; nlink: number }): TreeIdentity {
  return { dev: stats.dev, ino: stats.ino, nlink: stats.nlink };
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
 * How entry operations reach the directory the walker holds open:
 * - `procfd` resolves every entry through `/proc/self/fd/<fd>/<name>`
 *   (openat-style semantics): the lookup happens inside the directory the fd
 *   refers to, so no path component the walker does not hold open — including
 *   the scratch root itself — can be swapped for a symlink to redirect a
 *   deletion into a foreign tree.
 * - `paths` is the portable fallback for platforms without a usable
 *   `/proc/self/fd` (macOS): each entry operation first `chdir`s into the
 *   recorded directory path and proves `stat(".")` still matches the inode
 *   the fd pins, and only then performs the operation on the single name.
 *   A concurrent writer that redirected the path makes the proof fail before
 *   any destructive syscall; once the proof holds, the single-name operation
 *   resolves inside the pinned directory and cannot leave it. The whole
 *   anchor+operate+restore sequence is synchronous, so the transient working
 *   directory is never observable by the rest of the process.
 */
export type RunScratchAnchorMode = "procfd" | "paths";

/**
 * Operations of the anchored removal walker. Directories are opened once and
 * every entry operation then resolves inside that directory (see
 * {@link RunScratchAnchorMode}); platforms without `/proc/self/fd` use the
 * verified path fallback instead of failing the walk.
 */
export interface RunScratchWalkerOps {
  /** Anchoring strategy this instance uses for entry operations. */
  readonly anchoring: RunScratchAnchorMode;
  /**
   * Resolve (and cache) the anchoring strategy, running the platform probe
   * when needed: branch decisions must await this, since `anchoring` reads
   * as the portable fallback until the probe completes.
   */
  resolveAnchoring(): Promise<RunScratchAnchorMode>;
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
  /** Anchored `lstat` of `name` inside the directory held by `fd`. */
  lstatEntry(fd: number, name: string): Promise<PathStatLike>;
  /**
   * Anchored open of the child directory `name` inside the directory held by
   * `fd`; a symlinked final component is refused.
   */
  openEntry(fd: number, name: string): Promise<number>;
  /** Anchored `unlink` of `name` inside the directory held by `fd`. */
  unlinkEntry(fd: number, name: string): Promise<void>;
  /** Anchored `rmdir` of `name` inside the directory held by `fd`. */
  rmdirEntry(fd: number, name: string): Promise<void>;
  /**
   * Anchored exclusive create of `name` inside the directory held by `fd`:
   * an existing name — regular file or symlink — is neither followed nor
   * truncated.
   */
  writeEntryExclusive(fd: number, name: string, data: string, mode: number): Promise<void>;
  /**
   * `unlink` by absolute path. Only used as the fd-anchoring substrate for
   * {@link unlinkEntry}; overrides observe the anchored `/proc/self/fd`
   * paths.
   */
  unlink(p: string): Promise<void>;
  /**
   * `rmdir` by absolute path. Only used as the fd-anchoring substrate for
   * {@link rmdirEntry}; overrides observe the anchored `/proc/self/fd`
   * paths.
   */
  rmdir(p: string): Promise<void>;
  /**
   * `writeFile` by absolute path. Only used as the fd-anchoring substrate
   * for {@link writeEntryExclusive}.
   */
  writeFile(p: string, data: string, options?: { mode?: number; flag?: string }): Promise<void>;
  closeDir(fd: number): Promise<void>;
}

export function createDefaultRunScratchWalkerOps(
  requested: "auto" | RunScratchAnchorMode = "auto",
): RunScratchWalkerOps {
  const handles = new Map<number, { fd: number; dirPath: string }>();
  let anchorMode: RunScratchAnchorMode | undefined = requested === "auto" ? undefined : requested;
  const resolveAnchorMode = async (fd: number): Promise<RunScratchAnchorMode> => {
    if (anchorMode === undefined) {
      // Probe once per walker: when fd-anchored listing does not work on
      // this platform, every walk uses the portable path fallback.
      try {
        await fs.readdir(anchoredDirPath(fd));
        anchorMode = "procfd";
      } catch {
        anchorMode = "paths";
      }
    }
    return anchorMode;
  };
  const anchorError = (): NodeJS.ErrnoException =>
    Object.assign(new Error("run scratch walker anchor no longer pins the recorded directory"), {
      code: "EANCHOR",
    });
  // Portable fallback anchor: synchronously enter the recorded directory,
  // prove the working directory is the inode the fd pins, run one
  // single-name operation there and restore the previous working directory
  // before returning or throwing. The verification is what closes the
  // swap window: a redirected `chdir` is caught with no destructive syscall
  // behind it, and after the proof a single-name operation cannot resolve
  // outside the pinned directory.
  const withAnchoredCwd = <T>(fd: number, run: () => T): T => {
    const entry = handles.get(fd);
    if (!entry) throw new Error(`run scratch walker fd ${fd} is not open`);
    const saved = process.cwd();
    process.chdir(entry.dirPath);
    try {
      const cwdStats = fss.statSync(".");
      const pinned = fss.fstatSync(entry.fd);
      if (cwdStats.dev !== pinned.dev || cwdStats.ino !== pinned.ino) throw anchorError();
      return run();
    } finally {
      process.chdir(saved);
    }
  };
  const requireEntry = (fd: number) => {
    const entry = handles.get(fd);
    if (!entry) throw new Error(`run scratch walker fd ${fd} is not open`);
    return entry;
  };
  return {
    get anchoring() {
      return anchorMode ?? "paths";
    },
    async resolveAnchoring() {
      if (anchorMode === undefined) {
        // Probe once: a readable /proc/self/fd means fd-anchored entry
        // operations are available; anything else uses the portable path
        // fallback with its quarantine-then-destroy semantics.
        try {
          await fs.readdir(PROC_SELF_FD);
          anchorMode = "procfd";
        } catch {
          anchorMode = "paths";
        }
      }
      return anchorMode;
    },
    async openDir(p, opts) {
      const fd = fss.openSync(
        p,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | (opts?.follow ? 0 : fsConstants.O_NOFOLLOW),
      );
      handles.set(fd, { fd, dirPath: p });
      await resolveAnchorMode(fd);
      return fd;
    },
    async statDir(fd) {
      return identityOf(fss.fstatSync(requireEntry(fd).fd));
    },
    lstatPath: (p) => fs.lstat(p),
    statPath: (p) => fs.stat(p),
    async listDir(fd) {
      const entry = requireEntry(fd);
      const mode = await resolveAnchorMode(entry.fd);
      if (mode === "procfd") return fs.readdir(anchoredDirPath(entry.fd), { withFileTypes: true });
      // Portable fallback: the listing is read from inside the anchored
      // working directory after the identity proof, so a path swapped for a
      // symlink cannot feed foreign entries into the removal.
      return withAnchoredCwd(entry.fd, () => fss.readdirSync(".", { withFileTypes: true }));
    },
    async lstatEntry(fd, name) {
      if ((anchorMode ?? "paths") === "procfd") return this.lstatPath(anchoredEntryPath(fd, name));
      return withAnchoredCwd(fd, () => fss.lstatSync(name));
    },
    async openEntry(fd, name) {
      if ((anchorMode ?? "paths") === "procfd") {
        return this.openDir(anchoredEntryPath(fd, name));
      }
      const entry = requireEntry(fd);
      return withAnchoredCwd(entry.fd, () => {
        const childFd = fss.openSync(name, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
        handles.set(childFd, { fd: childFd, dirPath: path.join(entry.dirPath, name) });
        return childFd;
      });
    },
    async unlinkEntry(fd, name) {
      if ((anchorMode ?? "paths") === "procfd") return this.unlink(anchoredEntryPath(fd, name));
      return withAnchoredCwd(fd, () => fss.unlinkSync(name));
    },
    async rmdirEntry(fd, name) {
      if ((anchorMode ?? "paths") === "procfd") return this.rmdir(anchoredEntryPath(fd, name));
      return withAnchoredCwd(fd, () => fss.rmdirSync(name));
    },
    async writeEntryExclusive(fd, name, data, mode) {
      if ((anchorMode ?? "paths") === "procfd") {
        return this.writeFile(anchoredEntryPath(fd, name), data, { mode, flag: "wx" });
      }
      return withAnchoredCwd(fd, () => {
        fss.writeFileSync(name, data, { mode, flag: "wx" });
      });
    },
    unlink: (p) => fs.unlink(p),
    rmdir: (p) => fs.rmdir(p),
    writeFile: (p, data, options) => fs.writeFile(p, data, { mode: options?.mode, flag: options?.flag }),
    async closeDir(fd) {
      const entry = handles.get(fd);
      handles.delete(fd);
      if (entry) fss.closeSync(entry.fd);
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
    // Every entry operation below is anchored inside the directory the fd
    // holds open: under fd anchoring it resolves through `/proc/self/fd`,
    // and in the portable fallback the anchor is proven right before the
    // single-name syscall. A directory swapped for a symlink anywhere
    // between the root and here cannot redirect a lookup, unlink or rmdir
    // into a foreign tree.
    let stats: PathStatLike | null;
    try {
      stats = await ops.lstatEntry(dirFd, entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // gone since the listing
      // The anchor refused the redirected resolution: keep the tree and
      // let a later retry re-prove it.
      complete = false;
      unstable = true;
      continue;
    }
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
      // Files and symlinks are unlinked by their anchored name: unlink
      // never follows a symlink and the anchor cannot leave the verified
      // directory, so the worst outcome is unlinking a concurrently
      // replaced name inside this same directory.
      try {
        await ops.unlinkEntry(dirFd, entry.name);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") continue; // gone since the listing
        complete = false;
        if (code === "EANCHOR") unstable = true;
      }
      continue;
    }
    // Open the child through the anchored name refusing a symlinked final
    // component: the fd then pins the child inode for the whole descent, so
    // later swaps of any path component cannot redirect the removal below.
    let childFd: number;
    try {
      childFd = await ops.openEntry(dirFd, entry.name);
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
        // The emptied child is removed by its anchored name in the verified
        // parent directory.
        await ops.rmdirEntry(dirFd, entry.name);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") continue;
        if (code === "ENOTEMPTY") {
          // A concurrent writer refilled the emptied directory.
          complete = false;
          continue;
        }
        // ENOTDIR: the name stopped being the emptied directory; EANCHOR:
        // the anchor refused the redirected resolution.
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
 * Remove the directory's name from its parent through anchored entry
 * operations inside a parent fd held open: an ancestor swapped for a symlink
 * cannot redirect the rmdir, and the entry is proven to still be the verified
 * directory before the removal.
 */
async function removeDirNameViaParent(
  dir: string,
  expected: TreeIdentity,
  ops: RunScratchWalkerOps,
): Promise<"removed" | "missing" | "kept" | "unstable"> {
  const parent = path.dirname(dir);
  const name = path.basename(dir);
  // The parent itself is opened by path, following symlinks intentionally:
  // the run temp root may legitimately live behind a symlinked home, and the
  // pre/post identity comparison verifies with the same semantics, refusing
  // a parent whose current resolution changed between the stat and the open.
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
    let entry: PathStatLike | null;
    try {
      entry = await ops.lstatEntry(parentFd, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      return "unstable";
    }
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.dev !== expected.dev || entry.ino !== expected.ino) {
      return "unstable";
    }
    try {
      await ops.rmdirEntry(parentFd, name);
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
 * Portable (non `/proc/self/fd`) completion of a verified directory removal.
 *
 * Path-based entry operations cannot address children of a held-open
 * directory on these platforms, so the removal never deletes through the
 * original name. Instead the directory — proven by identity first — is
 * atomically renamed to a fresh, unguessable sibling name and destroyed
 * there:
 *
 * - `rename` never traverses the moved name: if an attacker swapped it for a
 *   symlink between the identity proof and the rename, the symlink itself is
 *   moved and then unlinked; the foreign tree is never reached.
 * - Inside the quarantine name every entry operation is anchored to the
 *   held-open directory fd: the portable ops re-prove, synchronously right
 *   before each single-name syscall, that the working directory is still the
 *   inode the fd pins. A concurrent writer holding pre-quarantine fds can
 *   still rename children and plant symlinks inside the quarantined tree,
 *   but a redirected anchor is refused before any destructive syscall, and
 *   a proven anchor cannot resolve outside the pinned directory. Such a
 *   writer can only make the removal incomplete, never foreign.
 * - The quarantine name preserves the original segment prefix with a
 *   `-rm-<random>` suffix, so an interrupted removal stays discoverable by
 *   retries and sweeps long after the original name is gone.
 *
 * Returns the quarantine path the caller must operate on (the caller owns
 * removing it), or null when the removal cannot proceed fail-closed.
 */
const QUARANTINE_NAME_RE = /-rm-[0-9a-f]{16}$/;

/** Directories a quarantined removal of `dir` may leave behind for retries. */
export async function runScratchRemnantDirs(dir: string): Promise<string[]> {
  const parent = path.dirname(path.resolve(dir));
  const base = path.basename(path.resolve(dir));
  let entries: Dirent[];
  try {
    entries = await fs.readdir(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && entry.name.startsWith(`${base}-rm-`))
    .map((entry) => path.join(parent, entry.name))
    .sort();
}

async function quarantineRenameForPortableRemoval(
  dir: string,
  ops: RunScratchWalkerOps,
): Promise<{ kind: "quarantined"; path: string } | { kind: "missing" } | { kind: "refused" }> {
  const verified = await openVerifiedDirectory(dir, ops).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw error;
    return null;
  });
  if (!verified) return { kind: "refused" };
  try {
    const parent = path.dirname(dir);
    const name = path.basename(dir);
    // A retry may find an earlier quarantine name: it already is a fresh
    // unguessable name proven by identity, so renaming again would only
    // orphan the previous suffix.
    if (!QUARANTINE_NAME_RE.test(name)) {
      const suffix = randomBytes(8).toString("hex");
      const quarantine = path.join(parent, `${name}-rm-${suffix}`);
      try {
        await fs.rename(dir, quarantine);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
        return { kind: "refused" };
      }
      // The rename moved whatever held the name. Only the proven directory may
      // be destroyed under the quarantine name; a moved link is unlinked
      // there — a link, never a foreign tree — while a suspicious directory
      // is moved out of the `-rm-` pattern first, so no retry or sweep can
      // ever mistake it for this directory's own quarantined remnant.
      const moved = await fs.lstat(quarantine).catch(() => null);
      if (
        !moved ||
        !moved.isDirectory() ||
        moved.isSymbolicLink() ||
        moved.dev !== verified.identity.dev ||
        moved.ino !== verified.identity.ino
      ) {
        if (moved?.isDirectory() && !moved.isSymbolicLink()) {
          await fs.rename(quarantine, path.join(parent, `${name}-suspect-${suffix}`)).catch(() => undefined);
        } else {
          await fs.unlink(quarantine).catch(() => undefined);
        }
        return { kind: "refused" };
      }
      return { kind: "quarantined", path: quarantine };
    }
    return { kind: "quarantined", path: dir };
  } finally {
    await ops.closeDir(verified.fd).catch(() => undefined);
  }
}

async function removeVerifiedDirectoryTree(
  dir: string,
  ops: RunScratchWalkerOps,
): Promise<{ complete: boolean }> {
  let verified: VerifiedDir | null = null;
  try {
    verified = await openVerifiedDirectory(dir, ops);
    if (!verified) return { complete: false };
    const walk = await removeEntriesWithinDevice(verified.fd, verified.identity.dev, ops);
    if (!walk.complete) return { complete: false };
    const removed = await removeDirNameViaParent(dir, verified.identity, ops);
    if (removed !== "removed" && removed !== "missing") return { complete: false };
    // A vanished name alone does not prove the inode held open was deleted:
    // a concurrent rename keeps the tree alive under another name, so only
    // an unreferenced directory completes the removal.
    const stillLinked = await ops
      .statDir(verified.fd)
      .then((identity) => identity.nlink > 0)
      .catch(() => true);
    return { complete: !stillLinked };
  } finally {
    if (verified) await ops.closeDir(verified.fd).catch(() => undefined);
  }
}

/**
 * Recursively remove a directory tree without following symlinks and without
 * crossing mount points. Every entry operation is anchored to a directory fd
 * held open for the descent, so swapping any path component for a symlink
 * cannot redirect a deletion outside the tree. Platforms without
 * `/proc/self/fd` first rename the verified directory to a fresh quarantine
 * sibling and destroy it there (see {@link quarantineRenameForPortableRemoval}).
 *
 * An incomplete portable removal leaves the tree under a quarantine name
 * while callers keep retrying the original path, so absence of the original
 * never proves completion: the removal only completes when no quarantine
 * remnant of the directory remains either. `quarantinePath` reports the
 * effective path an incomplete removal left behind, for callers that record
 * cleanup state.
 */
export async function removeRunTempTree(
  dir: string,
  opts?: { walkerOps?: RunScratchWalkerOpsOverride },
): Promise<{ complete: boolean; quarantinePath?: string }> {
  const ops = resolveWalkerOps(opts?.walkerOps);
  const clearRemnants = async (exclude?: string): Promise<{ complete: boolean; quarantinePath?: string }> => {
    for (const remnant of await runScratchRemnantDirs(dir)) {
      if (remnant === exclude) continue;
      const cleared = await removeVerifiedDirectoryTree(remnant, ops)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return { complete: true } as const;
          return null;
        });
      if (cleared?.complete !== true) return { complete: false, quarantinePath: remnant };
    }
    return { complete: true };
  };
  if ((await ops.resolveAnchoring()) !== "procfd") {
    const quarantine = await quarantineRenameForPortableRemoval(dir, ops).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return { kind: "missing" } as const;
        throw error;
      },
    );
    if (quarantine.kind === "missing") return clearRemnants();
    if (quarantine.kind === "refused") {
      // The original name could not be proven; earlier remnants are still
      // this directory's unfinished work and must keep the result open.
      const remnants = await clearRemnants();
      return remnants.complete ? { complete: false } : remnants;
    }
    if (!(await removeVerifiedDirectoryTree(quarantine.path, ops)).complete) {
      return { complete: false, quarantinePath: quarantine.path };
    }
    return clearRemnants(quarantine.path);
  }
  try {
    const destroyed = await removeVerifiedDirectoryTree(dir, ops);
    if (!destroyed.complete) return { complete: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return clearRemnants();
}

/**
 * Remove a marked run scratch directory while keeping the ownership marker —
 * and its retry evidence — until every other entry is gone. The whole removal
 * is anchored to directory fds: the marker is unlinked and restored through
 * the verified directory itself, never through a path a swap could redirect,
 * and the final rmdir targets the proven entry inside a parent fd held open.
 * Platforms without `/proc/self/fd` first rename the verified directory to a
 * fresh quarantine sibling (a name the sweep still recognizes: the segment
 * prefix is preserved) and complete the marker-preserving removal there.
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
  let target = dir;
  if ((await ops.resolveAnchoring()) !== "procfd") {
    // Portable platforms never delete through the original name: quarantine
    // first (fail-closed on any identity surprise), then complete the same
    // marker-preserving removal inside the quarantine path.
    const quarantine = await quarantineRenameForPortableRemoval(dir, ops).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return { kind: "missing" } as const;
      throw error;
    });
    if (quarantine.kind === "missing") return { complete: true };
    if (quarantine.kind === "refused") return { complete: false, cause: "unstable" };
    target = quarantine.path;
  }
  let verified: VerifiedDir | null = null;
  try {
    verified = await openVerifiedDirectory(target, ops);
    if (!verified) return { complete: false, cause: "unstable" };
    const walk = await removeEntriesWithinDevice(
      verified.fd,
      verified.identity.dev,
      ops,
      new Set([HEARTBEAT_RUN_SCRATCH_MARKER]),
    );
    if (!walk.complete) return { complete: false, cause: walk.unstable ? "unstable" : "blocked" };
    // Unlink the marker through the anchored entry name only once every
    // other entry is gone: it always targets the verified directory itself,
    // never a swapped-in tree, so the retry evidence cannot vanish elsewhere.
    const markerFailed = await ops.unlinkEntry(verified.fd, HEARTBEAT_RUN_SCRATCH_MARKER).then(
      () => false,
      (error: NodeJS.ErrnoException) => error.code !== "ENOENT",
    );
    if (markerFailed) return { complete: false, cause: "blocked" };
    let removed: "removed" | "missing" | "kept" | "unstable";
    try {
      removed = await removeDirNameViaParent(target, verified.identity, ops);
    } catch (error) {
      await restoreMarkerThroughFd(ops, verified.fd, marker);
      throw error;
    }
    if (removed === "removed" || removed === "missing") {
      // The name is gone from its parent, but only a dead inode proves the
      // directory itself was deleted: a concurrent rename leaves the emptied
      // original — now unmarked — alive wherever it moved to. Fail closed
      // unless the directory held open is really unreferenced, and put the
      // marker back into that same inode.
      const stillLinked = await ops
        .statDir(verified.fd)
        .then((identity) => identity.nlink > 0)
        .catch(() => true);
      if (!stillLinked) return { complete: true };
      await restoreMarkerThroughFd(ops, verified.fd, marker);
      return { complete: false, cause: "unstable" };
    }
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
  // Exclusive creation (O_CREAT|O_EXCL) through the anchored entry name: a
  // name that concurrently reappeared — a regular file or a symlink — is
  // neither followed nor truncated, so the restore can never write outside
  // the verified directory. A concurrent writer that recreated the marker
  // keeps its copy; when the name is not free the directory simply stays as
  // it is. A refused anchor (the recorded path was redirected) also leaves
  // the directory untouched.
  await ops
    .writeEntryExclusive(fd, HEARTBEAT_RUN_SCRATCH_MARKER, `${JSON.stringify(marker, null, 2)}\n`, 0o600)
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
    // A portable removal that was interrupted after its quarantine rename
    // leaves the tree under `<segment>-rm-<random>` while this path stays
    // gone. The ownership and liveness gates already passed before that
    // rename, so the retry continues on the renamed tree instead of
    // reporting a missing directory nobody can act on anymore.
    const remnants = await runScratchRemnantDirs(dir);
    if (remnants.length === 0) return { removed: false, dir, reason: "missing" };
    const ops = resolveWalkerOps(input.walkerOps);
    for (const remnant of remnants) {
      if (await retainedAiCredentialCleanupHomeInside(remnant)) {
        return { removed: false, dir, reason: "ai_home_retained" };
      }
      const cleared = await removeVerifiedDirectoryTree(remnant, ops)
        .then(() => true, (error: NodeJS.ErrnoException) => error.code === "ENOENT");
      if (!cleared) return { removed: false, dir, reason: "unsafe_tree" };
    }
    return { removed: true, dir };
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
  /**
   * Directories the sweep kept that still represent unfinished cleanup work
   * for this runner: terminal-run directories it could not remove yet
   * (process group still exiting, retained credential home, blocked or
   * unstable tree, truncation) and active runs' directories, whose reclamation
   * becomes due when the run settles. Directories of unknown (foreign)
   * ownership are never removed and do not count: another instance owns
   * their cleanup. Zero means the sweep has settled.
   */
  pending: number;
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

/**
 * A quarantine remnant in the shared OS temp directory has no marker left to
 * check (the interrupted removal may already have unlinked it), so the
 * directory's own ownership and closed permissions are the evidence — the
 * same bar `legacySweepCandidateIsSafelyOwned` sets for the marker itself.
 */
async function legacyRemnantSafelyOwned(dir: string): Promise<boolean> {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid === null) return false;
  try {
    const stats = await fs.lstat(dir);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
    return stats.uid === uid && (stats.mode & 0o022) === 0 && (stats.mode & 0o002) === 0;
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
  const result: SweepRunScratchResult = { scanned: 0, removed: [], kept: 0, truncated: false, pending: 0 };

  const runNeedle = input.runId !== undefined ? `-${sanitizePathSegment(input.runId.slice(0, 12), "run")}-` : null;
  const tempSegment = input.runId !== undefined ? runTempSegment(input.runId) : null;

  const roots: Array<{ root: string; legacy: boolean }> = [];
  if (legacyRoot !== tempRoot) roots.push({ root: legacyRoot, legacy: true });
  roots.push({ root: tempRoot, legacy: false });

  const candidates: Array<{ dir: string; marker: HeartbeatRunScratchMetadata }> = [];
  // Quarantine remnants of interrupted portable removals: the original name
  // is gone and the marker may already have been unlinked, but the tree
  // still holds the run's leftover files. Their removal only ever follows a
  // quarantine rename that had already passed the ownership and liveness
  // gates, so the name pattern (within a root this runner owns) plus the
  // legacy ownership checks are the remaining evidence.
  const remnantCandidates: string[] = [];
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
        (!legacy ||
          entry.name.startsWith("paperclip-run-") ||
          (runNeedle === null && entry.name.startsWith("paperclip-ai-") && QUARANTINE_NAME_RE.test(entry.name))) &&
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
      const isRemnant = QUARANTINE_NAME_RE.test(entry.name);
      try {
        const markerPath = path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER);
        // A quarantine remnant whose marker was already unlinked (or never
        // re-created after a late-stage interruption) is the unfinished tail
        // of a gated removal, not an unowned orphan.
        const markerStat = await fs.lstat(markerPath).catch(() => null);
        if (!markerStat?.isFile()) {
          if (isRemnant && (!legacy || await legacyRemnantSafelyOwned(dir))) remnantCandidates.push(dir);
          else result.kept += 1;
          continue;
        }
        const marker = await readMarker(markerPath);
        if (!marker || (input.runId !== undefined && marker.runId !== input.runId)) {
          if (isRemnant && (!legacy || await legacyRemnantSafelyOwned(dir))) remnantCandidates.push(dir);
          else result.kept += 1;
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

  const states = candidates.length
    ? await input.resolveRunStates([...new Set(candidates.map((c) => c.marker.runId))])
    : new Map<string, RunScratchSweepRunState>();
  for (const { dir, marker } of candidates) {
    const state = states.get(marker.runId) ?? "active";
    const removable = state === "terminal" && input.isRunProcessGroupAlive?.(marker.runId) !== true &&
      !(await retainedAiCredentialCleanupHomeInside(dir));
    if (!removable || result.removed.length >= maxRemove) {
      if (removable) result.truncated = true;
      result.kept += 1;
      // Terminal-run directories stay this sweep's unfinished cleanup;
      // active-run directories are a future obligation that becomes
      // removable once the run settles. Unknown ownership is not ours.
      if (removable || state === "terminal" || state === "active") result.pending += 1;
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
        // A terminal-run removal that could not finish retries on a later sweep.
        result.pending += 1;
        continue;
      }
      result.removed.push(dir);
    } catch {
      result.kept += 1;
      result.pending += 1;
    }
  }
  for (const dir of remnantCandidates) {
    if (result.removed.length >= maxRemove) {
      result.truncated = true;
      result.kept += 1;
      result.pending += 1;
      continue;
    }
    try {
      // Re-check just before removal: never remove through a swapped symlink.
      const stat = await fs.lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        result.kept += 1;
        continue;
      }
      const removal = await removeVerifiedDirectoryTree(dir, resolveWalkerOps(input.walkerOps))
        .catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? { complete: true } : null));
      if (!removal?.complete) {
        result.kept += 1;
        result.pending += 1;
        continue;
      }
      result.removed.push(dir);
    } catch {
      result.kept += 1;
      result.pending += 1;
    }
  }
  return result;
}
