import { captureSandboxPerformanceContext, measureSandboxOperation, measureSandboxStream } from "./sandbox-performance.js";
import { Readable } from "node:stream";
import type { WorkTreeEntry } from "./work-folder-transport.js";

export const WORK_FOLDER_READ_BATCH_MAX_BYTES = 1024 * 1024;
const MAX_BATCH_ENTRIES = 64;
const MAX_CACHED_BATCHES = 4;

/**
 * A checkpoint-local cache, not a snapshot or a retry source. The caller limits
 * concurrent batch readers to sixteen. At most four 1 MiB batches stay cached;
 * evicted batches held by active readers can add at most another 16 MiB. Larger
 * files use the separately bounded streaming fallback. Metadata is O(entries).
 */
export function createWorkFolderReadCache(
  entries: WorkTreeEntry[],
  load: (entries: WorkTreeEntry[]) => Promise<Buffer[]>,
  fallback: (entry: WorkTreeEntry) => Readable,
) {
  const locations = new Map<string, { batch: WorkTreeEntry[]; index: number }>();
  let batch: WorkTreeEntry[] = [];
  let batchBytes = 0;
  for (const entry of entries) {
    if (entry.kind !== "file" || entry.linkTarget || entry.byteSize > WORK_FOLDER_READ_BATCH_MAX_BYTES) continue;
    if (batch.length >= MAX_BATCH_ENTRIES || batchBytes + entry.byteSize > WORK_FOLDER_READ_BATCH_MAX_BYTES) {
      batch = []; batchBytes = 0;
    }
    locations.set(entry.path, { batch, index: batch.length });
    batch.push(entry); batchBytes += entry.byteSize;
  }
  const cached = new Map<WorkTreeEntry[], Promise<Buffer[]>>();
  const readPaths = new Set<string>();
  let cleared = false;

  function getBatch(group: WorkTreeEntry[]) {
    let result = cached.get(group);
    if (result) {
      cached.delete(group); cached.set(group, result);
      return result;
    }
    result = measureSandboxOperation("work_folder.read_cache.load", { files: group.length, bytes: group.reduce((sum, entry) => sum + entry.byteSize, 0) }, () => load(group)).then((buffers) => {
      if (buffers.length !== group.length || buffers.some((buffer, index) =>
        !Buffer.isBuffer(buffer) || buffer.length !== group[index]!.byteSize)) {
        throw new Error("Work folder batch content does not match its entries");
      }
      return buffers;
    }).catch((error: unknown) => {
      if (cached.get(group) === result) cached.delete(group);
      throw error;
    });
    cached.set(group, result);
    while (cached.size > MAX_CACHED_BATCHES) cached.delete(cached.keys().next().value!);
    return result;
  }

  function read(entry: WorkTreeEntry): Readable {
    const repeated = readPaths.has(entry.path);
    readPaths.add(entry.path);
    const location = locations.get(entry.path);
    // Mark each source request, even if its stream is never consumed. A retry
    // must reopen the physical file instead of replaying possibly stale bytes.
    const inContext = captureSandboxPerformanceContext();
    return measureSandboxStream("work_folder.read_cache.body", { bytes: entry.byteSize, repeated }, Readable.from((async function* () {
      if (cleared || repeated || !location) {
        const source = inContext(() => fallback(entry));
        try { yield* source; } finally { source.destroy(); }
        return;
      }
      const buffers = await inContext(() => measureSandboxOperation("work_folder.read_cache.lookup",
        { cacheHit: cached.has(location.batch), files: location.batch.length }, async () => getBatch(location.batch)));
      yield buffers[location.index]!;
    })()));
  }
  function clear() {
    cleared = true;
    cached.clear();
    locations.clear();
    readPaths.clear();
  }
  return { read, clear };
}
