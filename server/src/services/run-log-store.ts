import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createGzip, createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { notFound } from "../errors.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { logger } from "../middleware/logger.js";

export type RunLogStoreType = "local_file";

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

export function createLocalFileRunLogStore(basePath: string): RunLogStore {
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
    const seeded: RunLogCapState = { writtenBytes: stat?.size ?? 0, truncated: false };
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
   * Range-read a gzip-compressed log. offset/limitBytes semantics are over the
   * UNCOMPRESSED byte stream (identical to readFileRange). The whole file is
   * never buffered: the first `offset` decompressed bytes are discarded, up to
   * `limitBytes` bytes are collected, then the stream is destroyed. nextOffset
   * is set only when the underlying stream still had data past what we returned.
   */
  async function readGzipRange(filePath: string, offset: number, limitBytes: number): Promise<RunLogReadResult> {
    const exists = await fs.stat(filePath).catch(() => null);
    if (!exists) throw notFound("Run log not found");

    if (limitBytes <= 0) {
      return { content: "", nextOffset: offset };
    }

    let skipped = 0; // uncompressed bytes discarded so far (up to offset)
    let collected = 0; // uncompressed bytes retained (up to limitBytes)
    let hasMore = false; // stream produced data beyond what we returned
    const chunks: Buffer[] = [];

    const source = createReadStream(filePath);
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
      const tmpAbs = `${gzAbs}.tmp`;

      // Crash-safe ordering: write tmp → rename → unlink raw. On any failure,
      // clean up the tmp and keep the raw file. finalize must never lose the
      // log or throw just because gzip failed.
      try {
        await pipeline(createReadStream(absPath), createGzip(), createWriteStream(tmpAbs));
        await fs.rename(tmpAbs, gzAbs);
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
        await fs.unlink(tmpAbs).catch(() => undefined);
        logger.warn(
          { err, logRef: handle.logRef },
          "run-log: compression failed; leaving raw log uncompressed",
        );
        return uncompressedSummary;
      }
    },

    async read(handle, opts) {
      if (handle.store !== "local_file") {
        throw notFound("Run log not found");
      }
      const offset = opts?.offset ?? 0;
      const limitBytes = opts?.limitBytes ?? 256_000;
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
  const basePath = process.env.RUN_LOG_BASE_PATH ?? path.resolve(resolvePaperclipInstanceRoot(), "data", "run-logs");
  cachedStore = createLocalFileRunLogStore(basePath);
  return cachedStore;
}
