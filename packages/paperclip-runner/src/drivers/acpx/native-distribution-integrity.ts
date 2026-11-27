import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
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
  /**
   * The provider whose pinned closure this is (for example `antigravity`). When
   * set, a launch retires this provider's sealed stores for closures it no
   * longer pins, once no live runner process holds them.
   */
  storeFamily?: string;
}
export interface NativeAcpxDistributionSnapshot {
  snapshot: AcpxPrivateSnapshot;
  commandDirectory: FileHandle;
  bootstrap: Buffer;
  /** Sealed, runner-owned verified copy of the admitted closure. */
  distributionRoot: string;
}

const MAX_NATIVE_TREE_BYTES = 1024 * 1024 * 1024;
// Antigravity's Linux ACP server is a ~722 MB launcher with its Python archive.
const MAX_NATIVE_FILE_BYTES = 768 * 1024 * 1024;
const MAX_NATIVE_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_NATIVE_RECORD_BYTES = 16 * 1024 * 1024;
// Bound file descriptors and buffers. Files stream through fixed-size chunks,
// so even the largest admitted file holds at most one chunk in memory.
const NATIVE_COPY_CONCURRENCY = 32;
const NATIVE_DIRECTORY_CONCURRENCY = 32;
const NATIVE_COPY_BUFFER_BYTES = 32 * 1024 * 1024;
const NATIVE_COPY_CHUNK_BYTES = 4 * 1024 * 1024;
const NATIVE_STAT_CONCURRENCY = 64;
const BOOTSTRAP = ".paperclip-native-entry.cjs";
const GUARD = ".paperclip-native-module-guard.cjs";
const COPILOT_ENTRY = ".paperclip-copilot-entry";
const STORE_RECORD = "verified.json";
const STORE_SCHEMA = "paperclip.native-acpx-verified-store.v1";
const SOURCE_SCHEMA = "paperclip.native-acpx-verified-source.v1";
export const NATIVE_ACPX_BOOTSTRAP_NAME = BOOTSTRAP;
/** Optional absolute directory for the runner-owned verified closure store. */
export const NATIVE_ACPX_STORE_ROOT_ENV = "PAPERCLIP_ACPX_NATIVE_STORE_ROOT";
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

type FileIdentity = { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint };
type IdentityRecord = [string, string, string, string, string];
const identityRecord = (value: FileIdentity): IdentityRecord => [String(value.dev), String(value.ino), String(value.size), String(value.mtimeNs), String(value.ctimeNs)];
const identityMatches = (value: FileIdentity, recorded: unknown): boolean => Array.isArray(recorded) && recorded.length === 5
  && identityRecord(value).every((part, index) => part === recorded[index]);
const runnerUid = () => BigInt(process.getuid!());
const entryPath = (root: string, entry: { path: string }) => join(root, ...entry.path.split("/"));
/**
 * Fallback store used only when the per-uid store root is unsafe. It lives
 * while a launch uses it and is removed with the last one.
 */
type PrivateStore = { root: Promise<string>; users: number };
let processPrivateStore: PrivateStore | undefined;
let reportedPrivateStoreFallback = false;

/**
 * Admit a native closure for one launch.
 *
 * The admitted bytes are verified once per closure into a runner-owned, sealed
 * store (`<store>/<closure>/distribution`, 0500 directories, 0400/0500 files,
 * single-link, owned by the runner uid). Every launch then binds the store by
 * the kernel identity (dev, inode, size, mtime, ctime) recorded right after its
 * bytes were hashed. Content cannot change without a write, which requires a
 * chmod of the sealed file and moves its ctime, so an unchanged identity proves
 * unchanged bytes without re-reading them. A store that fails this check is
 * retired and rebuilt from a fresh full verification.
 *
 * The installed source keeps its own recorded identity. A changed source is
 * re-hashed in place before launch, so a later corrupt install is still refused
 * even though launches execute the verified store.
 *
 * Each launch gets only a small private directory for its trusted bootstrap,
 * Node module guard, Copilot shim and cache.
 *
 * The recorded identities are not a trust anchor against a process running as
 * the runner's user: such a process can unseal the store and rewrite both a
 * file and its record. Code that runs is therefore still checked against the
 * pinned manifest at use: the bootstrap streams the executable descriptor it
 * spawns through SHA-256, and the module guard hashes every Node module it
 * loads. The store removes the per-launch copy, not those checks.
 */
export async function createNativeAcpxDistributionSnapshot(input: NativeAcpxDistributionInput, entries: NativeAcpxDistributionEntry[], signal?: AbortSignal): Promise<NativeAcpxDistributionSnapshot> {
  signal?.throwIfAborted();
  // Callers cannot substitute entries between manifest validation and copying.
  entries = parseNativeAcpxDistributionEntries({ entries }, input.expectedClosureSha256);
  if (process.platform !== "linux" && process.platform !== "darwin") throw new Error("Native ACPX snapshots require Linux or macOS");
  const source = await realpath(input.distributionRoot);
  const resolved = await resolveNativeStoreRoot();
  try {
    const launch = await admitFromVerifiedStore(input, entries, source, resolved.root, signal);
    if (resolved.privateStore === undefined) return launch;
    const privateStore = resolved.privateStore;
    const closeLaunch = launch.snapshot.close;
    // A failed cleanup stays retryable, and the store is released only once
    // the launch directory is actually gone.
    let closing: Promise<void> | undefined;
    let released = false;
    launch.snapshot.close = () => closing ??= closeLaunch().then(async () => {
      if (released) return;
      released = true;
      await releasePrivateStore(privateStore);
    }, error => {
      closing = undefined;
      throw error;
    });
    return launch;
  } catch (error) {
    if (resolved.privateStore !== undefined) await releasePrivateStore(resolved.privateStore);
    throw error;
  }
}

async function admitFromVerifiedStore(input: NativeAcpxDistributionInput, entries: NativeAcpxDistributionEntry[], source: string, storeRoot: string, signal?: AbortSignal): Promise<NativeAcpxDistributionSnapshot> {
  const storeDirectory = join(storeRoot, input.expectedClosureSha256);
  // The lease is taken before the store is read, so a concurrent prune either
  // sees it and keeps the store, or finishes retiring it before this reads.
  if (input.storeFamily !== undefined) await holdVerifiedStore(storeRoot, input.expectedClosureSha256, input.storeFamily);
  let identities = await readVerifiedStore(storeDirectory, entries);
  if (identities === "invalid") {
    await retireVerifiedStore(storeRoot, storeDirectory);
    identities = "missing";
  }
  let sourceVerified = false;
  for (let attempt = 0; identities === "missing"; attempt++) {
    if (attempt === 3) throw new Error("Native ACPX verified store could not be established");
    const observed = await materializeVerifiedStore(source, storeRoot, storeDirectory, entries, signal);
    if (observed !== null) {
      await writeSourceRecord(storeRoot, input.expectedClosureSha256, source, observed);
      sourceVerified = true;
    }
    identities = await readVerifiedStore(storeDirectory, entries);
    if (identities === "invalid") throw new Error("Native ACPX verified store failed its identity check");
  }
  if (!sourceVerified && !await sourceUnchanged(storeRoot, input.expectedClosureSha256, source, entries)) {
    await writeSourceRecord(storeRoot, input.expectedClosureSha256, source, await verifyNativeSource(source, entries, signal));
  }
  signal?.throwIfAborted();
  const launch = await createNativeLaunch(input, entries, join(storeDirectory, "distribution"));
  // Retiring superseded closures never delays this launch.
  if (input.storeFamily !== undefined) scheduleNativeAcpxStorePrune(storeRoot, input.storeFamily, input.expectedClosureSha256);
  return launch;
}

const validStoreFamily = (value: string) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
const heldStores = new Set<string>();
const scheduledPrunes = new Map<string, Promise<string[]>>();

// A prune holds its marker only while it parks one store and removes two small
// records. A launch waits for that, never for the parked tree's deletion.
const PRUNE_MARKER_WAIT_MS = 10_000;
const PRUNE_MARKER_POLL_MS = 5;

/**
 * Mark a store as used by this runner process and record its provider. The
 * lease names the process, so a store stays while any live runner holds it,
 * including an older release still finishing its runs during a deploy.
 *
 * Leases and prunes exclude each other across processes without a lock: a
 * launch writes its lease and then looks for a prune marker; a prune writes its
 * marker and then looks for leases. Whichever writes second sees the other. A
 * launch that sees a live prune waits for it to finish, so it reads either the
 * kept store or none, and writes its records after the prune removed the
 * retired ones.
 */
async function holdVerifiedStore(storeRoot: string, closure: string, family: string): Promise<void> {
  if (!validStoreFamily(family)) throw new Error("Native ACPX store family is invalid");
  const key = `${storeRoot}\0${closure}`;
  if (heldStores.has(key)) return;
  await writeFile(join(storeRoot, `${closure}.lease-${process.pid}`), "", { mode: 0o600 });
  await awaitNoLivePrune(storeRoot, closure);
  await writeFile(join(storeRoot, `${closure}.family`), family, { mode: 0o600 });
  heldStores.add(key);
}

/**
 * True while a live process holds a prune marker for `closure`. Markers of
 * exited processes (a runner killed mid-prune) are removed, so they never
 * block a later launch or prune. Like leases, a marker names its process id.
 */
async function livePruneMarker(storeRoot: string, closure: string): Promise<boolean> {
  const pattern = new RegExp(`^${closure}\\.pruning-(\\d{1,10})$`);
  let pruning = false;
  for (const name of await readdir(storeRoot)) {
    const pid = pattern.exec(name)?.[1];
    if (pid === undefined) continue;
    if (processAlive(Number(pid))) pruning = true;
    else await rm(join(storeRoot, name), { force: true });
  }
  return pruning;
}

async function awaitNoLivePrune(storeRoot: string, closure: string): Promise<void> {
  const deadline = Date.now() + PRUNE_MARKER_WAIT_MS;
  // A stuck prune never blocks a launch: past the deadline this proceeds and
  // the store is read, or verified again, as usual.
  while (await livePruneMarker(storeRoot, closure) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, PRUNE_MARKER_POLL_MS));
  }
}

function scheduleNativeAcpxStorePrune(storeRoot: string, family: string, keepClosure: string): void {
  const key = `${storeRoot}\0${family}\0${keepClosure}`;
  if (scheduledPrunes.has(key)) return;
  scheduledPrunes.set(key, pruneNativeAcpxStores(storeRoot, family, keepClosure).catch(() => []));
}

/** Test seam: the background prune a launch scheduled, if any. */
export function scheduledNativeAcpxStorePrune(family: string, keepClosure: string): Promise<string[]> | undefined {
  for (const [key, prune] of scheduledPrunes) if (key.endsWith(`\0${family}\0${keepClosure}`)) return prune;
  return undefined;
}

const processAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
};

/** Live runner processes holding `closure`; stale leases of exited processes are removed. */
async function liveStoreHolders(storeRoot: string, closure: string, names: readonly string[]): Promise<number> {
  let live = 0;
  for (const name of names) {
    const match = new RegExp(`^${closure}\\.lease-(\\d{1,10})$`).exec(name);
    if (!match) continue;
    if (processAlive(Number(match[1]))) live++;
    else await rm(join(storeRoot, name), { force: true });
  }
  return live;
}

/**
 * Remove `family`'s sealed stores whose closure is not `keepClosure` and that
 * no live runner process holds. Stores of other providers, unmarked stores and
 * the kept closure are never touched. Returns the retired closures.
 *
 * Each retirement runs under a per-closure prune marker (see
 * `holdVerifiedStore`): the store is parked and its records removed only when
 * no live lease exists after the marker is written. The parked tree is removed
 * on every path, and trees an exited runner left behind are removed here.
 */
export async function pruneNativeAcpxStores(storeRoot: string, family: string, keepClosure: string): Promise<string[]> {
  if (!validStoreFamily(family) || !/^[a-f0-9]{64}$/.test(keepClosure)) return [];
  await removeAbandonedStoreTrees(storeRoot);
  const retired: string[] = [];
  for (const name of await readdir(storeRoot)) {
    const closure = /^([a-f0-9]{64})\.family$/.exec(name)?.[1];
    if (!closure || closure === keepClosure) continue;
    if (await readFile(join(storeRoot, name), "utf8").catch(() => null) !== family) continue;
    if (await liveStoreHolders(storeRoot, closure, await readdir(storeRoot)) > 0) continue;
    if (await retireUnheldStore(storeRoot, closure)) retired.push(closure);
  }
  return retired;
}

async function retireUnheldStore(storeRoot: string, closure: string): Promise<boolean> {
  const marker = join(storeRoot, `${closure}.pruning-${process.pid}`);
  // Another live prune of this closure owns it; an exited one's marker is removed here.
  if (await livePruneMarker(storeRoot, closure)) return false;
  try { await writeFile(marker, "", { mode: 0o600, flag: "wx" }); } catch { return false; }
  let parked: string | undefined;
  try {
    // A launch that wrote its lease before this marker is seen here; one that
    // writes it later sees the marker and waits until this returns.
    if (await liveStoreHolders(storeRoot, closure, await readdir(storeRoot)) > 0) return false;
    parked = join(storeRoot, `.retiring-${process.pid}-${randomUUID()}`);
    try { await renameSealedDirectory(join(storeRoot, closure), parked); } catch (error) {
      parked = undefined;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    await rm(join(storeRoot, `${closure}.source.json`), { force: true });
    await rm(join(storeRoot, `${closure}.family`), { force: true });
    return true;
  } finally {
    await rm(marker, { force: true });
    if (parked !== undefined) await removeSealedTree(parked).catch(() => undefined);
  }
}

/** Staging, retired and parked trees of runner processes that have exited. */
async function removeAbandonedStoreTrees(storeRoot: string): Promise<void> {
  for (const name of await readdir(storeRoot)) {
    const pid = /^\.(?:staging|retired|retiring)-(\d{1,10})-/.exec(name)?.[1];
    if (pid !== undefined && !processAlive(Number(pid))) await removeSealedTree(join(storeRoot, name)).catch(() => undefined);
  }
}

/**
 * Rename a store directory. Some macOS releases refuse to rename a directory
 * its owner cannot write, so the directory is unsealed for the move.
 */
async function renameSealedDirectory(from: string, to: string): Promise<void> {
  await chmod(from, 0o700);
  try { await rename(from, to); } catch (error) {
    await chmod(from, 0o500).catch(() => undefined);
    throw error;
  }
}

/** Raised when the operator-configured store root cannot be used safely. */
export class NativeAcpxStoreRootError extends Error {
  readonly code = "ACPX_NATIVE_STORE_ROOT_UNSAFE";
  constructor() {
    super(`${NATIVE_ACPX_STORE_ROOT_ENV} must name an absolute directory owned by the runner user and closed to other users (mode 0700). Fix the directory or unset the variable.`);
    this.name = "NativeAcpxStoreRootError";
  }
}

async function usableStoreRoot(root: string): Promise<string | undefined> {
  if (!isAbsolute(root) || root.includes("\0")) return undefined;
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (await isPrivateDirectory(root)) return await realpath(root);
  } catch { /* unusable */ }
  return undefined;
}

/**
 * Runner-owned private store root. An operator-configured root that is unsafe
 * fails closed. When the default per-uid root is unsafe (for example squatted
 * by another user), launches use a process-private store, report it once, and
 * remove it when the last launch using it closes.
 */
async function resolveNativeStoreRoot(): Promise<{ root: string; privateStore?: PrivateStore }> {
  const configured = process.env[NATIVE_ACPX_STORE_ROOT_ENV];
  if (configured) {
    const root = await usableStoreRoot(configured);
    if (root === undefined) throw new NativeAcpxStoreRootError();
    return { root };
  }
  const root = await usableStoreRoot(join(tmpdir(), `paperclip-verified-native-${process.getuid!()}`));
  if (root !== undefined) return { root };
  // A squatted shared path must not block launches or reuse foreign bytes.
  if (!reportedPrivateStoreFallback) {
    reportedPrivateStoreFallback = true;
    process.emitWarning(JSON.stringify({ schema: "paperclip.runner.native_store_fallback.v1", reason: "default_store_root_not_private" }),
      { code: "PAPERCLIP_ACPX_NATIVE_STORE_FALLBACK", type: "PaperclipRunnerStoreWarning" });
  }
  const privateStore = processPrivateStore ??= { root: mkdtemp(join(tmpdir(), "paperclip-verified-native-")).then(path => realpath(path)), users: 0 };
  privateStore.users++;
  try { return { root: await privateStore.root, privateStore }; } catch (error) {
    await releasePrivateStore(privateStore);
    throw error;
  }
}

async function releasePrivateStore(store: PrivateStore): Promise<void> {
  if (--store.users > 0) return;
  if (processPrivateStore === store) processPrivateStore = undefined;
  const root = await store.root.catch(() => undefined);
  if (root !== undefined) await removeSealedTree(root).catch(() => undefined);
}

async function isPrivateDirectory(path: string): Promise<boolean> {
  const info = await lstat(path, { bigint: true });
  return info.isDirectory() && !info.isSymbolicLink() && info.uid === runnerUid() && (info.mode & 0o077n) === 0n;
}

async function boundedEach<T>(items: readonly T[], concurrency: number, operation: (item: T, index: number) => Promise<void>): Promise<void> {
  for (let start = 0; start < items.length; start += concurrency) {
    const settled = await Promise.allSettled(items.slice(start, start + concurrency).map((item, offset) => operation(item, start + offset)));
    const failed = settled.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
}

/** Identities recorded at verification time, "missing" when absent, "invalid" when anything differs. */
async function readVerifiedStore(storeDirectory: string, entries: NativeAcpxDistributionEntry[]): Promise<IdentityRecord[] | "missing" | "invalid"> {
  try { await lstat(storeDirectory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  try {
    if (!await isPrivateDirectory(storeDirectory)) return "invalid";
    const recordFile = await open(join(storeDirectory, STORE_RECORD), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let record: { schema?: unknown; entries?: unknown };
    try {
      const info = await recordFile.stat({ bigint: true });
      if (!info.isFile() || info.uid !== runnerUid() || (info.mode & 0o222n) !== 0n || info.size > BigInt(MAX_NATIVE_RECORD_BYTES)) return "invalid";
      record = JSON.parse((await recordFile.readFile()).toString("utf8"));
    } finally { await recordFile.close(); }
    const recorded = record.entries;
    if (record.schema !== STORE_SCHEMA || !Array.isArray(recorded) || recorded.length !== entries.length) return "invalid";
    const identities: IdentityRecord[] = [];
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!; const value = recorded[index] as Record<string, unknown> | null;
      if (value === null || typeof value !== "object" || value.path !== entry.path || value.sha256 !== entry.sha256 || value.size !== entry.size
        || value.executable !== entry.executable || !Array.isArray(value.identity) || value.identity.length !== 5 || value.identity.some(part => typeof part !== "string")) return "invalid";
      identities.push(value.identity as IdentityRecord);
    }
    const distribution = join(storeDirectory, "distribution");
    let intact = true;
    await boundedEach(entries, NATIVE_STAT_CONCURRENCY, async (entry, index) => {
      const info = await lstat(entryPath(distribution, entry), { bigint: true });
      if (!info.isFile() || info.nlink !== 1n || info.uid !== runnerUid() || (info.mode & 0o7777n) !== (entry.executable ? 0o500n : 0o400n)
        || !identityMatches(info, identities[index])) intact = false;
    });
    // The store's guard is small and fully derivable, so it is compared byte
    // for byte on every launch rather than trusted from the record.
    return intact && await storeGuardIntact(join(distribution, GUARD), storeModuleGuard(distribution, entries)) ? identities : "invalid";
  } catch {
    return "invalid";
  }
}

function storeModuleGuard(distribution: string, entries: NativeAcpxDistributionEntry[]): Buffer {
  const digests: Record<string, string> = {};
  for (const entry of entries) digests[entryPath(distribution, entry)] = entry.sha256;
  return Buffer.from(nativeModuleGuard(digests));
}

async function storeGuardIntact(path: string, expected: Buffer): Promise<boolean> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat({ bigint: true });
    if (!info.isFile() || info.nlink !== 1n || info.uid !== runnerUid() || (info.mode & 0o7777n) !== 0o400n || info.size !== BigInt(expected.length)) return false;
    return (await file.readFile()).equals(expected);
  } finally { await file.close(); }
}

async function retireVerifiedStore(storeRoot: string, storeDirectory: string): Promise<void> {
  const retired = join(storeRoot, `.retired-${process.pid}-${randomUUID()}`);
  try { await renameSealedDirectory(storeDirectory, retired); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await removeSealedTree(retired).catch(() => undefined);
}

async function removeSealedTree(root: string): Promise<void> {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    await chmod(directory, 0o700).catch(() => undefined);
    for (const child of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (child.isDirectory()) pending.push(join(directory, child.name));
    }
  }
  await rm(root, { recursive: true, force: true });
}

/**
 * Hash one admitted file through a held descriptor and optionally stream the
 * same chunks into the verified store. NONBLOCK prevents a raced-in FIFO from
 * blocking open; only a bounded regular single-link file reaches the read.
 */
async function streamNativeEntry(path: string, entry: NativeAcpxDistributionEntry, target: string | null, signal?: AbortSignal): Promise<{ source: FileIdentity; target: FileIdentity | null }> {
  signal?.throwIfAborted();
  if (await realpath(path) !== path) throw new Error("Native ACPX closure contains a symbolic link");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let output: FileHandle | undefined;
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(entry.size) || Boolean(before.mode & 0o111n) !== entry.executable) throw new Error("Native ACPX closure file identity is invalid");
    const digest = createHash("sha256");
    const buffer = Buffer.alloc(Math.min(entry.size, NATIVE_COPY_CHUNK_BYTES));
    if (target !== null) output = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, entry.executable ? 0o500 : 0o400);
    let offset = 0;
    while (offset < entry.size) {
      signal?.throwIfAborted();
      const read = await file.read(buffer, 0, Math.min(buffer.length, entry.size - offset), offset);
      if (read.bytesRead === 0) throw new Error("Native ACPX closure file ended during snapshot");
      const chunk = buffer.subarray(0, read.bytesRead);
      digest.update(chunk);
      for (let written = 0; output !== undefined && written < chunk.length;) {
        written += (await output.write(chunk, written, chunk.length - written, offset + written)).bytesWritten;
      }
      offset += read.bytesRead;
    }
    if (!same(before, await file.stat({ bigint: true })) || !same(before, await lstat(path, { bigint: true })) || await realpath(path) !== path) throw new Error("Native ACPX closure file changed while read");
    if (digest.digest("hex") !== entry.sha256) throw new Error(`Native ACPX closure file digest mismatch: ${entry.path}`);
    if (output === undefined || target === null) return { source: before, target: null };
    // The process umask must not change the sealed mode later checks require.
    await output.chmod(entry.executable ? 0o500 : 0o400);
    await output.close(); output = undefined;
    return { source: before, target: await lstat(target, { bigint: true }) };
  } finally {
    await output?.close();
    await file.close();
  }
}

/**
 * Keep bounded capacity occupied when one file is slower than its peers. Every
 * task catches its rejection before releasing capacity; once failed (or
 * aborted), no new task is admitted and all owned descriptors drain first.
 */
async function streamNativeEntries<T>(entries: NativeAcpxDistributionEntry[], operation: (entry: NativeAcpxDistributionEntry, index: number) => Promise<T>, signal?: AbortSignal): Promise<T[]> {
  const results: T[] = new Array(entries.length);
  const active = new Set<Promise<void>>();
  let activeBytes = 0;
  let failed = false;
  let failure: unknown;
  // Only the admission loop waits for capacity; notify it once per completion.
  let capacityAvailable: (() => void) | undefined;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    const bytes = Math.min(entry.size, NATIVE_COPY_CHUNK_BYTES);
    if (signal?.aborted && !failed) { failed = true; failure = signal.reason; }
    while (!failed && (active.size >= NATIVE_COPY_CONCURRENCY || (active.size > 0 && activeBytes + bytes > NATIVE_COPY_BUFFER_BYTES))) {
      await new Promise<void>(resolve => { capacityAvailable = resolve; });
      if (signal?.aborted && !failed) { failed = true; failure = signal.reason; }
    }
    if (failed) break;
    activeBytes += bytes;
    const running = operation(entry, index).then(result => { results[index] = result; }, error => {
      if (!failed) { failed = true; failure = error; }
    }).finally(() => {
      activeBytes -= bytes;
      active.delete(running);
      const notify = capacityAvailable;
      capacityAvailable = undefined;
      notify?.();
    });
    active.add(running);
  }
  await Promise.all(active);
  if (failed) throw failure;
  signal?.throwIfAborted();
  return results;
}

async function withHeldSourceRoot<T>(source: string, operation: () => Promise<T>): Promise<T> {
  const rootBefore = await lstat(source, { bigint: true });
  if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) throw new Error("Native ACPX distribution must be a directory");
  const heldRoot = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try {
    if (!same(rootBefore, await heldRoot.stat({ bigint: true }))) throw new Error("Native ACPX distribution root changed before snapshot");
    const result = await operation();
    if (!same(rootBefore, await heldRoot.stat({ bigint: true })) || !same(rootBefore, await lstat(source, { bigint: true }))) throw new Error("Native ACPX distribution root changed during snapshot");
    return result;
  } finally { await heldRoot.close(); }
}

/** Re-hash a changed installed source in place; nothing is copied. */
async function verifyNativeSource(source: string, entries: NativeAcpxDistributionEntry[], signal?: AbortSignal): Promise<FileIdentity[]> {
  return await withHeldSourceRoot(source, async () => (await streamNativeEntries(entries,
    async entry => (await streamNativeEntry(entryPath(source, entry), entry, null, signal)).source, signal)));
}

/**
 * Build the sealed store in a private staging directory and publish it with one
 * rename. Returns the observed source identities, or null when a concurrent
 * launch published the same closure first.
 */
async function materializeVerifiedStore(source: string, storeRoot: string, storeDirectory: string, entries: NativeAcpxDistributionEntry[], signal?: AbortSignal): Promise<FileIdentity[] | null> {
  const staging = await realpath(await mkdtemp(join(storeRoot, `.staging-${process.pid}-`)));
  const packageRoot = join(staging, "distribution");
  const directories = [packageRoot];
  let published = false;
  try {
    const observed = await withHeldSourceRoot(source, async () => {
      signal?.throwIfAborted();
      await mkdir(packageRoot, { mode: 0o700 });
      // Build each private parent once. Level ordering prevents child creation
      // from racing its parent; batches bound work and drain before cleanup.
      const parentLevels = new Map<number, Set<string>>();
      let previousParts: string[] = [];
      const parentPaths = [packageRoot];
      for (const entry of entries) {
        const parts = entry.path.split("/");
        let shared = 0;
        // Canonical sorted paths keep each parent prefix contiguous.
        while (shared < parts.length - 1 && shared < previousParts.length - 1 && parts[shared] === previousParts[shared]) shared++;
        parentPaths.length = shared + 1;
        for (let depth = shared + 1; depth < parts.length; depth++) {
          const path = join(parentPaths[depth - 1]!, parts[depth - 1]!);
          parentPaths.push(path);
          const level = parentLevels.get(depth) ?? new Set<string>();
          level.add(path); parentLevels.set(depth, level); directories.push(path);
        }
        previousParts = parts;
      }
      for (const depth of [...parentLevels.keys()].sort((a, b) => a - b)) {
        signal?.throwIfAborted();
        await boundedEach([...parentLevels.get(depth)!].sort(), NATIVE_DIRECTORY_CONCURRENCY, path => mkdir(path, { mode: 0o700 }).then(() => undefined));
      }
      return await streamNativeEntries(entries, entry => streamNativeEntry(entryPath(source, entry), entry, entryPath(packageRoot, entry), signal), signal);
    });
    signal?.throwIfAborted();
    // Pinned entrypoints that start their own Node child (Pi's pi-entry.cjs)
    // pass it `__dirname/<guard>`. The guard is a pure function of the closure
    // and its final store path, so it is sealed into the store beside them.
    await writeFile(join(packageRoot, GUARD), storeModuleGuard(join(storeDirectory, "distribution"), entries), { mode: 0o400, flag: "wx" });
    await boundedEach(directories, NATIVE_DIRECTORY_CONCURRENCY, path => chmod(path, 0o500));
    const record = Buffer.from(JSON.stringify({ schema: STORE_SCHEMA, entries: entries.map((entry, index) => ({ ...entry, identity: identityRecord(observed[index]!.target!) })) }));
    await writeFile(join(staging, STORE_RECORD), record, { mode: 0o400, flag: "wx" });
    // Published while still writable: some macOS releases refuse to rename a
    // directory its owner cannot write. It is sealed right after the move.
    try {
      await rename(staging, storeDirectory);
      published = true;
    } catch (error) {
      if (await lstat(storeDirectory).then(() => true, () => false)) return null;
      throw error;
    }
    await chmod(storeDirectory, 0o500);
    return observed.map(result => result.source);
  } finally {
    if (!published) await removeSealedTree(staging);
  }
}

async function writeSourceRecord(storeRoot: string, closure: string, source: string, identities: FileIdentity[]): Promise<void> {
  const temporary = join(storeRoot, `.source-${randomUUID()}`);
  await writeFile(temporary, JSON.stringify({ schema: SOURCE_SCHEMA, closure, root: source, identities: identities.map(identityRecord) }), { mode: 0o600, flag: "wx" });
  try { await rename(temporary, join(storeRoot, `${closure}.source.json`)); } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** True only when every installed file still has the identity it had when last hashed. */
async function sourceUnchanged(storeRoot: string, closure: string, source: string, entries: NativeAcpxDistributionEntry[]): Promise<boolean> {
  try {
    const file = await open(join(storeRoot, `${closure}.source.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let record: { schema?: unknown; closure?: unknown; root?: unknown; identities?: unknown };
    try {
      const info = await file.stat({ bigint: true });
      if (!info.isFile() || info.uid !== runnerUid() || info.size > BigInt(MAX_NATIVE_RECORD_BYTES)) return false;
      record = JSON.parse((await file.readFile()).toString("utf8"));
    } finally { await file.close(); }
    if (record.schema !== SOURCE_SCHEMA || record.closure !== closure || record.root !== source || !Array.isArray(record.identities) || record.identities.length !== entries.length) return false;
    const identities = record.identities;
    let unchanged = true;
    await boundedEach(entries, NATIVE_STAT_CONCURRENCY, async (entry, index) => {
      const info = await lstat(entryPath(source, entry), { bigint: true });
      if (!info.isFile() || info.nlink !== 1n || Boolean(info.mode & 0o111n) !== entry.executable || !identityMatches(info, identities[index])) unchanged = false;
    });
    return unchanged;
  } catch {
    return false;
  }
}

/** Small private per-launch directory: bootstrap, module guard, Copilot shim, cache and handoff manifest. */
async function createNativeLaunch(input: NativeAcpxDistributionInput, entries: NativeAcpxDistributionEntry[], distributionRoot: string): Promise<NativeAcpxDistributionSnapshot> {
  const privateRoot = await realpath(await mkdtemp(join(tmpdir(), "paperclip-acpx-native-")));
  const launchRoot = join(privateRoot, "launch");
  const cacheRoot = join(privateRoot, "state");
  const directories = [privateRoot, launchRoot];
  const close = async () => {
    for (const path of directories) await chmod(path, 0o700).catch(() => undefined);
    await rm(privateRoot, { recursive: true, force: true });
  };
  let commandDirectory: FileHandle | undefined;
  try {
    await mkdir(launchRoot, { mode: 0o700 });
    if (input.isolatedCacheEnvironmentName) await mkdir(cacheRoot, { mode: 0o700 });
    // Canonical manifest order keeps the module guard and handoff stable.
    const digests: Record<string, string> = {};
    for (const entry of entries) digests[entryPath(distributionRoot, entry)] = entry.sha256;
    const executableIndex = entries.findIndex(entry => entry.path === input.executable && entry.executable);
    if (executableIndex < 0) throw new Error("Native ACPX executable is absent from its closure");
    const executable = entryPath(distributionRoot, entries[executableIndex]!);
    const args = [...(input.entrypoint === undefined ? [] : ["--require", join(launchRoot, GUARD), join(distributionRoot, ...input.entrypoint.split("/"))]), ...input.fixedArguments];
    let copilotEntryDirectory: string | undefined;
    if (input.copilotDistributionDirectory !== undefined) {
      copilotEntryDirectory = join(launchRoot, COPILOT_ENTRY);
      await mkdir(copilotEntryDirectory, { mode: 0o700 }); directories.push(copilotEntryDirectory);
      const shim = Buffer.from([
        `require(${JSON.stringify(join(launchRoot, GUARD))});`,
        `import(require("node:url").pathToFileURL(${JSON.stringify(join(distributionRoot, input.copilotDistributionDirectory, "index.js"))}).href).catch(error=>{console.error(error);process.exitCode=1;});`,
      ].join("\n"));
      const shimPath = join(copilotEntryDirectory, "index.js");
      await writeFile(shimPath, shim, { mode: 0o400, flag: "wx" }); digests[shimPath] = sha256(shim);
    }
    if (input.entrypoint !== undefined || copilotEntryDirectory !== undefined) {
      const guard = Buffer.from(nativeModuleGuard(digests));
      await writeFile(join(launchRoot, GUARD), guard, { mode: 0o400, flag: "wx" });
      digests[join(launchRoot, GUARD)] = sha256(guard);
    }
    const bootstrap = Buffer.from(nativeBootstrap(executable, entries[executableIndex]!.sha256, args, input.isolatedCacheEnvironmentName ? { name: input.isolatedCacheEnvironmentName, value: cacheRoot } : undefined, copilotEntryDirectory));
    await writeFile(join(launchRoot, BOOTSTRAP), bootstrap, { mode: 0o400, flag: "wx" });
    digests[join(launchRoot, BOOTSTRAP)] = sha256(bootstrap);
    // executable is null: commandLease's separately-qualified provider runtime
    // slot is unused; this distribution is spawned by the trusted bootstrap.
    const manifest = Buffer.from(JSON.stringify({ roots: [launchRoot], executable: null, digests }));
    const manifestPath = join(privateRoot, "manifest.json");
    await writeFile(manifestPath, manifest, { mode: 0o400, flag: "wx" });
    await boundedEach(directories, NATIVE_DIRECTORY_CONCURRENCY, path => chmod(path, 0o500));
    commandDirectory = await open(launchRoot, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    return { commandDirectory, bootstrap, distributionRoot, snapshot: { roots: [launchRoot], executable: null, digests, handoff: { path: manifestPath, digest: sha256(manifest) }, close } };
  } catch (error) {
    await commandDirectory?.close(); await close(); throw error;
  }
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
    // Hash the exact descriptor that is spawned against the pinned digest. The
    // store's recorded identity is not trusted for this: a same-user process
    // can rewrite it. Fixed 4 MiB chunks keep a large executable out of memory.
    'const opened=fs.fstatSync(fd,{bigint:true});if(!opened.isFile()||opened.nlink!==1n)throw new Error("Native ACPX executable changed before spawn");',
    'const executableHash=require("node:crypto").createHash("sha256");const chunk=Buffer.allocUnsafe(4194304);let offset=0;for(let read;(read=fs.readSync(fd,chunk,0,chunk.length,offset))>0;offset+=read)executableHash.update(chunk.subarray(0,read));',
    'const hashed=fs.fstatSync(fd,{bigint:true});',
    `if(BigInt(offset)!==opened.size||["dev","ino","size","mtimeNs","ctimeNs","nlink"].some(key=>hashed[key]!==opened[key])||executableHash.digest("hex")!==${JSON.stringify(executableDigest)})throw new Error("Native ACPX executable changed before spawn");`,
    'const stdio=guarded?[0,1,2,5,6,7,8]:[0,1,2]; const childExecutable=process.platform==="linux"?"/proc/self/fd/"+stdio.length:executable;stdio.push(fd);',
    `const child=spawn(childExecutable,${JSON.stringify(args)},{env,cwd:process.cwd(),shell:false,detached:false,stdio});fs.closeSync(fd);`,
    // A guarded Node launcher has a pending filesystem read on its guardian
    // pipe. process.exit can wait for that read while the guardian waits for
    // this launcher to exit. Retire the live owned group through the kernel;
    // no saved PID/group identity or provider JavaScript cleanup is required.
    'const retire=code=>{if(guarded){try{process.kill(0,"SIGKILL");}catch{process.kill(process.pid,"SIGKILL");}}else process.exit(code);};',
    'child.once("error",()=>retire(1)); child.once("exit",(code,signal)=>retire(signal?1:code??1));',
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
