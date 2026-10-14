import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { AcpxPrivateSnapshot } from "./private-snapshot.js";

export interface NativeAcpxDistributionEntry { path: string; sha256: string; size: number; executable: boolean }
export interface NativeAcpxDistributionInput {
  distributionRoot: string;
  manifestPath: string;
  /** Trusted profile pin, never taken from the installed manifest itself. */
  expectedClosureSha256: string;
  executable: string;
  /** When present, execute this JS entry with the distribution's bundled Node. */
  entrypoint?: string;
  fixedArguments: readonly string[];
  isolatedCacheEnvironmentName?: "COPILOT_PKG_CACHE_HOME";
  /** Trusted Copilot profile only; resolved inside each immutable spawn lease. */
  copilotDistributionDirectory?: string;
}
export interface NativeAcpxDistributionSnapshot {
  snapshot: AcpxPrivateSnapshot;
  commandDirectory: FileHandle;
  bootstrap: Buffer;
}

const MAX_NATIVE_TREE_BYTES = 1024 * 1024 * 1024;
const MAX_NATIVE_FILE_BYTES = 384 * 1024 * 1024;
const MAX_NATIVE_MANIFEST_BYTES = 4 * 1024 * 1024;
// Bound both file descriptors and buffers. A single larger admitted file runs
// alone and remains subject to MAX_NATIVE_FILE_BYTES.
const NATIVE_COPY_CONCURRENCY = 32;
const NATIVE_DIRECTORY_CONCURRENCY = 32;
const NATIVE_COPY_BUFFER_BYTES = 32 * 1024 * 1024;
const BOOTSTRAP = ".paperclip-native-entry.cjs";
const GUARD = ".paperclip-native-module-guard.cjs";
const COPILOT_ENTRY = ".paperclip-copilot-entry";
export const NATIVE_ACPX_BOOTSTRAP_NAME = BOOTSTRAP;
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const validPath = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4_096 && !isAbsolute(value) && !/[\u0000-\u001f\u007f\\]/.test(value) && value.split("/").every(part => part.length > 0 && part !== "." && part !== "..");

/** Parse a closed, canonical execution inventory before opening any file in it. */
export function parseNativeAcpxDistributionEntries(value: unknown, expectedSha256: string): NativeAcpxDistributionEntry[] {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("Native ACPX closure pin is invalid");
  const entries = value !== null && typeof value === "object" ? (value as { entries?: unknown }).entries : undefined;
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 30_000) throw new Error("Native ACPX closure inventory is invalid");
  let total = 0;
  let previous = "";
  const parsed = entries.map(raw => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Native ACPX closure entry is invalid");
    const entry = raw as Record<string, unknown>;
    if (Object.keys(entry).some(key => !["path", "sha256", "size", "executable"].includes(key)) || !validPath(entry.path) || entry.path <= previous || entry.path === BOOTSTRAP || entry.path === GUARD || entry.path === "manifest.json" || entry.path.startsWith(".paperclip-")) throw new Error("Native ACPX closure paths must be safe, unique and sorted");
    if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.size) || Number(entry.size) < 0 || Number(entry.size) > MAX_NATIVE_FILE_BYTES || typeof entry.executable !== "boolean") throw new Error("Native ACPX closure file metadata is invalid");
    previous = entry.path;
    total += Number(entry.size);
    if (total > MAX_NATIVE_TREE_BYTES) throw new Error("Native ACPX closure exceeds its byte bound");
    return { path: entry.path, sha256: entry.sha256, size: Number(entry.size), executable: entry.executable };
  });
  if (sha256(JSON.stringify(parsed)) !== expectedSha256) throw new Error("Native ACPX closure manifest digest mismatch");
  return parsed;
}

export async function readNativeAcpxDistributionEntries(input: NativeAcpxDistributionInput): Promise<NativeAcpxDistributionEntry[]> {
  if (!validPath(input.executable) || (input.entrypoint !== undefined && !validPath(input.entrypoint)) || input.fixedArguments.length > 128 || input.fixedArguments.some(arg => typeof arg !== "string" || arg.length > 16_384 || arg.includes("\0")) || (input.isolatedCacheEnvironmentName !== undefined && input.isolatedCacheEnvironmentName !== "COPILOT_PKG_CACHE_HOME")
    || (input.copilotDistributionDirectory !== undefined && (!validPath(input.copilotDistributionDirectory) || input.entrypoint !== undefined))) throw new Error("Native ACPX launch declaration is invalid");
  const file = await open(input.manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(MAX_NATIVE_MANIFEST_BYTES)) throw new Error("Native ACPX manifest must be a bounded regular file");
    const bytes = await file.readFile();
    if (!same(before, await file.stat({ bigint: true })) || bytes.length !== Number(before.size)) throw new Error("Native ACPX manifest changed while read");
    const entries = parseNativeAcpxDistributionEntries(JSON.parse(bytes.toString("utf8")), input.expectedClosureSha256);
    if (!entries.some(entry => entry.path === input.executable && entry.executable && entry.size > 0) || (input.entrypoint !== undefined && !entries.some(entry => entry.path === input.entrypoint && entry.size > 0))) throw new Error("Native ACPX executable or entrypoint is absent from its closure");
    if (input.copilotDistributionDirectory !== undefined && !entries.some(entry => entry.path === `${input.copilotDistributionDirectory}/index.js` && entry.size > 0)) throw new Error("Copilot owned entrypoint is absent from its closure");
    return entries;
  } finally { await file.close(); }
}

/**
 * Freeze only manifest-admitted bytes. Native trees deliberately have a separate
 * bound; the tighter JavaScript/npm snapshot limits remain unchanged.
 */
export async function createNativeAcpxDistributionSnapshot(input: NativeAcpxDistributionInput, entries: NativeAcpxDistributionEntry[], signal?: AbortSignal): Promise<NativeAcpxDistributionSnapshot> {
  signal?.throwIfAborted();
  // Callers cannot substitute entries between manifest validation and copying.
  entries = parseNativeAcpxDistributionEntries({ entries }, input.expectedClosureSha256);
  if (process.platform !== "linux" && process.platform !== "darwin") throw new Error("Native ACPX snapshots require Linux or macOS");
  const source = await realpath(input.distributionRoot);
  const rootBefore = await lstat(source, { bigint: true });
  if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) throw new Error("Native ACPX distribution must be a directory");
  const heldRoot = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  const privateRoot = await realpath(await mkdtemp(join(tmpdir(), "paperclip-acpx-native-")));
  const packageRoot = join(privateRoot, "distribution");
  const cacheRoot = join(privateRoot, "state");
  const directories = new Set([privateRoot, packageRoot]);
  const digests: Record<string, string> = {};
  const close = async () => {
    for (const path of directories) await chmod(path, 0o700).catch(() => undefined);
    await rm(privateRoot, { recursive: true, force: true });
  };
  let commandDirectory: FileHandle | undefined;
  try {
    signal?.throwIfAborted();
    if (!same(rootBefore, await heldRoot.stat({ bigint: true }))) throw new Error("Native ACPX distribution root changed before snapshot");
    await mkdir(packageRoot, { mode: 0o700 });
    if (input.isolatedCacheEnvironmentName) await mkdir(cacheRoot, { mode: 0o700 });
    // Build each private parent once. Level ordering prevents child creation
    // from racing its parent; batches bound work and drain before any cleanup.
    const parentLevels = new Map<number, Set<string>>();
    let previousParts: string[] = [];
    const parentPaths = [packageRoot];
    for (const entry of entries) {
      const parts = entry.path.split("/");
      let shared = 0;
      // Canonical sorted paths keep each parent prefix contiguous. Reuse the
      // previous entry's joined parents instead of rebuilding every prefix.
      while (shared < parts.length - 1 && shared < previousParts.length - 1 && parts[shared] === previousParts[shared]) shared++;
      parentPaths.length = shared + 1;
      for (let depth = shared + 1; depth < parts.length; depth++) {
        const path = join(parentPaths[depth - 1]!, parts[depth - 1]!);
        parentPaths.push(path);
        const level = parentLevels.get(depth) ?? new Set<string>();
        level.add(path); parentLevels.set(depth, level); directories.add(path);
      }
      previousParts = parts;
    }
    const directoryBatch = async (paths: string[], operation: (path: string) => Promise<unknown>): Promise<void> => {
      for (let start = 0; start < paths.length; start += NATIVE_DIRECTORY_CONCURRENCY) {
        signal?.throwIfAborted();
        const settled = await Promise.allSettled(paths.slice(start, start + NATIVE_DIRECTORY_CONCURRENCY).map(operation));
        const failed = settled.find(result => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
        signal?.throwIfAborted();
      }
    };
    for (const depth of [...parentLevels.keys()].sort((a, b) => a - b)) {
      await directoryBatch([...parentLevels.get(depth)!].sort(), path => mkdir(path, { mode: 0o700 }));
    }
    const copyEntry = async (entry: NativeAcpxDistributionEntry): Promise<void> => {
      signal?.throwIfAborted();
      const path = join(source, ...entry.path.split("/"));
      if (await realpath(path) !== path) throw new Error("Native ACPX closure contains a symbolic link");
      // Bind metadata to the descriptor we will read, without a redundant
      // pathname stat. NONBLOCK prevents a raced-in FIFO from blocking open;
      // only a bounded regular single-link file may reach the read below.
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = await file.stat({ bigint: true });
        if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(entry.size) || Boolean(before.mode & 0o111n) !== entry.executable) throw new Error("Native ACPX closure file identity is invalid");
        const bytes = Buffer.alloc(entry.size);
        let offset = 0;
        while (offset < bytes.length) {
          signal?.throwIfAborted();
          const read = await file.read(bytes, offset, bytes.length - offset, offset);
          if (read.bytesRead === 0) throw new Error("Native ACPX closure file ended during snapshot");
          offset += read.bytesRead;
        }
        if (!same(before, await file.stat({ bigint: true })) || !same(before, await lstat(path, { bigint: true })) || await realpath(path) !== path) throw new Error("Native ACPX closure file changed while read");
        if (sha256(bytes) !== entry.sha256) throw new Error(`Native ACPX closure file digest mismatch: ${entry.path}`);
        const target = join(packageRoot, ...entry.path.split("/"));
        signal?.throwIfAborted();
        await writeFile(target, bytes, { mode: entry.executable ? 0o500 : 0o400, flag: "wx" });
      } finally { await file.close(); }
    };
    // Keep bounded capacity occupied when one file is slower than its peers.
    // Every task catches its rejection before releasing capacity; once failed,
    // no new copy is admitted and all owned descriptors drain before cleanup.
    const active = new Set<Promise<void>>();
    let activeBytes = 0;
    let failed = false;
    let failure: unknown;
    // Only the admission loop waits for capacity. Notify that waiter once per
    // completion instead of attaching Promise.race handlers to every active
    // copy on each admission (including long-lived large-file reads).
    let capacityAvailable: (() => void) | undefined;
    for (const entry of entries) {
      // An aborted acquisition must still drain its admitted reads before
      // deleting the partial tree. Stop scheduling copies at the same bound
      // used for any observed copy failure.
      if (signal?.aborted && !failed) { failed = true; failure = signal.reason; }
      while (!failed && (active.size >= NATIVE_COPY_CONCURRENCY
        || (active.size > 0 && activeBytes + entry.size > NATIVE_COPY_BUFFER_BYTES))) {
        await new Promise<void>(resolve => { capacityAvailable = resolve; });
        if (signal?.aborted && !failed) { failed = true; failure = signal.reason; }
      }
      if (failed) break;
      activeBytes += entry.size;
      const copying = copyEntry(entry).catch(error => {
        if (!failed) { failed = true; failure = error; }
      }).finally(() => {
        activeBytes -= entry.size;
        active.delete(copying);
        const notify = capacityAvailable;
        capacityAvailable = undefined;
        notify?.();
      });
      active.add(copying);
    }
    await Promise.all(active);
    if (failed) throw failure;
    signal?.throwIfAborted();
    // Completion order must not change the module guard or manifest.
    for (const entry of entries) digests[join(packageRoot, ...entry.path.split("/"))] = entry.sha256;
    if (!same(rootBefore, await heldRoot.stat({ bigint: true })) || !same(rootBefore, await lstat(source, { bigint: true }))) throw new Error("Native ACPX distribution root changed during snapshot");
    const executable = join(packageRoot, ...input.executable.split("/"));
    const args = [...(input.entrypoint === undefined ? [] : ["--require", join(packageRoot, GUARD), join(packageRoot, ...input.entrypoint.split("/"))]), ...input.fixedArguments];
    let copilotEntryDirectory: string | undefined;
    if (input.copilotDistributionDirectory !== undefined) {
      copilotEntryDirectory = join(packageRoot, COPILOT_ENTRY);
      await mkdir(copilotEntryDirectory, { mode: 0o700 }); directories.add(copilotEntryDirectory);
      const shim = Buffer.from([
        `require(${JSON.stringify(join(packageRoot, GUARD))});`,
        `import(require("node:url").pathToFileURL(${JSON.stringify(join(packageRoot, input.copilotDistributionDirectory, "index.js"))}).href).catch(error=>{console.error(error);process.exitCode=1;});`,
      ].join("\n"));
      const shimPath = join(copilotEntryDirectory, "index.js");
      await writeFile(shimPath, shim, { mode: 0o400, flag: "wx" }); digests[shimPath] = sha256(shim);
    }
    if (input.entrypoint !== undefined || copilotEntryDirectory !== undefined) {
      const guard = Buffer.from(nativeModuleGuard(digests));
      await writeFile(join(packageRoot, GUARD), guard, { mode: 0o400, flag: "wx" });
      digests[join(packageRoot, GUARD)] = sha256(guard);
    }
    const bootstrap = Buffer.from(nativeBootstrap(executable, digests[executable]!, args, input.isolatedCacheEnvironmentName ? { name: input.isolatedCacheEnvironmentName, value: cacheRoot } : undefined, copilotEntryDirectory));
    await writeFile(join(packageRoot, BOOTSTRAP), bootstrap, { mode: 0o400, flag: "wx" });
    digests[join(packageRoot, BOOTSTRAP)] = sha256(bootstrap);
    // executable is null: commandLease's separately-qualified provider runtime
    // slot is unused; this distribution is spawned by the trusted bootstrap.
    const manifest = Buffer.from(JSON.stringify({ roots: [packageRoot], executable: null, digests }));
    const manifestPath = join(privateRoot, "manifest.json");
    await writeFile(manifestPath, manifest, { mode: 0o400, flag: "wx" });
    await directoryBatch([...directories], path => chmod(path, 0o500));
    commandDirectory = await open(packageRoot, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    return { commandDirectory, bootstrap, snapshot: { roots: [packageRoot], executable: null, digests, handoff: { path: manifestPath, digest: sha256(manifest) }, close } };
  } catch (error) {
    await commandDirectory?.close(); await close(); throw error;
  } finally { await heldRoot.close(); }
}

function nativeBootstrap(executable: string, executableDigest: string, args: string[], cache?: { name: string; value: string }, copilotEntryDirectory?: string): string {
  return [
    'const {spawn}=require("node:child_process");',
    'const fs=require("node:fs");',
    // The commandLease's guarded bootstrap owns FDs 5 (guardian), 6 (exit),
    // 7/8 (credential fences). Keep them open in the native process too.
    'const guarded=process.env.PAPERCLIP_ACPX_NATIVE_GUARDED==="1";',
    'const env={...process.env}; delete env.PAPERCLIP_ACPX_NATIVE_GUARDED; delete env.PAPERCLIP_ACPX_PRIVATE_SNAPSHOT; delete env.PAPERCLIP_VERIFIED_RUNTIME_EXECUTABLE;',
    'env.NODE_DISABLE_COMPILE_CACHE="1"; delete env.NODE_COMPILE_CACHE;',
    ...(cache ? [`env[${JSON.stringify(cache.name)}]=${JSON.stringify(cache.value)};`] : []),
    ...(copilotEntryDirectory ? [
      // Never permit the native loader to choose a different cached version,
      // app, bootstrap mode or module path supplied by a workspace/caller.
      'for(const name of ["COPILOT_CLI_VERSION","COPILOT_CLI_DIST_DIR","COPILOT_CLI_RESOLVED_DIST_DIR","COPILOT_VOICE_SERVER_MODE","COPILOT_SHUTDOWN_FLUSH","NODE_OPTIONS","NODE_PATH"])delete env[name];',
      `env.COPILOT_CLI_DIST_DIR=${JSON.stringify(copilotEntryDirectory)};`,
    ] : []),
    'if(guarded)for(const fd of [5,6,7,8])fs.fstatSync(fd);',
    `const executable=${JSON.stringify(executable)};const fd=fs.openSync(executable,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);`,
    `if(require("node:crypto").createHash("sha256").update(fs.readFileSync(fd)).digest("hex")!==${JSON.stringify(executableDigest)})throw new Error("Native ACPX executable changed before spawn");`,
    'const stdio=guarded?[0,1,2,5,6,7,8]:[0,1,2]; const childExecutable=process.platform==="linux"?"/proc/self/fd/"+stdio.length:executable;stdio.push(fd);',
    `const child=spawn(childExecutable,${JSON.stringify(args)},{env,cwd:process.cwd(),shell:false,detached:false,stdio});fs.closeSync(fd);`,
    'child.once("error",()=>process.exit(1)); child.once("exit",(code,signal)=>process.exit(signal?1:code??1));',
    'for(const signal of ["SIGTERM","SIGINT","SIGHUP"])process.on(signal,()=>child.kill(signal));',
  ].join("\n");
}

function nativeModuleGuard(digests: Record<string, string>): string {
  return [
    'const {registerHooks,isBuiltin}=require("node:module");',
    'const {readFileSync,realpathSync}=require("node:fs");',
    'const {fileURLToPath}=require("node:url"); const {createHash}=require("node:crypto");',
    `const digests=${JSON.stringify(digests)};`,
    'const verify=url=>{if(!url.startsWith("file:"))throw new Error("Native ACPX module must be a qualified file or builtin");const path=fileURLToPath(url);if(realpathSync(path)!==path||!Object.hasOwn(digests,path))throw new Error("Native ACPX module escaped its closed distribution");const bytes=readFileSync(path);if(createHash("sha256").update(bytes).digest("hex")!==digests[path])throw new Error("Native ACPX module digest mismatch");return bytes;};',
    'registerHooks({resolve(specifier,context,next){const result=next(specifier,context);if(!isBuiltin(specifier)&&!result.url.startsWith("node:"))verify(result.url);return result;},load(url,context,next){if(url.startsWith("node:"))return next(url,context);const bytes=verify(url);if(["module","commonjs","json"].includes(context.format))return {format:context.format,source:bytes,shortCircuit:true};return next(url,context);}});',
  ].join("\n");
}

function same(a: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }, b: typeof a): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
