import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import { executionWorkspaceSnapshots, type Db } from "@paperclipai/db";
import type { StorageService } from "../storage/types.js";
import { getStorageService } from "../storage/index.js";
import { getWorkspaceSnapshot, openWorkspaceSnapshotRanges } from "./remote-workspace-snapshot-storage.js";

const ARCHIVE_MAGIC = Buffer.from("PCWS1\n");
const ARCHIVE_SCHEMA = "paperclip.remote-workspace-archive.v1";
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_INDEX_ENTRIES = 500_000;
const INDEX_ENTRY_BYTES = 256;
const DEFAULT_INDEX_CACHE_BYTES = 256 * 1024 * 1024;
const MAX_CONCURRENT_INDEX_BUILDS = 2;
let activeIndexBuilds = 0;
const indexBuildWaiters: Array<() => void> = [];

function untilAborted<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

async function withIndexBuildSlot<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (activeIndexBuilds >= MAX_CONCURRENT_INDEX_BUILDS) {
    await new Promise<void>((resolve, reject) => {
      const granted = () => { signal?.removeEventListener("abort", abort); resolve(); };
      const abort = () => {
        const waiting = indexBuildWaiters.indexOf(granted);
        if (waiting >= 0) indexBuildWaiters.splice(waiting, 1);
        reject(signal!.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
      indexBuildWaiters.push(granted);
    });
  } else activeIndexBuilds++;
  try { return await work(); }
  finally {
    const next = indexBuildWaiters.shift();
    if (next) next(); else activeIndexBuilds--;
  }
}

export type SavedArchiveEntry = {
  path: string; name: string; type: "directory" | "file" | "symlink"; size: number; sha256: string | null; offset: number;
};

export interface SavedWorkspaceArchive {
  snapshotId: string;
  savedAt: string;
  byteSize: number;
  entry(relativePath: string): SavedArchiveEntry | undefined;
  children(relativePath: string): readonly SavedArchiveEntry[];
  cachedIndexBytes(): number;
  read(entry: SavedArchiveEntry, start: number, length: number, signal?: AbortSignal): Promise<Readable>;
  close(): void;
}

export type OpenSavedWorkspaceArchive = (input: {
  companyId: string; workspaceId: string; snapshotId: string; signal?: AbortSignal;
}) => Promise<SavedWorkspaceArchive>;

type ArchiveIndex = { entries: Map<string, SavedArchiveEntry>; children: Map<string, SavedArchiveEntry[]>; charge: number };

function invalid(reason: string): never { throw new Error(`remote_workspace_archive_${reason}`); }

const unsafePath = (relative: unknown) => typeof relative !== "string" || !relative || relative.length > 4096
  || relative.startsWith("/") || /[\\\u0000-\u001f\u007f]/u.test(relative)
  || relative.split("/").some(part => !part || part === "." || part === "..");

function buildIndex(manifestBytes: Buffer, archiveBytes: number, maxEntries: number): ArchiveIndex {
  let manifest: { schema?: unknown; entries?: unknown };
  try { manifest = JSON.parse(manifestBytes.toString("utf8")); } catch { invalid("manifest_mismatch"); }
  if (manifest.schema !== ARCHIVE_SCHEMA || !Array.isArray(manifest.entries)) invalid("manifest_mismatch");
  if (manifest.entries.length > maxEntries) invalid("entry_limit");
  const entries = new Map<string, SavedArchiveEntry>(), children = new Map<string, SavedArchiveEntry[]>([["", []]]);
  let offset = ARCHIVE_MAGIC.length + 4 + manifestBytes.length;
  for (const raw of manifest.entries as Array<Record<string, unknown>>) {
    const relative = raw?.path;
    if (unsafePath(relative) || entries.has(relative as string)) invalid("invalid_entry");
    const entryPath = relative as string, parent = entryPath.includes("/") ? entryPath.slice(0, entryPath.lastIndexOf("/")) : "";
    if (parent && entries.get(parent)?.type !== "directory") invalid("invalid_parent");
    let entry: SavedArchiveEntry;
    if (raw.type === "file") {
      if (!Number.isSafeInteger(raw.size) || (raw.size as number) < 0 || typeof raw.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.sha256)) {
        invalid("invalid_file");
      }
      entry = { path: entryPath, name: entryPath.slice(parent ? parent.length + 1 : 0), type: "file", size: raw.size as number,
        sha256: raw.sha256 as string, offset };
      offset += entry.size;
    } else if (raw.type === "directory" || raw.type === "symlink") {
      entry = { path: entryPath, name: entryPath.slice(parent ? parent.length + 1 : 0), type: raw.type, size: 0, sha256: null, offset: 0 };
      if (raw.type === "directory") children.set(entryPath, []);
    } else invalid("invalid_type");
    entries.set(entryPath, entry);
    children.get(parent)!.push(entry);
  }
  if (!Number.isSafeInteger(offset) || offset !== archiveBytes) invalid("size_mismatch");
  for (const list of children.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return { entries, children, charge: manifestBytes.length + entries.size * INDEX_ENTRY_BYTES };
}

async function readAll(stream: Readable, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > limit) invalid("truncated");
      chunks.push(bytes);
    }
  } finally { stream.destroy(); }
  return Buffer.concat(chunks);
}

export function createSavedWorkspaceArchiveOpener(db: Db, storage: StorageService = getStorageService(), options: {
  indexCacheBytes?: number; idleTimeoutMs?: number; maxIndexEntries?: number;
} = {}): OpenSavedWorkspaceArchive {
  const maxEntries = Math.min(options.maxIndexEntries ?? MAX_INDEX_ENTRIES, MAX_INDEX_ENTRIES);
  const cacheBudget = options.indexCacheBytes ?? DEFAULT_INDEX_CACHE_BYTES;
  const cache = new Map<string, ArchiveIndex>(), building = new Map<string, Promise<ArchiveIndex>>();
  let cachedBytes = 0;
  const remember = (key: string, index: ArchiveIndex) => {
    const existing = cache.get(key);
    if (existing) { cache.delete(key); cachedBytes -= existing.charge; }
    if (index.charge > cacheBudget) return;
    cache.set(key, index); cachedBytes += index.charge;
    for (const [oldest, value] of cache) {
      if (cachedBytes <= cacheBudget) break;
      cache.delete(oldest); cachedBytes -= value.charge;
    }
  };
  return async input => {
    input.signal?.throwIfAborted();
    const [row] = await db.select({ updatedAt: executionWorkspaceSnapshots.updatedAt }).from(executionWorkspaceSnapshots).where(and(
      eq(executionWorkspaceSnapshots.companyId, input.companyId), eq(executionWorkspaceSnapshots.executionWorkspaceId, input.workspaceId),
      eq(executionWorkspaceSnapshots.id, input.snapshotId), eq(executionWorkspaceSnapshots.status, "committed")));
    const saved = row ? await getWorkspaceSnapshot(db, input) : null;
    if (!row || !saved) throw new Error("remote_workspace_snapshot_unavailable");
    const ranges = await openWorkspaceSnapshotRanges({ storage, reference: saved, signal: input.signal,
      ...(options.idleTimeoutMs ? { idleTimeoutMs: options.idleTimeoutMs } : {}) });
    try {
      const key = `${saved.companyId}/${saved.workspaceId}/${saved.id}/${saved.manifestDigest}`;
      let index: ArchiveIndex | undefined;
      for (;;) {
        index = cache.get(key);
        if (index) { cache.delete(key); cache.set(key, index); break; }
        const shared = building.get(key);
        if (shared) {
          index = await untilAborted(shared.catch(() => undefined), input.signal);
          if (index) break;
          continue;
        }
        const build = withIndexBuildSlot(async () => {
          const prefixLength = ARCHIVE_MAGIC.length + 4;
          if (ranges.plaintextBytes < prefixLength) invalid("truncated");
          const prefix = await readAll(await ranges.read(0, prefixLength, input.signal), prefixLength);
          if (!prefix.subarray(0, ARCHIVE_MAGIC.length).equals(ARCHIVE_MAGIC)) invalid("invalid_header");
          const manifestSize = prefix.readUInt32BE(ARCHIVE_MAGIC.length);
          if (manifestSize > MAX_MANIFEST_BYTES || prefixLength + manifestSize > ranges.plaintextBytes) invalid("manifest_too_large");
          const manifest = await readAll(await ranges.read(prefixLength, manifestSize, input.signal), manifestSize);
          if (manifest.length !== manifestSize || createHash("sha256").update(manifest).digest("hex") !== saved.manifestDigest) {
            invalid("manifest_mismatch");
          }
          return buildIndex(manifest, ranges.plaintextBytes, maxEntries);
        }, input.signal);
        building.set(key, build);
        try { index = await build; remember(key, index); }
        finally { if (building.get(key) === build) building.delete(key); }
        break;
      }
      const built = index;
      return {
        snapshotId: saved.id,
        savedAt: row.updatedAt.toISOString(),
        byteSize: saved.byteSize,
        entry: relativePath => built.entries.get(relativePath),
        children: relativePath => built.children.get(relativePath) ?? [],
        cachedIndexBytes: () => cachedBytes,
        read: (entry, start, length, signal) => {
          if (entry.type !== "file" || start < 0 || length < 0 || start + length > entry.size) invalid("range_invalid");
          return ranges.read(entry.offset + start, length, signal);
        },
        close: () => ranges.close(),
      };
    } catch (error) { ranges.close(); throw error; }
  };
}
