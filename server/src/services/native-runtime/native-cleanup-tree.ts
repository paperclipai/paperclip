import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalNativeJson } from "./canonical.js";
import { sortedNativeHarnessNames, syncNativeHarnessDirectory } from "./native-harness-tree.js";

interface Entry {
  path: string; directory: boolean; dev: number; ino: number; size: number;
  mtimeMs: number; ctimeMs: number; sha256?: string;
}
const denied = () => new Error("native_cleanup_maintenance_unproven");
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function unchanged(a: Awaited<ReturnType<typeof lstat>>, b: Awaited<ReturnType<typeof lstat>>): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.size === b.size && a.mode === b.mode;
}

/** Exact retained-format scan. Only one bounded file buffer and a bounded
 * external-sort page are resident; neither entries nor file bodies accumulate. */
async function* entries(home: string, content: boolean, exclude: readonly string[], relative = "", depth = 0): AsyncGenerator<Entry> {
  if (depth > 128) throw denied();
  const path = resolve(home, relative), before = await lstat(path);
  if (before.isSymbolicLink() || (!before.isFile() && !before.isDirectory())) throw denied();
  const entry: Entry = { path: relative, directory: before.isDirectory(), dev: before.dev, ino: before.ino,
    size: before.isDirectory() ? 0 : before.size, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs };
  if (!entry.directory && content) {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!unchanged(before, await file.stat())) throw denied();
      const hash = createHash("sha256"); let bytes = 0;
      for await (const chunk of file.createReadStream({ highWaterMark: 64 * 1024, autoClose: false })) { bytes += chunk.length; hash.update(chunk); }
      if (bytes !== before.size || !unchanged(before, await file.stat())) throw denied();
      entry.sha256 = hash.digest("hex");
    } finally { await file.close(); }
  }
  yield entry;
  if (entry.directory) for await (const name of sortedNativeHarnessNames(path, order)) {
    if (!relative && exclude.includes(name)) continue;
    yield* entries(home, content, exclude, relative ? `${relative}/${name}` : name, depth + 1);
  }
  if (!unchanged(before, await lstat(path))) throw denied();
}

export async function snapshotCleanupProviderHome(home: string, content: boolean, exclude: readonly string[]) {
  const metadataHash = createHash("sha256").update("["), contentHash = createHash("sha256").update("[");
  let bytes = 0, first = true;
  for await (const entry of entries(home, content, exclude)) {
    const { sha256: _sha, ...metadata } = entry;
    if (!first) { metadataHash.update(","); contentHash.update(","); } first = false;
    metadataHash.update(canonicalNativeJson(metadata));
    contentHash.update(canonicalNativeJson({ path: entry.path, directory: entry.directory, size: entry.size, ...(entry.sha256 ? { sha256: entry.sha256 } : {}) }));
    bytes += entry.size;
  }
  return { bytes, metadataFingerprint: metadataHash.update("]").digest("hex"),
    fingerprint: content ? contentHash.update("]").digest("hex") : null,
    entries: () => entries(home, content, exclude) };
}

export async function copyCleanupProviderHomeTree(source: string, destination: string, snapshot: Awaited<ReturnType<typeof snapshotCleanupProviderHome>>, exclude: readonly string[]): Promise<void> {
  for await (const entry of snapshot.entries()) {
    const target = resolve(destination, entry.path);
    if (entry.directory) { await mkdir(target, { mode: 0o700 }); continue; }
    const file = await open(resolve(source, entry.path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let output: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.dev !== entry.dev || stat.ino !== entry.ino || stat.size !== entry.size || stat.mtimeMs !== entry.mtimeMs || stat.ctimeMs !== entry.ctimeMs) throw denied();
      output = await open(target, "wx", 0o600); const hash = createHash("sha256");
      for await (const chunk of file.createReadStream({ highWaterMark: 64 * 1024, autoClose: false })) { hash.update(chunk); await output.writeFile(chunk); }
      if (hash.digest("hex") !== entry.sha256 || !unchanged(stat, await file.stat())) throw denied();
      await output.sync();
    } finally { try { await output?.close(); } finally { await file.close(); } }
  }
  if ((await snapshotCleanupProviderHome(source, false, exclude)).metadataFingerprint !== snapshot.metadataFingerprint ||
      (await snapshotCleanupProviderHome(destination, true, exclude)).fingerprint !== snapshot.fingerprint) throw denied();
  // Sync directories after their child entries have been installed.
  const sync = async (path: string): Promise<void> => {
    for await (const name of sortedNativeHarnessNames(path, order)) { const child = resolve(path, name); if ((await lstat(child)).isDirectory()) await sync(child); }
    await syncNativeHarnessDirectory(path);
  };
  await sync(destination);
}

/** Find one exact rollout without retaining a catalog of historical files. */
export async function findCleanupRollout(home: string, threadId: string, exclude: readonly string[]): Promise<Entry> {
  let rollout: Entry | undefined;
  for await (const entry of entries(home, false, exclude)) {
    if (/^state_\d+\.sqlite$/.test(entry.path) && entry.path !== "state_5.sqlite") throw denied();
    if (!entry.directory && entry.path.startsWith("sessions/") && entry.path.endsWith(`-${threadId}.jsonl`)) {
      if (rollout) throw denied(); rollout = entry;
    }
  }
  if (!rollout) throw denied(); return rollout;
}

export async function readCleanupRolloutHeader(home: string, entry: Entry): Promise<Buffer> {
  const file = await open(resolve(home, entry.path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.ino !== entry.ino || stat.dev !== entry.dev || stat.size !== entry.size || stat.mtimeMs !== entry.mtimeMs || stat.ctimeMs !== entry.ctimeMs) throw denied();
    const buffer = Buffer.alloc(64 * 1024 + 1); let length = 0;
    while (length < buffer.length) {
      const read = await file.read(buffer, length, buffer.length - length, null); if (!read.bytesRead) break;
      length += read.bytesRead; const newline = buffer.subarray(0, length).indexOf(10);
      if (newline >= 0) { if (!unchanged(stat, await file.stat())) throw denied(); return buffer.subarray(0, newline); }
    }
    throw denied();
  } finally { await file.close(); }
}
