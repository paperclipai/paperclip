import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createHash, randomUUID } from "node:crypto";
import { addAbortSignal } from "node:stream";
import { notFound } from "../errors.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { createS3StorageProvider } from "../storage/s3-provider.js";
import type { StorageProvider } from "../storage/types.js";

export type RunLogStoreType = "local_file";

export interface RunLogHandle {
  store: RunLogStoreType;
  logRef: string;
  attemptId?: string;
}

export interface RunLogReadOptions {
  offset?: number;
  limitBytes?: number;
  signal?: AbortSignal;
  /** Recheck historical run logs before serving company-readable byte ranges. */
  redactPostgresCredentials?: boolean;
}

export interface RunLogReadResult {
  content: string;
  nextOffset?: number;
}

type RawRunLogReadResult = { bytes: Buffer; nextOffset?: number };
const POSTGRES_URI_READ_CONTEXT_BYTES = 256 * 1024;
const POSTGRES_URI_SCHEME_RE = /postgres(?:ql)?:\/\//gi;
const RUN_LOG_TRUNCATION_MARKER_RE = /^\n\[paperclip truncated run log chunk: omitted \d+ chars\]\n/;

type MappedChunk = { text: string; starts: number[]; ends: number[] };

function mappedRunLogChunk(line: string, lineStart: number): MappedChunk | null {
  const field = /"chunk"\s*:\s*"/.exec(line);
  if (!field) return null;
  const starts: number[] = [];
  const ends: number[] = [];
  let text = "";
  let index = field.index + field[0].length;
  while (index < line.length && line[index] !== '"') {
    const start = index;
    let decoded: string;
    if (line[index] === "\\") {
      index += line[index + 1] === "u" ? 6 : 2;
      if (index > line.length) return null;
      decoded = JSON.parse(`"${line.slice(start, index)}"`) as string;
    } else {
      decoded = line[index]!;
      index += 1;
    }
    text += decoded;
    for (let character = 0; character < decoded.length; character += 1) {
      starts.push(lineStart + start);
      ends.push(lineStart + index);
    }
  }
  return index < line.length ? { text, starts, ends } : null;
}

/** Mask only chunk bytes, preserving NDJSON framing and original API offsets. */
function maskPostgresCredentialsInRange(
  bytes: Buffer,
  pageStart: number,
  pageEnd: number,
  sourceOffset: number,
  rightTruncated: boolean,
) {
  const source = bytes.toString("latin1");
  const streams = new Map<string, MappedChunk>();
  const maskUnclassifiedLine = (start: number, end: number) => {
    const maskStart = Math.max(pageStart, start);
    const maskEnd = Math.min(pageEnd, end);
    if (maskStart < maskEnd) bytes.fill(0x2a, maskStart, maskEnd);
  };
  for (let lineStart = 0; lineStart < source.length;) {
    const newline = source.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? source.length : newline;
    const line = source.slice(lineStart, lineEnd);
    if (line.length) {
      try {
        const record = JSON.parse(line) as { stream?: unknown; chunk?: unknown };
        const streamName = record.stream;
        const chunk = record.chunk;
        if (typeof streamName !== "string" || typeof chunk !== "string") {
          maskUnclassifiedLine(lineStart, lineEnd);
        } else {
          const mapped = mappedRunLogChunk(line, lineStart);
          if (!mapped || mapped.text !== chunk) {
            maskUnclassifiedLine(lineStart, lineEnd);
          } else {
            const stream = streams.get(streamName) ?? { text: "", starts: [], ends: [] };
            stream.text += mapped.text;
            for (let index = 0; index < mapped.starts.length; index += 1) {
              stream.starts.push(mapped.starts[index]!);
              stream.ends.push(mapped.ends[index]!);
            }
            streams.set(streamName, stream);
          }
        }
      } catch {
        // A bounded range can start or end inside a historical oversized
        // record. Its chunk may contain escaped bytes or a URL completed in
        // another record, so no substring of the partial line is provably safe.
        maskUnclassifiedLine(lineStart, lineEnd);
      }
    }
    if (newline < 0) break;
    lineStart = newline + 1;
  }

  for (const stream of streams.values()) {
    const maskCharacters = (start: number, end: number) => {
      for (let index = start; index < end; index += 1) {
        bytes.fill(0x2a, stream.starts[index], stream.ends[index]);
      }
    };
    // If the bounded lookbehind began inside a prior chunk, its URL scheme
    // may be outside this read. Hide the first undecidable token on each stream.
    if (sourceOffset > 0) {
      const firstScheme = stream.text.search(POSTGRES_URI_SCHEME_RE);
      const firstBoundary = stream.text.search(/[\s@]/);
      const end = Math.min(
        firstScheme < 0 ? stream.text.length : firstScheme,
        firstBoundary < 0 ? stream.text.length : firstBoundary,
      );
      maskCharacters(0, end);
    }
    POSTGRES_URI_SCHEME_RE.lastIndex = 0;
    for (const match of stream.text.matchAll(POSTGRES_URI_SCHEME_RE)) {
      const userinfoStart = match.index + match[0].length;
      let end = userinfoStart;
      while (end < stream.text.length && !/[@\s"`<>\\/?#]/.test(stream.text[end]!)) end += 1;
      // Older writers truncated a chunk after redaction, leaving a partial
      // authority before this marker even when the following tail has no @.
      const cutByMarker = RUN_LOG_TRUNCATION_MARKER_RE.test(stream.text.slice(end));
      if (stream.text[end] === "@" || cutByMarker || (end === stream.text.length &&
        (rightTruncated || stream.text.slice(userinfoStart, end).includes(":")))) {
        maskCharacters(userinfoStart, end);
      }
    }
  }
}

export interface RunLogFinalizeSummary {
  // Null means a stalled write prevented a verified final snapshot. Callers
  // can still settle the run without recording a false byte count or hash.
  bytes: number | null;
  sha256?: string | null;
  compressed: boolean;
}

export interface RunLogStore {
  begin(input: { companyId: string; agentId: string; runId: string }): Promise<RunLogHandle>;
  append(
    handle: RunLogHandle,
    event: { stream: "stdout" | "stderr" | "system"; chunk: string; ts: string; seq?: number },
  ): Promise<number>;
  finalize(handle: RunLogHandle): Promise<RunLogFinalizeSummary>;
  read(handle: RunLogHandle, opts?: RunLogReadOptions): Promise<RunLogReadResult>;
  // Optional so existing fakes/fixtures keep compiling: uploads every dirty
  // in-flight mirror immediately (graceful-shutdown path). No-op when the
  // in-flight mirror is not enabled.
  flushInflightMirrors?(): Promise<void>;
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

function normalizeKeyPrefix(prefix: string | undefined): string {
  if (!prefix) return "";
  return prefix.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

export interface DurableRunLogStoreOptions {
  basePath: string;
  // When provided, completed logs are mirrored to object storage on finalize and
  // served from there on read whenever the local file is missing (e.g. the pod
  // rolled and wiped the emptyDir). When omitted, the store is local-only (the
  // historical behaviour: a restart loses the log).
  s3?: {
    provider: StorageProvider;
    keyPrefix?: string;
    // When > 0, ALSO mirror the still-running log to the same object key at
    // most once per this interval (plus a flush hook for graceful shutdown),
    // so a crash mid-run loses at most one interval's tail instead of the
    // whole log. Off (undefined/0) preserves the historical finalize-only
    // mirroring: no extra PUT traffic unless explicitly opted in.
    inflightMirrorMs?: number;
  };
}

// Run-log store with TRANSPARENT durability. The store id stays "local_file" so
// nothing downstream (feedback.ts, the heartbeat read cast, fixtures) changes;
// the S3 mirror is keyed by the same logRef and is purely an implementation
// detail. Live append/tail stays on the pod-local file (fast, no per-chunk PUT);
// on finalize the complete .ndjson is uploaded to object storage; on read we try
// local first and fall back to S3 when the local file is gone. This is the fix
// for "Run log not found" after a deploy/restart (the /paperclip data dir is an
// emptyDir in cloud_tenant mode -- persistence is disabled to avoid the
// operator's privileged selinux-relabel init container in our hardened ns).
//
// Optionally (inflightMirrorMs > 0) the still-running log is ALSO mirrored to
// the same key at a throttled cadence and flushed on graceful shutdown, so a
// restart mid-run preserves the tail up to the last mirror instead of losing
// the whole in-flight log. Finalize retires the in-flight bookkeeping (waiting
// out any upload already on the wire) before writing the complete file, so a
// stale partial can never overwrite a finalized log.
export function createDurableRunLogStore(options: DurableRunLogStoreOptions): RunLogStore {
  const { basePath } = options;
  const s3 = options.s3;
  const s3Prefix = normalizeKeyPrefix(s3?.keyPrefix);
  const inflightMirrorMs = s3?.inflightMirrorMs && s3.inflightMirrorMs > 0 ? s3.inflightMirrorMs : 0;
  // A run owns the write handle returned by begin(). Diagnostics can be
  // dispatched without awaiting the rest of onLog (DB progress/live events),
  // but finalize must include every file append already accepted on that handle.
  // Weak collections let completed handles disappear with their owning runs.
  const pendingAppends = new WeakMap<RunLogHandle, Set<Promise<void>>>();
  const closingHandles = new WeakSet<RunLogHandle>();
  const abandonedHandles = new WeakSet<RunLogHandle>();

  function s3Key(logRef: string): string {
    return s3Prefix ? `${s3Prefix}/${logRef}` : logRef;
  }

  // In-flight mirror bookkeeping, keyed by logRef. The mirror uploads the
  // CURRENT (partial) file to the SAME key finalize uses: readers already
  // range-read that key, so a partial object is served exactly like a live
  // tail, and finalize simply overwrites it with the complete file. One
  // entry exists only between the first post-interval-eligible append and
  // finalize.
  interface InflightMirrorEntry {
    dirty: boolean;
    lastMirrorAt: number;
    timer: NodeJS.Timeout | null;
    upload: Promise<boolean> | null;
  }
  const inflightMirrors = new Map<string, InflightMirrorEntry>();

  function mirrorInflightNow(logRef: string, entry: InflightMirrorEntry): Promise<boolean> {
    entry.dirty = false;
    const upload = (async () => {
      const absPath = resolveWithin(basePath, logRef);
      const stat = await fs.stat(absPath);
      if (stat.size === 0) return true;
      await s3!.provider.putObject({
        objectKey: s3Key(logRef),
        // Bound the stream to the stat'ed size: the run is still appending,
        // and an unbounded stream that grows past stat.size would violate
        // the declared contentLength and fail (or truncate) the upload.
        // Bytes appended after the stat stay dirty and ride the next mirror.
        body: createReadStream(absPath, { start: 0, end: stat.size - 1 }),
        contentType: "application/x-ndjson",
        contentLength: stat.size,
      });
      return true;
    })().catch((err) => {
      // Best-effort like the finalize mirror: a failing upload must never
      // break the run, but a persistently broken mirror should be visible.
      console.warn(
        `[run-log-store] Failed to mirror in-flight run log to object storage (key: ${s3Key(logRef)}):`,
        err,
      );
      // Re-dirty so the tail retries next interval even without new appends;
      // the lastMirrorAt stamp below bounds retries to one per interval.
      entry.dirty = true;
      return false;
    }).finally(() => {
      // Stamp AFTER the attempt so a slow or failing endpoint self-throttles
      // to one attempt per interval instead of hot-looping.
      entry.lastMirrorAt = Date.now();
      entry.upload = null;
      if (entry.dirty) scheduleInflightMirror(logRef, entry);
    });
    entry.upload = upload;
    return upload;
  }

  function scheduleInflightMirror(logRef: string, entry: InflightMirrorEntry): void {
    if (inflightMirrors.get(logRef) !== entry) return;
    if (entry.timer || entry.upload) return;
    const delay = Math.max(0, inflightMirrorMs - (Date.now() - entry.lastMirrorAt));
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void mirrorInflightNow(logRef, entry);
    }, delay);
    // Never keep the process alive just to mirror a tail.
    entry.timer.unref?.();
  }

  function noteInflightAppend(logRef: string): void {
    if (!s3 || inflightMirrorMs <= 0) return;
    let entry = inflightMirrors.get(logRef);
    if (!entry) {
      // First mirror lands one full interval after the first append: a run
      // that finalizes sooner is covered by the finalize upload, and this
      // keeps the steady-state cost at one PUT per interval per active run.
      entry = { dirty: false, lastMirrorAt: Date.now(), timer: null, upload: null };
      inflightMirrors.set(logRef, entry);
    }
    entry.dirty = true;
    scheduleInflightMirror(logRef, entry);
  }

  async function retireInflightMirror(logRef: string): Promise<void> {
    const entry = inflightMirrors.get(logRef);
    if (!entry) return;
    inflightMirrors.delete(logRef);
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    // An upload still in flight could otherwise finish AFTER finalize's
    // complete-file upload and overwrite it with a stale partial.
    if (entry.upload) await entry.upload;
  }

  async function ensureDir(relativeDir: string) {
    const dir = resolveWithin(basePath, relativeDir);
    await fs.mkdir(dir, { recursive: true });
  }

  async function readLocalRange(
    filePath: string,
    offset: number,
    limitBytes: number,
    signal?: AbortSignal,
  ): Promise<RawRunLogReadResult | null> {
    signal?.throwIfAborted();
    const start = Math.max(0, offset);
    // Read one extra byte to discover whether another page exists. A single
    // abortable stream avoids an uncancellable stat before opening the file.
    const chunks: Buffer[] = [];
    try {
      const stream = createReadStream(filePath, { start, end: start + limitBytes, signal });
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    } catch (err) {
      signal?.throwIfAborted();
      // A missing file, including deletion before open, falls back to S3.
      if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return null;
      throw err;
    }
    signal?.throwIfAborted();
    const bytes = Buffer.concat(chunks);
    const content = bytes.subarray(0, limitBytes);
    const nextOffset = bytes.length > limitBytes ? start + limitBytes : undefined;
    return { bytes: content, nextOffset };
  }

  async function readS3Range(
    logRef: string,
    offset: number,
    limitBytes: number,
    signal?: AbortSignal,
  ): Promise<RawRunLogReadResult> {
    signal?.throwIfAborted();
    if (!s3) throw notFound("Run log not found");
    const key = s3Key(logRef);
    const head = await s3.provider.headObject({ objectKey: key, signal });
    signal?.throwIfAborted();
    if (!head.exists) throw notFound("Run log not found");
    const total = head.contentLength ?? 0;
    const start = Math.max(0, Math.min(offset, total));
    // Unlike local file streams, S3 rejects a range that starts at or past
    // EOF with 416 InvalidRange, so a caught-up reader (offset === total)
    // must short-circuit to an empty read instead of clamping end up to
    // start and requesting `bytes=total-total`.
    const end = Math.min(start + limitBytes - 1, total - 1);
    if (total === 0 || start > end) return { bytes: Buffer.alloc(0), nextOffset: start < total ? start : undefined };

    const result = await s3.provider.getObject({ objectKey: key, range: { start, end }, signal });
    // Destroy a body that stalls after headers arrive, including a body
    // returned just after the caller cancelled the request.
    if (signal) addAbortSignal(signal, result.stream);
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    signal?.throwIfAborted();
    const content = Buffer.concat(chunks);
    const nextOffset = end + 1 < total ? end + 1 : undefined;
    return { bytes: content, nextOffset };
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

  return {
    async begin(input) {
      const [companyId, agentId] = safeSegments(input.companyId, input.agentId);
      const runId = safeSegments(input.runId)[0]!;
      const relDir = path.join(companyId, agentId);
      const relPath = path.join(relDir, `${runId}.ndjson`);
      await ensureDir(relDir);
      const absPath = resolveWithin(basePath, relPath);
      await retireInflightMirror(relPath);
      // Retries share a run ID. Never truncate their earlier evidence. On a
      // new pod, restore the durable prefix before opening another attempt.
      const exists = await fs.stat(absPath).then(() => true, (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
      if (!exists && s3) {
        const key = s3Key(relPath);
        const head = await s3.provider.headObject({ objectKey: key });
        if (head.exists) {
          const temporary = `${absPath}.${randomUUID()}.restore`;
          try {
            const object = await s3.provider.getObject({ objectKey: key });
            await pipeline(object.stream, createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
            if (typeof head.contentLength === "number" && (await fs.stat(temporary)).size !== head.contentLength) {
              throw new Error("Durable run log restore returned an incomplete prefix");
            }
            // Publish the complete prefix without replacing a file another
            // attempt has already restored and started appending to.
            await fs.link(temporary, absPath).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "EEXIST") throw error;
            });
          } finally {
            await fs.rm(temporary, { force: true });
          }
        }
      }
      const file = await fs.open(absPath, "a", 0o600);
      await file.close();
      return { store: "local_file", logRef: relPath, attemptId: randomUUID() };
    },

    async append(handle, event) {
      if (handle.store !== "local_file" || closingHandles.has(handle)) return 0;
      const absPath = resolveWithin(basePath, handle.logRef);
      const line = JSON.stringify({
        ts: event.ts,
        ...(handle.attemptId ? { attemptId: handle.attemptId } : {}),
        stream: event.stream,
        chunk: event.chunk,
        // Monotonic per-run sequence so readers can dedupe and order records
        // even when several identical chunks share the same millisecond ts
        // (common for ACP-style token deltas).
        ...(typeof event.seq === "number" && Number.isFinite(event.seq) ? { seq: event.seq } : {}),
      });
      const persisted = `${line}\n`;
      let pending = pendingAppends.get(handle);
      if (!pending) {
        pending = new Set();
        pendingAppends.set(handle, pending);
      }
      const write = fs.appendFile(absPath, persisted, "utf8").then(() => {
        if (!closingHandles.has(handle)) noteInflightAppend(handle.logRef);
      });
      pending.add(write);
      try {
        await write;
      } finally {
        pending.delete(write);
      }
      return Buffer.byteLength(persisted, "utf8");
    },

    async finalize(handle) {
      if (handle.store !== "local_file") return { bytes: 0, compressed: false };
      if (abandonedHandles.has(handle)) return { bytes: null, sha256: null, compressed: false };
      // Close admission before the first await. Drain file writes only, not
      // heartbeat's later DB/live-event persistence, then freeze one consistent
      // byte count, hash, and durable copy. Late diagnostics cannot mutate it.
      closingHandles.add(handle);
      let drainTimer: NodeJS.Timeout | undefined;
      const drained = await Promise.race([
        Promise.allSettled(pendingAppends.get(handle) ?? []).then(() => true),
        new Promise<boolean>((resolve) => {
          drainTimer = setTimeout(() => resolve(false), 3_000);
          drainTimer.unref?.();
        }),
      ]).finally(() => clearTimeout(drainTimer));
      if (!drained) {
        // An in-flight fs append cannot be cancelled safely. Do not hash or
        // mirror a file it may still change, and never re-arm mirroring when
        // that write eventually finishes. Terminal run status can still settle.
        abandonedHandles.add(handle);
        void retireInflightMirror(handle.logRef).catch(() => undefined);
        console.warn("[run-log-store] Pending log writes did not settle within 3000ms; final log size and hash are unknown.");
        return { bytes: null, sha256: null, compressed: false };
      }
      await retireInflightMirror(handle.logRef);
      const absPath = resolveWithin(basePath, handle.logRef);
      const stat = await fs.stat(absPath).catch(() => null);
      if (!stat) throw notFound("Run log not found");
      const hash = await sha256File(absPath);

      // Mirror the completed log to object storage so it survives a pod roll.
      // Best-effort upload failures must NOT fail run finalization (which also
      // records cost/usage); the local copy still serves reads until the pod
      // rolls, and a failed mirror only loses durability for that one run.
      if (s3) {
        try {
          // Stream from disk instead of buffering the whole .ndjson in the
          // heap; long agent sessions can produce large logs. The file is
          // complete at this point, so stat.size is the exact content length.
          await s3.provider.putObject({
            objectKey: s3Key(handle.logRef),
            body: createReadStream(absPath),
            contentType: "application/x-ndjson",
            contentLength: stat.size,
          });
        } catch (err) {
          // Best-effort: finalization must not break, but a persistently
          // failing mirror (bad creds/bucket/endpoint) should be visible to
          // operators before a pod roll makes the logs unreadable.
          console.warn(
            `[run-log-store] Failed to mirror run log to object storage (key: ${s3Key(handle.logRef)}):`,
            err,
          );
        }
      }

      return { bytes: stat.size, sha256: hash, compressed: false };
    },

    async read(handle, opts) {
      opts?.signal?.throwIfAborted();
      if (handle.store !== "local_file") throw notFound("Run log not found");
      const absPath = resolveWithin(basePath, handle.logRef);
      const offset = Math.max(0, opts?.offset ?? 0);
      const limitBytes = opts?.limitBytes ?? 256_000;
      const contextStart = opts?.redactPostgresCredentials
        ? Math.max(0, offset - POSTGRES_URI_READ_CONTEXT_BYTES)
        : offset;
      const prefixBytes = offset - contextStart;
      const readBytes = opts?.redactPostgresCredentials
        ? prefixBytes + limitBytes + POSTGRES_URI_READ_CONTEXT_BYTES
        : limitBytes;
      const local = await readLocalRange(absPath, contextStart, readBytes, opts?.signal);
      // Local file gone (pod rolled) -> serve from the S3 mirror if configured.
      const result = local ?? await readS3Range(handle.logRef, contextStart, readBytes, opts?.signal);
      if (!opts?.redactPostgresCredentials) {
        return { content: result.bytes.toString("utf8"), nextOffset: result.nextOffset };
      }
      if (prefixBytes >= result.bytes.length) {
        return { content: "", nextOffset: undefined };
      }
      const pageEnd = Math.min(result.bytes.length, prefixBytes + limitBytes);
      maskPostgresCredentialsInRange(
        result.bytes,
        prefixBytes,
        pageEnd,
        contextStart,
        result.nextOffset !== undefined,
      );
      return {
        content: result.bytes.subarray(prefixBytes, pageEnd).toString("utf8"),
        nextOffset: result.bytes.length > prefixBytes + limitBytes || result.nextOffset !== undefined
          ? offset + limitBytes
          : undefined,
      };
    },

    async flushInflightMirrors() {
      if (!s3 || inflightMirrorMs <= 0) return;
      const flushEntry = async (logRef: string, entry: InflightMirrorEntry) => {
        // Loop until the entry is clean: an append that lands while an
        // upload is on the wire re-dirties the entry, and its follow-up
        // mirror sits on an unref'ed timer that would never fire once the
        // process exits — so re-check after every await instead of trusting
        // a single pass. A FAILED attempt ends the loop instead of retrying:
        // hot-looping a down endpoint at shutdown would spin forever, and
        // the flush is best-effort by design.
        for (;;) {
          if (entry.timer) {
            clearTimeout(entry.timer);
            entry.timer = null;
          }
          if (entry.upload) {
            await entry.upload;
            continue;
          }
          if (!entry.dirty) return;
          const uploaded = await mirrorInflightNow(logRef, entry);
          if (!uploaded) {
            if (entry.timer) {
              clearTimeout(entry.timer);
              entry.timer = null;
            }
            return;
          }
        }
      };
      await Promise.all([...inflightMirrors].map(([logRef, entry]) => flushEntry(logRef, entry)));
    },
  };
}

// Build the run-log S3 mirror from dedicated RUN_LOG_S3_* env. Deliberately
// separate from PAPERCLIP_STORAGE_PROVIDER so enabling durable run logs does
// NOT redirect the product's workspace/file storage (smaller blast radius).
// Unset RUN_LOG_S3_BUCKET -> no mirror -> local-only (safe degrade). Creds come
// from the standard AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY chain.
function resolveRunLogS3(): DurableRunLogStoreOptions["s3"] {
  const bucket = process.env.RUN_LOG_S3_BUCKET?.trim();
  if (!bucket) return undefined;
  const provider = createS3StorageProvider({
    bucket,
    region: process.env.RUN_LOG_S3_REGION?.trim() || "us-east-1",
    endpoint: process.env.RUN_LOG_S3_ENDPOINT?.trim() || undefined,
    prefix: undefined, // prefixing is handled by keyPrefix below (kept off the provider)
    forcePathStyle: process.env.RUN_LOG_S3_FORCE_PATH_STYLE
      ? process.env.RUN_LOG_S3_FORCE_PATH_STYLE === "true"
      : true, // Cubbit (and most S3-compatible endpoints) need path-style
  });
  // Opt-in in-flight tail mirroring: at most one partial upload per interval
  // per active run, so a crash loses at most one interval's tail. Unset/0
  // keeps the historical finalize-only mirroring.
  const inflightSeconds = Number.parseFloat(process.env.RUN_LOG_S3_INFLIGHT_MIRROR_SECONDS ?? "");
  return {
    provider,
    keyPrefix: process.env.RUN_LOG_S3_PREFIX?.trim() || "run-logs",
    inflightMirrorMs:
      Number.isFinite(inflightSeconds) && inflightSeconds > 0 ? Math.round(inflightSeconds * 1000) : undefined,
  };
}

let cachedStore: RunLogStore | null = null;

export function getRunLogStore() {
  if (cachedStore) return cachedStore;
  const basePath = process.env.RUN_LOG_BASE_PATH ?? path.resolve(resolvePaperclipInstanceRoot(), "data", "run-logs");
  cachedStore = createDurableRunLogStore({ basePath, s3: resolveRunLogS3() });
  return cachedStore;
}

// Graceful-shutdown hook: upload every dirty in-flight run-log tail before
// the process exits, so an orderly restart (deploy, SIGTERM) loses nothing
// even for runs that never reach finalize. No-op when the store was never
// created or in-flight mirroring is off.
export async function flushInFlightRunLogMirrors(): Promise<void> {
  await cachedStore?.flushInflightMirrors?.();
}
