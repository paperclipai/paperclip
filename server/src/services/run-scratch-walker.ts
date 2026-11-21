import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import fss from "node:fs";
import { constants as fsConstants } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

const MAX_SCRATCH_EVIDENCE_BYTES = 16 * 1024;

export type PathStatLike = {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  dev: number;
  ino: number;
};

export interface TreeIdentity {
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
 *   `/proc/self/fd` (macOS): each entry operation runs in a dedicated child
 *   process that opens the recorded directory path, proves the opened inode
 *   matches the one the walker's fd pins, `chdir`s there and only then
 *   performs the single-name operation. A concurrent writer that redirected
 *   the path makes the proof fail before any destructive syscall; once the
 *   proof holds, the single-name operation resolves inside the pinned
 *   directory and cannot leave it. The transient working-directory switch
 *   happens exclusively inside that child, so relative filesystem operations
 *   the shared server process already queued can never observe or inherit
 *   it. When the executor cannot be spawned, every portable entry operation
 *   fails closed and the tree is kept.
 */
export type RunScratchAnchorMode = "procfd" | "paths";

/**
 * Operations of the anchored removal walker. Directories are opened once and
 * every entry operation then resolves inside that directory (see
 * {@link RunScratchAnchorMode}); platforms without `/proc/self/fd` delegate
 * the anchored syscalls to the isolated executor child instead of failing the
 * walk.
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
   * Read a regular file through the verified directory, refusing links and
   * inode replacement. O_NONBLOCK prevents a planted FIFO from blocking it.
   */
  readEntryRegular(fd: number, name: string, expected: { dev: number; ino: number }): Promise<string>;
  /**
   * Anchored exclusive create: an existing name is neither followed nor truncated.
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

type AnchoredEntryOp = "lstatEntry" | "unlinkEntry" | "rmdirEntry" | "writeEntryExclusive" | "readEntryRegular" | "listDir";

interface AnchoredEntryRequest {
  id: number;
  op: AnchoredEntryOp;
  /** Recorded absolute path of the directory the walker's fd pins. */
  dirPath: string;
  /** Whether a symlinked final component of `dirPath` may be followed. */
  follow: boolean;
  /** Current identity of the walker's fd; the executor must prove its own open matches. */
  expect: { dev: number; ino: number };
  name?: string;
  data?: string;
  mode?: number;
  fileIdentity?: { dev: number; ino: number };
}

interface AnchoredEntryStats {
  dev: number;
  ino: number;
  dir: boolean;
  link: boolean;
}

interface AnchoredEntryDirent {
  name: string;
  dir: boolean;
  link: boolean;
  file: boolean;
  fifo: boolean;
  socket: boolean;
  block: boolean;
  char: boolean;
}

type AnchoredEntryResult =
  | { ok: true; stats?: AnchoredEntryStats; entries?: AnchoredEntryDirent[]; data?: string }
  | { ok: false; code: string; message: string };

const ANCHORED_ENTRY_EXECUTOR_TIMEOUT_MS = 20_000;

/**
 * Self-contained executor for portable anchored entry operations. Runs as a
 * plain `node -e` child (no repository imports) so the working-directory
 * switch it needs can never leak into the shared server process: the child is
 * the only code there, its requests are served synchronously one at a time,
 * and it exits when its stdin closes.
 */
const ANCHORED_ENTRY_EXECUTOR_SOURCE = `
const fs = require("node:fs");
const MAX_EVIDENCE_BYTES = ${MAX_SCRATCH_EVIDENCE_BYTES};
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim()) {
      let request;
      try { request = JSON.parse(line); } catch { continue; }
      handle(request);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
function reply(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
function anchorError() {
  const error = new Error("run scratch walker anchor no longer pins the recorded directory");
  error.code = "EANCHOR";
  return error;
}
function handle(request) {
  const response = { id: request.id };
  let dirFd;
  try {
    const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY |
      (request.follow ? 0 : fs.constants.O_NOFOLLOW);
    dirFd = fs.openSync(request.dirPath, flags);
    const pinned = fs.fstatSync(dirFd);
    if (pinned.dev !== request.expect.dev || pinned.ino !== request.expect.ino) {
      throw anchorError();
    }
    const saved = process.cwd();
    process.chdir(request.dirPath);
    try {
      const cwdStats = fs.statSync(".");
      if (cwdStats.dev !== pinned.dev || cwdStats.ino !== pinned.ino) throw anchorError();
      response.result = execute(request);
    } finally {
      process.chdir(saved);
    }
  } catch (error) {
    response.error = {
      code: (error && error.code) || "ECHILD",
      message: String((error && error.message) || error),
    };
  } finally {
    if (dirFd !== undefined) {
      try { fs.closeSync(dirFd); } catch {}
    }
  }
  reply(response);
}
function execute(request) {
  const name = request.name;
  switch (request.op) {
    case "lstatEntry": {
      const stats = fs.lstatSync(name);
      return { dev: stats.dev, ino: stats.ino, dir: stats.isDirectory(), link: stats.isSymbolicLink() };
    }
    case "unlinkEntry":
      fs.unlinkSync(name);
      return null;
    case "rmdirEntry":
      fs.rmdirSync(name);
      return null;
    case "readEntryRegular": {
      const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.dev !== request.fileIdentity.dev || stat.ino !== request.fileIdentity.ino || stat.size > MAX_EVIDENCE_BYTES) throw anchorError();
        // Bound the actual read as well: a concurrent append cannot grow the response unboundedly.
        const bytes = Buffer.alloc(MAX_EVIDENCE_BYTES + 1);
        const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
        if (count > MAX_EVIDENCE_BYTES) throw anchorError();
        return { data: bytes.toString("utf8", 0, count) };
      } finally { fs.closeSync(fd); }
    }
    case "writeEntryExclusive":
      fs.writeFileSync(name, request.data, { mode: request.mode, flag: "wx" });
      return null;
    case "listDir":
      return fs.readdirSync(".", { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        dir: entry.isDirectory(),
        link: entry.isSymbolicLink(),
        file: entry.isFile(),
        fifo: entry.isFIFO(),
        socket: entry.isSocket(),
        block: entry.isBlockDevice(),
        char: entry.isCharacterDevice(),
      }));
    default:
      throw new Error("unknown anchored entry op " + request.op);
  }
}
`;

interface AnchoredExecutorPending {
  resolve: (result: AnchoredEntryResult) => void;
  timer: NodeJS.Timeout;
}

/**
 * One executor generation: the child together with the requests, ids and
 * stdout buffer that belong to exactly that child. All executor state is
 * scoped to the generation so a stale child's exit or stream error can only
 * ever settle its own requests — never the pending work a replacement child
 * is already serving.
 */
interface AnchoredExecutorGeneration {
  child: ChildProcess;
  pending: Map<number, AnchoredExecutorPending>;
  nextId: number;
  stdoutBuffer: string;
  dead: boolean;
}

let anchoredExecutorCurrent: AnchoredExecutorGeneration | null = null;

function anchoredExecutorFailure(code: string, message: string): AnchoredEntryResult {
  return { ok: false, code, message };
}

function settleAnchoredExecutorGeneration(
  generation: AnchoredExecutorGeneration,
  code: string,
  message: string,
): void {
  for (const pending of generation.pending.values()) {
    clearTimeout(pending.timer);
    pending.resolve(anchoredExecutorFailure(code, message));
  }
  generation.pending.clear();
  generation.stdoutBuffer = "";
  generation.dead = true;
  if (anchoredExecutorCurrent === generation) anchoredExecutorCurrent = null;
}

function spawnAnchoredExecutor(): AnchoredExecutorGeneration | null {
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, ["-e", ANCHORED_ENTRY_EXECUTOR_SOURCE], { stdio: ["pipe", "pipe", "ignore"] });
  } catch {
    return null;
  }
  // The executor must never keep the surrounding process alive on its own:
  // scripts and tests that finish their work exit immediately, the pipes
  // close, and the child follows on its stdin end-of-file.
  child.unref();
  (child.stdout as import("node:net").Socket).unref();
  (child.stdin as import("node:net").Socket).unref();
  const generation: AnchoredExecutorGeneration = {
    child,
    pending: new Map(),
    nextId: 1,
    stdoutBuffer: "",
    dead: false,
  };
  const failGeneration = (message: string) =>
    settleAnchoredExecutorGeneration(generation, "ECHILD", message);
  child.on("error", () => failGeneration("run scratch anchored entry executor failed"));
  child.on("exit", () => failGeneration("run scratch anchored entry executor exited"));
  // Stream errors (a cleanup pipe that breaks mid-write, a closed read end)
  // must never surface as unhandled `error` events in the shared server
  // process: the generation that owns the stream settles its requests as
  // failed and the walker keeps the tree for a later retry.
  child.stdin?.on("error", () => failGeneration("run scratch anchored entry executor pipe failed"));
  child.stdout?.on("error", () => failGeneration("run scratch anchored entry executor pipe failed"));
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    if (generation.dead) return;
    generation.stdoutBuffer += chunk;
    let index;
    while ((index = generation.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = generation.stdoutBuffer.slice(0, index);
      generation.stdoutBuffer = generation.stdoutBuffer.slice(index + 1);
      if (!line.trim()) continue;
      let response: { id?: number; result?: unknown; error?: { code?: string; message?: string } };
      try {
        response = JSON.parse(line);
      } catch {
        continue;
      }
      const pending = response.id !== undefined ? generation.pending.get(response.id) : undefined;
      if (!pending) continue;
      generation.pending.delete(response.id!);
      clearTimeout(pending.timer);
      if (response.error) {
        pending.resolve(
          anchoredExecutorFailure(response.error.code || "ECHILD", response.error.message || "anchored entry op failed"),
        );
      } else if (response.result && typeof response.result === "object" && "data" in response.result && typeof response.result.data === "string") {
        pending.resolve({ ok: true, data: response.result.data });
      } else if (Array.isArray(response.result)) {
        pending.resolve({ ok: true, entries: response.result as AnchoredEntryDirent[] });
      } else if (response.result && typeof response.result === "object") {
        pending.resolve({ ok: true, stats: response.result as AnchoredEntryStats });
      } else {
        pending.resolve({ ok: true });
      }
    }
  });
  return generation;
}

/**
 * Run one anchored entry operation in the isolated executor child. Any spawn,
 * crash or timeout failure rejects with `ECHILD`-coded errors so the walker
 * keeps the tree fail-closed; the child respawns on the next request.
 */
function runAnchoredEntryOp(request: Omit<AnchoredEntryRequest, "id">): Promise<AnchoredEntryResult> {
  if (!anchoredExecutorCurrent || anchoredExecutorCurrent.dead || anchoredExecutorCurrent.child.killed) {
    const generation = spawnAnchoredExecutor();
    if (!generation) return Promise.resolve(anchoredExecutorFailure("ECHILD", "run scratch anchored entry executor unavailable"));
    anchoredExecutorCurrent = generation;
  }
  const generation = anchoredExecutorCurrent;
  const id = generation.nextId;
  generation.nextId += 1;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      generation.pending.delete(id);
      generation.child.kill("SIGKILL");
      if (anchoredExecutorCurrent === generation) anchoredExecutorCurrent = null;
      resolve(anchoredExecutorFailure("ECHILD", "run scratch anchored entry executor timed out"));
    }, ANCHORED_ENTRY_EXECUTOR_TIMEOUT_MS);
    generation.pending.set(id, { resolve, timer });
    try {
      generation.child.stdin!.write(`${JSON.stringify({ id, ...request })}\n`);
    } catch {
      generation.pending.delete(id);
      clearTimeout(timer);
      resolve(anchoredExecutorFailure("ECHILD", "run scratch anchored entry executor pipe closed"));
    }
  });
}

function anchoredEntryOpError(result: { ok: false; code: string; message: string }): NodeJS.ErrnoException {
  return Object.assign(new Error(result.message), { code: result.code });
}

function anchoredEntryStats(stats: AnchoredEntryStats): PathStatLike {
  return { dev: stats.dev, ino: stats.ino, isDirectory: () => stats.dir, isSymbolicLink: () => stats.link };
}

function anchoredEntryDirent(entry: AnchoredEntryDirent): Dirent {
  // The walker only consumes the type predicates below on listing entries.
  return {
    name: entry.name,
    isDirectory: () => entry.dir,
    isSymbolicLink: () => entry.link,
    isFile: () => entry.file,
    isFIFO: () => entry.fifo,
    isSocket: () => entry.socket,
    isBlockDevice: () => entry.block,
    isCharacterDevice: () => entry.char,
  } as unknown as Dirent;
}

export function createDefaultRunScratchWalkerOps(
  requested: "auto" | RunScratchAnchorMode = "auto",
): RunScratchWalkerOps {
  const handles = new Map<number, { fd: number; dirPath: string; follow: boolean }>();
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
  const requireEntry = (fd: number) => {
    const entry = handles.get(fd);
    if (!entry) throw new Error(`run scratch walker fd ${fd} is not open`);
    return entry;
  };
  // Portable fallback anchor: the operation runs in the isolated executor
  // child, which opens the recorded directory path, proves the opened inode
  // is the one this walker's fd pins, and only then performs one
  // single-name syscall inside it. The verification is what closes the swap
  // window: a redirected path makes the proof fail with no destructive
  // syscall behind it, and after the proof a single-name operation cannot
  // resolve outside the pinned directory. The server process's own working
  // directory is never touched.
  const anchoredEntryOp = (fd: number, op: AnchoredEntryOp, extra?: { name?: string; data?: string; mode?: number; fileIdentity?: { dev: number; ino: number } }) => {
    const entry = requireEntry(fd);
    if (!path.isAbsolute(entry.dirPath)) {
      return Promise.reject(
        Object.assign(new Error("run scratch walker requires absolute recorded paths"), { code: "EANCHOR" }),
      );
    }
    const pinned = fss.fstatSync(entry.fd);
    return runAnchoredEntryOp({
      op,
      dirPath: entry.dirPath,
      follow: entry.follow,
      expect: { dev: pinned.dev, ino: pinned.ino },
      ...extra,
    });
  };
  const requireAnchoredEntrySuccess = async (fd: number, op: AnchoredEntryOp, extra?: { name?: string; data?: string; mode?: number; fileIdentity?: { dev: number; ino: number } }) => {
    const result = await anchoredEntryOp(fd, op, extra);
    if (!result.ok) throw anchoredEntryOpError(result);
    return result;
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
        path.resolve(p),
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | (opts?.follow ? 0 : fsConstants.O_NOFOLLOW),
      );
      handles.set(fd, { fd, dirPath: path.resolve(p), follow: opts?.follow === true });
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
      // Portable fallback: the listing is read inside the anchored directory
      // of the isolated executor after the identity proof, so a path swapped
      // for a symlink cannot feed foreign entries into the removal.
      const result = await requireAnchoredEntrySuccess(fd, "listDir");
      return (result.entries ?? []).map(anchoredEntryDirent);
    },
    async lstatEntry(fd, name) {
      if ((anchorMode ?? "paths") === "procfd") return this.lstatPath(anchoredEntryPath(fd, name));
      const result = await requireAnchoredEntrySuccess(fd, "lstatEntry", { name });
      return anchoredEntryStats(result.stats ?? { dev: -1, ino: -1, dir: false, link: false });
    },
    async openEntry(fd, name) {
      if ((anchorMode ?? "paths") === "procfd") {
        return this.openDir(anchoredEntryPath(fd, name));
      }
      const entry = requireEntry(fd);
      const childPath = path.join(entry.dirPath, name);
      const childFd = fss.openSync(
        childPath,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
      );
      handles.set(childFd, { fd: childFd, dirPath: childPath, follow: false });
      return childFd;
    },
    async unlinkEntry(fd, name) {
      if ((anchorMode ?? "paths") === "procfd") return this.unlink(anchoredEntryPath(fd, name));
      await requireAnchoredEntrySuccess(fd, "unlinkEntry", { name });
    },
    async rmdirEntry(fd, name) {
      if ((anchorMode ?? "paths") === "procfd") return this.rmdir(anchoredEntryPath(fd, name));
      await requireAnchoredEntrySuccess(fd, "rmdirEntry", { name });
    },
    async readEntryRegular(fd, name, expected) {
      if ((anchorMode ?? "paths") === "procfd") {
        const handle = await fs.open(anchoredEntryPath(fd, name), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.dev !== expected.dev || stat.ino !== expected.ino || stat.size > MAX_SCRATCH_EVIDENCE_BYTES) {
            throw Object.assign(new Error("receipt identity changed"), { code: "EANCHOR" });
          }
          const bytes = Buffer.alloc(MAX_SCRATCH_EVIDENCE_BYTES + 1);
          const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
          if (bytesRead > MAX_SCRATCH_EVIDENCE_BYTES) throw Object.assign(new Error("receipt exceeds size bound"), { code: "EANCHOR" });
          return bytes.toString("utf8", 0, bytesRead);
        } finally { await handle.close(); }
      }
      const result = await requireAnchoredEntrySuccess(fd, "readEntryRegular", { name, fileIdentity: { dev: expected.dev, ino: expected.ino } });
      if (result.data === undefined) throw new Error("receipt read returned no data");
      return result.data;
    },
    async writeEntryExclusive(fd, name, data, mode) {
      if ((anchorMode ?? "paths") === "procfd") {
        return this.writeFile(anchoredEntryPath(fd, name), data, { mode, flag: "wx" });
      }
      await requireAnchoredEntrySuccess(fd, "writeEntryExclusive", { name, data, mode });
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

export function resolveWalkerOps(overrides?: RunScratchWalkerOpsOverride): RunScratchWalkerOps {
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

export async function removeEntriesWithinDevice(
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

export interface VerifiedDir {
  fd: number;
  identity: TreeIdentity;
}

/**
 * Open `dir` refusing a symlinked final component and prove the fd refers to
 * the inode the pre-flight lstat saw. A missing path throws ENOENT (callers
 * decide whether that means already removed); a swapped or unusable path
 * yields null so the tree is kept.
 */
export async function openVerifiedDirectory(
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
export async function removeDirNameViaParent(
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

