import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createGzip, createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { notFound } from "../errors.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { logger } from "../middleware/logger.js";
import { getRunLogArchiveStorageProvider } from "../storage/index.js";

/**
 * Storage tier a run-log currently lives in.
 *  - `local_file`: hot copy on the shared volume (may be raw `.ndjson` or `.ndjson.gz`).
 *  - `s3`: cold copy archived to object storage; `logRef` is the full S3 object key.
 * The DB column is the source of truth; the archiver flips it local_file → s3.
 */
export type RunLogStoreType = "local_file" | "s3";

/** Object-key prefix for archived run-logs: `run-logs/<companyId>/<agentId>/<runId>.ndjson.gz`. */
export const RUN_LOG_S3_KEY_PREFIX = "run-logs";

/** Minimal storage surface the store needs to stream an archived (s3) run-log back. */
export interface RunLogS3Reader {
  getObject(input: { objectKey: string }): Promise<{ stream: Readable }>;
}

export interface CreateRunLogStoreOptions {
  /** When set, `read()` can resolve `store: "s3"` handles by streaming from object storage. */
  s3Reader?: RunLogS3Reader | null;
}

export interface RunLogHandle {
  store: RunLogStoreType;
  logRef: string;
}

export interface RunLogReadOptions {
  offset?: number;
  limitBytes?: number;
}

export interface RunLogReadResult {
  content: string;
  nextOffset?: number;
}

export interface RunLogFinalizeSummary {
  /** Byte length of the ORIGINAL, uncompressed log content. */
  bytes: number;
  /** sha256 of the ORIGINAL, uncompressed log content. */
  sha256?: string;
  compressed: boolean;
  /** Final relative logRef to persist — `.ndjson.gz` when compressed, else `.ndjson`. */
  logRef: string;
}

export interface RunLogStore {
  begin(input: { companyId: string; agentId: string; runId: string }): Promise<RunLogHandle>;
  append(
    handle: RunLogHandle,
    event: { stream: "stdout" | "stderr" | "system"; chunk: string; ts: string },
  ): Promise<number>;
  finalize(handle: RunLogHandle): Promise<RunLogFinalizeSummary>;
  read(handle: RunLogHandle, opts?: RunLogReadOptions): Promise<RunLogReadResult>;
}

function safeSegments(...segments: string[]) {
  return segments.map((segment) => segment.replace(/[^a-zA-Z0-9._-]/g, "_"));
}

function resolveWithin(basePath: string, relativePath: string) {
  const resolved = path.resolve(basePath, relativePath);
  const base = path.resolve(basePath) + path.sep;
  if (!resolved.startsWith(base) && resolved !== path.resolve(basePath)) {
    throw new Error("Invalid log path");
  }
  return resolved;
}

/**
 * Compression is on by default. Set `PAPERCLIP_RUN_LOG_COMPRESS=0` (or `false`)
 * to keep completed run-logs as raw `.ndjson`. Read at finalize time so tests
 * and operators can toggle it without a restart.
 */
function compressionEnabled(): boolean {
  const raw = process.env.PAPERCLIP_RUN_LOG_COMPRESS;
  if (raw == null) return true;
  const normalized = raw.trim().toLowerCase();
  return normalized !== "0" && normalized !== "false" && normalized !== "no" && normalized !== "off";
}

const DEFAULT_RUN_LOG_MAX_BYTES = 512 * 1024 * 1024; // 512 MiB

/**
 * Per-run cap on persisted (uncompressed) log bytes, so a single runaway run
 * cannot fill the shared volume between daily sweeps. Set
 * `PAPERCLIP_RUN_LOG_MAX_BYTES` to override; unset/invalid/<=0 falls back to
 * the 512 MiB default. Read per call so tests/operators can retune without a
 * restart.
 */
function runLogMaxBytes(): number {
  const raw = process.env.PAPERCLIP_RUN_LOG_MAX_BYTES;
  if (raw == null) return DEFAULT_RUN_LOG_MAX_BYTES;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RUN_LOG_MAX_BYTES;
  return parsed;
}

const RUN_LOG_TRUNCATION_STREAM = "system" as const;

interface RunLogCapState {
  writtenBytes: number;
  truncated: boolean;
}

/**
 * Range-read a gzip stream. offset/limitBytes semantics are over the
 * UNCOMPRESSED byte stream. The whole payload is never buffered: the first
 * `offset` decompressed bytes are discarded, up to `limitBytes` bytes are
 * collected, then the pipeline is destroyed early. `nextOffset` is set only
 * when the underlying stream still had data past what we returned.
 *
 * `source` is any Readable of gzip bytes — a local `createReadStream` for the
 * hot tier, or an S3 object stream for the cold tier — so both tiers share one
 * decompression + slicing implementation.
 *
 * nextOffset divergence from the raw path: when the decompressed stream ends at
 * (or before) what we returned, `nextOffset` is left undefined — i.e. "done".
 * readFileRange instead clamps and can return nextOffset === size so a live tail
 * keeps polling. That is intentional: a finalized `.gz` is immutable, so "no
 * more bytes" is terminal and there is nothing to poll for. An offset at/beyond
 * uncompressed EOF therefore yields `{ content: "", nextOffset: undefined }`.
 */
export async function readGunzipRange(
  source: Readable,
  offset: number,
  limitBytes: number,
): Promise<RunLogReadResult> {
  if (limitBytes <= 0) {
    source.destroy();
    return { content: "", nextOffset: offset };
  }

  let skipped = 0; // uncompressed bytes discarded so far (up to offset)
  let collected = 0; // uncompressed bytes retained (up to limitBytes)
  let hasMore = false; // stream produced data beyond what we returned
  const chunks: Buffer[] = [];

  const gunzip = createGunzip();

  await new Promise<void>((resolve, reject) => {
    let finished = false;
    const finish = (err?: Error) => {
      if (finished) return;
      finished = true;
      // Stop the pipeline early once we have enough; ignore late errors.
      source.destroy();
      gunzip.destroy();
      if (err) reject(err);
      else resolve();
    };

    source.on("error", finish);
    gunzip.on("error", finish);
    gunzip.on("end", () => finish());

    gunzip.on("data", (raw: Buffer) => {
      let buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);

      // Discard bytes before `offset`.
      if (skipped < offset) {
        const toSkip = Math.min(offset - skipped, buf.length);
        skipped += toSkip;
        buf = buf.subarray(toSkip);
        if (buf.length === 0) return;
      }

      if (collected >= limitBytes) {
        // Already full; any further byte means there is more data.
        hasMore = true;
        finish();
        return;
      }

      const remaining = limitBytes - collected;
      if (buf.length <= remaining) {
        chunks.push(buf);
        collected += buf.length;
      } else {
        chunks.push(buf.subarray(0, remaining));
        collected += remaining;
        hasMore = true;
        finish();
      }
    });

    source.pipe(gunzip);
  });

  const content = Buffer.concat(chunks).toString("utf8");
  const nextOffset = hasMore ? offset + collected : undefined;
  return { content, nextOffset };
}

/**
 * Stream-gzip `srcAbs` → `destAbs` crash-safely (tmp → rename). Does NOT unlink
 * the source; callers decide when the raw file is safe to remove. Shared by
 * finalize (compress-on-complete) and the archiver (gzip legacy raw logs before
 * upload).
 */
export async function gzipFileToGz(srcAbs: string, destAbs: string): Promise<void> {
  const tmpAbs = `${destAbs}.tmp`;
  try {
    await pipeline(createReadStream(srcAbs), createGzip(), createWriteStream(tmpAbs));
    await fs.rename(tmpAbs, destAbs);
  } catch (err) {
    await fs.unlink(tmpAbs).catch(() => undefined);
    throw err;
  }
}

/** Absolute base dir the default run-log store reads/writes (env-overridable). */
export function resolveRunLogBasePath(): string {
  return process.env.RUN_LOG_BASE_PATH ?? path.resolve(resolvePaperclipInstanceRoot(), "data", "run-logs");
}

function toPosixKey(relPath: string): string {
  return relPath.split(path.sep).join("/");
}

export interface RunLogArchiveSource {
  /** Absolute path to the gzip file to upload. */
  absPath: string;
  /** Relative path (posix) under the base dir, e.g. `<companyId>/<agentId>/<runId>.ndjson.gz`. */
  relPath: string;
  /** Full S3 object key: `run-logs/<companyId>/<agentId>/<runId>.ndjson.gz`. */
  objectKey: string;
  /** On-disk (compressed) size in bytes. */
  bytes: number;
}

/**
 * Resolve the local file backing a run-log `logRef` and guarantee it is gzipped,
 * ready for cold-archive upload. Reuses the same drift tolerance as the read
 * path: a raw legacy `.ndjson` is compressed in place (streaming gzip, then the
 * raw file is unlinked) so only a `.ndjson.gz` is ever uploaded. Throws
 * `notFound` when nothing backs the ref on disk.
 */
export async function prepareRunLogArchiveSource(
  basePath: string,
  logRef: string,
): Promise<RunLogArchiveSource> {
  const direct = resolveWithin(basePath, logRef);
  const directStat = await fs.stat(direct).catch(() => null);

  let gzAbs: string;
  if (directStat && logRef.endsWith(".gz")) {
    gzAbs = direct;
  } else if (directStat) {
    // Raw `.ndjson` on disk under the exact ref: compress it, then drop the raw.
    gzAbs = `${direct}.gz`;
    await gzipFileToGz(direct, gzAbs);
    await fs.unlink(direct).catch(() => undefined);
  } else if (logRef.endsWith(".ndjson")) {
    // Ref points at raw, but only the `.gz` exists (compress crash-window / legacy row).
    const gzCandidate = resolveWithin(basePath, `${logRef}.gz`);
    if (!(await fs.stat(gzCandidate).catch(() => null))) throw notFound("Run log not found");
    gzAbs = gzCandidate;
  } else if (logRef.endsWith(".ndjson.gz")) {
    // Ref points at gz, but only the raw exists (gzip-failure fallback): compress it now.
    const rawCandidate = resolveWithin(basePath, logRef.slice(0, -".gz".length));
    if (!(await fs.stat(rawCandidate).catch(() => null))) throw notFound("Run log not found");
    gzAbs = direct;
    await gzipFileToGz(rawCandidate, gzAbs);
    await fs.unlink(rawCandidate).catch(() => undefined);
  } else {
    throw notFound("Run log not found");
  }

  const stat = await fs.stat(gzAbs).catch(() => null);
  if (!stat) throw notFound("Run log not found");
  const relPath = toPosixKey(path.relative(basePath, gzAbs));
  return {
    absPath: gzAbs,
    relPath,
    objectKey: `${RUN_LOG_S3_KEY_PREFIX}/${relPath}`,
    bytes: stat.size,
  };
}

export function createLocalFileRunLogStore(
  basePath: string,
  options?: CreateRunLogStoreOptions,
): RunLogStore {
  // logRef -> cap-tracking state. Cleared in finalize(); reseeded from disk
  // (fs.stat) the first time an unknown logRef is appended to, so a server
  // restart mid-run doesn't lose the running total.
  const capState = new Map<string, RunLogCapState>();
  // logRefs whose finalize() has begun. A finalized ref's raw `.ndjson` is
  // gzipped and unlinked, so a late append() must NOT recreate/write it (that
  // would strand invisible bytes: read() resolves the `.gz` first). Runtime
  // services can still emit onLog appends after heartbeat calls finalize()
  // (heartbeat releases runtime services only after finalizing), so we guard
  // append() against it here.
  //
  // Accepted limitation: this Set lives only in-process. After a server restart
  // it is empty, so a zombie appender could recreate a raw file for an
  // already-finalized run. That raw file stays invisible (read() prefers the
  // .gz) and is bounded by the infra janitor backstop — deliberate.
  const finalizedRefs = new Set<string>();
  // Refs we've already warned about appending-after-finalize, so the warn is
  // emitted once per ref, not once per dropped chunk.
  const appendAfterFinalizeWarned = new Set<string>();

  async function ensureDir(relativeDir: string) {
    const dir = resolveWithin(basePath, relativeDir);
    await fs.mkdir(dir, { recursive: true });
  }

  async function getCapState(logRef: string, absPath: string): Promise<RunLogCapState> {
    const existing = capState.get(logRef);
    if (existing) return existing;
    const stat = await fs.stat(absPath).catch(() => null);
    const writtenBytes = stat?.size ?? 0;
    // Restart seeding: a run already at/over the cap had its truncation marker
    // written by the previous instance (or the file is already over cap). Seed
    // `truncated: true` so we silently drop further appends instead of writing a
    // SECOND marker. Only a live crossing of the cap (below) writes the marker.
    const seeded: RunLogCapState = {
      writtenBytes,
      truncated: writtenBytes >= runLogMaxBytes(),
    };
    capState.set(logRef, seeded);
    return seeded;
  }

  async function readFileRange(filePath: string, offset: number, limitBytes: number): Promise<RunLogReadResult> {
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) throw notFound("Run log not found");

    const start = Math.max(0, Math.min(offset, stat.size));
    const end = Math.max(start, Math.min(start + limitBytes - 1, stat.size - 1));

    if (start > end) {
      return { content: "", nextOffset: start };
    }

    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filePath, { start, end });
      stream.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stream.on("error", reject);
      stream.on("end", () => resolve());
    });

    const content = Buffer.concat(chunks).toString("utf8");
    const nextOffset = end + 1 < stat.size ? end + 1 : undefined;
    return { content, nextOffset };
  }

  /**
   * Range-read a gzip-compressed log file. offset/limitBytes semantics are over
   * the UNCOMPRESSED byte stream (identical to readFileRange). Delegates to the
   * shared `readGunzipRange`, which the S3 read path also reuses.
   */
  async function readGzipRange(filePath: string, offset: number, limitBytes: number): Promise<RunLogReadResult> {
    const exists = await fs.stat(filePath).catch(() => null);
    if (!exists) throw notFound("Run log not found");
    return readGunzipRange(createReadStream(filePath), offset, limitBytes);
  }

  async function sha256File(filePath: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const hash = createHash("sha256");
      const stream = createReadStream(filePath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve(hash.digest("hex")));
    });
  }

  /**
   * Resolve which file backs a logRef, tolerating drift between the DB row's
   * ref and what is on disk:
   *  - exact path if present
   *  - `.ndjson` ref → try `.ndjson.gz` (legacy rows + the compress crash window)
   *  - `.ndjson.gz` ref → try raw `.ndjson` (gzip-failure fallback)
   * Step 3 will extend this with an S3 fallback.
   */
  async function resolveReadTarget(logRef: string): Promise<{ absPath: string; compressed: boolean }> {
    const absPath = resolveWithin(basePath, logRef);
    if (await fs.stat(absPath).catch(() => null)) {
      return { absPath, compressed: logRef.endsWith(".gz") };
    }

    if (logRef.endsWith(".ndjson")) {
      const gzRef = `${logRef}.gz`;
      const gzAbs = resolveWithin(basePath, gzRef);
      if (await fs.stat(gzAbs).catch(() => null)) {
        return { absPath: gzAbs, compressed: true };
      }
    } else if (logRef.endsWith(".ndjson.gz")) {
      const rawRef = logRef.slice(0, -".gz".length);
      const rawAbs = resolveWithin(basePath, rawRef);
      if (await fs.stat(rawAbs).catch(() => null)) {
        return { absPath: rawAbs, compressed: false };
      }
    }

    throw notFound("Run log not found");
  }

  return {
    async begin(input) {
      const [companyId, agentId] = safeSegments(input.companyId, input.agentId);
      const runId = safeSegments(input.runId)[0]!;
      const relDir = path.join(companyId, agentId);
      const relPath = path.join(relDir, `${runId}.ndjson`);
      await ensureDir(relDir);

      const absPath = resolveWithin(basePath, relPath);
      await fs.writeFile(absPath, "", "utf8");

      return { store: "local_file", logRef: relPath };
    },

    async append(handle, event) {
      if (handle.store !== "local_file") return 0;
      if (finalizedRefs.has(handle.logRef)) {
        if (!appendAfterFinalizeWarned.has(handle.logRef)) {
          appendAfterFinalizeWarned.add(handle.logRef);
          logger.warn(
            { logRef: handle.logRef },
            "run-log: append after finalize ignored; log is already compressed/sealed",
          );
        }
        return 0;
      }
      const absPath = resolveWithin(basePath, handle.logRef);
      const state = await getCapState(handle.logRef, absPath);

      if (state.truncated) return 0;

      const line = JSON.stringify({
        ts: event.ts,
        stream: event.stream,
        chunk: event.chunk,
      });
      const persisted = `${line}\n`;
      const persistedBytes = Buffer.byteLength(persisted, "utf8");
      const capBytes = runLogMaxBytes();

      if (state.writtenBytes + persistedBytes > capBytes) {
        state.truncated = true;
        const markerLine = JSON.stringify({
          ts: event.ts,
          stream: RUN_LOG_TRUNCATION_STREAM,
          chunk: `[run-log truncated: size cap ${capBytes} bytes reached; further output dropped]`,
        });
        const markerPersisted = `${markerLine}\n`;
        await fs.appendFile(absPath, markerPersisted, "utf8");
        state.writtenBytes += Buffer.byteLength(markerPersisted, "utf8");
        return 0;
      }

      await fs.appendFile(absPath, persisted, "utf8");
      state.writtenBytes += persistedBytes;
      return persistedBytes;
    },

    async finalize(handle) {
      // Mark finalized at the START (before gzip/unlink) so any append() racing
      // the compression is dropped rather than recreating the raw file.
      finalizedRefs.add(handle.logRef);
      capState.delete(handle.logRef);
      if (handle.store !== "local_file") {
        return { bytes: 0, compressed: false, logRef: handle.logRef };
      }
      const absPath = resolveWithin(basePath, handle.logRef);
      const stat = await fs.stat(absPath).catch(() => null);
      if (!stat) throw notFound("Run log not found");

      // bytes/sha256 always describe the ORIGINAL uncompressed content.
      const rawBytes = stat.size;
      const rawSha256 = await sha256File(absPath);

      const uncompressedSummary: RunLogFinalizeSummary = {
        bytes: rawBytes,
        sha256: rawSha256,
        compressed: false,
        logRef: handle.logRef,
      };

      if (!compressionEnabled()) {
        return uncompressedSummary;
      }

      const gzRef = `${handle.logRef}.gz`;
      const gzAbs = resolveWithin(basePath, gzRef);

      // Crash-safe ordering: write tmp → rename → unlink raw. On any failure,
      // clean up the tmp and keep the raw file. finalize must never lose the
      // log or throw just because gzip failed.
      try {
        await gzipFileToGz(absPath, gzAbs);
        await fs.unlink(absPath).catch((unlinkErr) => {
          // Compressed copy is durable; a leftover raw file is harmless (read()
          // prefers the exact ref, which is now the .gz).
          logger.warn(
            { err: unlinkErr, logRef: handle.logRef },
            "run-log: failed to unlink raw file after compression",
          );
        });
        return {
          bytes: rawBytes,
          sha256: rawSha256,
          compressed: true,
          logRef: gzRef,
        };
      } catch (err) {
        logger.warn(
          { err, logRef: handle.logRef },
          "run-log: compression failed; leaving raw log uncompressed",
        );
        return uncompressedSummary;
      }
    },

    async read(handle, opts) {
      const offset = opts?.offset ?? 0;
      const limitBytes = opts?.limitBytes ?? 256_000;

      // Cold tier: stream the archived object, gunzip, and apply the SAME
      // uncompressed offset/limitBytes semantics as the hot gz path. logRef is
      // the full S3 object key, so no company scoping is needed here.
      if (handle.store === "s3") {
        const reader = options?.s3Reader;
        if (!reader) throw notFound("Run log not found");
        const { stream } = await reader.getObject({ objectKey: handle.logRef });
        return readGunzipRange(stream, offset, limitBytes);
      }

      if (handle.store !== "local_file") {
        throw notFound("Run log not found");
      }
      const { absPath, compressed } = await resolveReadTarget(handle.logRef);
      return compressed
        ? readGzipRange(absPath, offset, limitBytes)
        : readFileRange(absPath, offset, limitBytes);
    },
  };
}

let cachedStore: RunLogStore | null = null;

export function getRunLogStore() {
  if (cachedStore) return cachedStore;
  const basePath = resolveRunLogBasePath();
  // s3Reader defers provider resolution to read time, so a local_disk-only
  // instance never eagerly builds an S3 client, and archived (s3-tier) runs are
  // still transparently readable when object storage is configured.
  cachedStore = createLocalFileRunLogStore(basePath, {
    s3Reader: {
      getObject: (input) => getRunLogArchiveStorageProvider().getObject({ objectKey: input.objectKey }),
    },
  });
  return cachedStore;
}
