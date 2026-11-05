import { and, asc, desc, eq, gt, isNotNull, lte, not, or, sql } from "drizzle-orm";
import { StringDecoder } from "node:string_decoder";
import { heartbeatRunEvents, type Db } from "@paperclipai/db";
import { validatePrpEvent, type PrpEvent } from "../../vendor/paperclip-runner/index.js";
import { nativeSha256 } from "./canonical.js";
import type { RunLogHandle, RunLogStore } from "../run-log-store.js";
import { compactRunLogChunk } from "../heartbeat/run-log.js";
import { MAX_RUN_LOG_RECORD_BYTES } from "../run-log-record-limits.js";

export function formatNativeRunLogEvent(event: PrpEvent) {
  return `${JSON.stringify({ type: "paperclip.prp.event", event })}\n`;
}
export function nativeRunLogSourceWhere(companyId: string, runId: string) {
  return and(
    eq(heartbeatRunEvents.companyId, companyId),
    eq(heartbeatRunEvents.runId, runId),
    isNotNull(heartbeatRunEvents.sourceEventId),
    not(
      sql`coalesce((${or(
        and(
          eq(heartbeatRunEvents.eventType, "auth.credentials.updated"),
          sql`${heartbeatRunEvents.sourceEventId} like 'credentials:%'`,
          sql`${heartbeatRunEvents.sourceInstanceId} like '%:credentials'`,
        ),
        and(
          eq(heartbeatRunEvents.eventType, "native.cleanup.event"),
          sql`${heartbeatRunEvents.sourceEventId} like 'cleanup:%'`,
          sql`${heartbeatRunEvents.sourceInstanceId} like '%:cleanup:%'`,
        ),
        and(
          eq(heartbeatRunEvents.eventType, "workspace.diff.recorded"),
          sql`${heartbeatRunEvents.sourceEventId} like 'provider-trace-reproject:%'`,
          sql`${heartbeatRunEvents.sourceInstanceId} like 'provider-trace-reproject:%'`,
        ),
      )}), false)`,
    ),
  );
}
async function sourcePage(
  db: Db,
  companyId: string,
  runId: string,
  after: number,
  through?: number,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const rows = await db
    .select({
      seq: heartbeatRunEvents.seq,
      payload: heartbeatRunEvents.payload,
      sourceInstanceId: heartbeatRunEvents.sourceInstanceId,
      sourceEventId: heartbeatRunEvents.sourceEventId,
      sourceSeq: heartbeatRunEvents.sourceSeq,
      sha256: heartbeatRunEvents.sourcePayloadSha256,
    })
    .from(heartbeatRunEvents)
    .where(
      and(
        nativeRunLogSourceWhere(companyId, runId),
        gt(heartbeatRunEvents.seq, after),
        through === undefined ? undefined : lte(heartbeatRunEvents.seq, through),
      ),
    )
    .orderBy(asc(heartbeatRunEvents.seq))
    .limit(16);
  signal?.throwIfAborted();
  return rows.map((row) => {
    const validated = validatePrpEvent(row.payload?.prpEvent);
    if (
      !validated.ok ||
      validated.event.runId !== runId ||
      validated.event.sourceInstanceId !== row.sourceInstanceId ||
      validated.event.sourceEventId !== row.sourceEventId ||
      validated.event.sourceSeq !== row.sourceSeq ||
      nativeSha256(validated.event) !== row.sha256
    )
      throw new Error("native_run_log_source_integrity_error");
    return { cursor: row.seq, event: validated.event };
  });
}

function matchPublishedImageOmissions(source: unknown, published: unknown): unknown {
  if (Array.isArray(source))
    return source.map((value, index) => matchPublishedImageOmissions(value,
      Array.isArray(published) ? published[index] : undefined));
  if (!source || typeof source !== "object") return source;
  const original = source as Record<string, unknown>;
  const existing = published && typeof published === "object"
    ? published as Record<string, unknown> : {};
  const result = Object.fromEntries(Object.entries(original).map(([key, value]) =>
    [key, matchPublishedImageOmissions(value, existing[key])]));
  const imageSource = original.source as Record<string, unknown> | undefined;
  const publishedSource = existing.source as Record<string, unknown> | undefined;
  if (original.type === "image" && imageSource?.type === "base64" &&
    typeof imageSource.data === "string" && typeof publishedSource?.data === "string") {
    const marker = /^\[omitted base64 image data: ([0-9]+) chars\]$/.exec(publishedSource.data);
    if (marker && marker[1] === String(imageSource.data.length) && imageSource.data.length >= 1024 &&
      /^[A-Za-z0-9+/=]+$/.test(imageSource.data)) {
      // The existing scrubber depends on serialized key order, which JSONB
      // does not retain. Honor only an omission already present at this path;
      // published raw data still has to match the source exactly.
      result.source = { ...(result.source as Record<string, unknown>), data: publishedSource.data };
    }
  }
  return result;
}

function matchesPublishedEvent(source: unknown, published: unknown) {
  return nativeSha256(published) === nativeSha256(matchPublishedImageOmissions(source, published));
}

/** Recover a compactor omission contained within one source-backed JSON string.
 * Retained properties may have any order: JSONB does not retain writer ordering.
 * Reconstruct the complete envelope, prove the exact compactor output, and then
 * compare every field semantically. A marker or matching substring alone is not proof.
 */
function restoreCompactedEvent(chunk: string, source: unknown): unknown {
  const marker = /\n\[paperclip truncated run log chunk: omitted ([1-9][0-9]*) chars\]\n/g;
  const found = marker.exec(chunk);
  if (!found || marker.exec(chunk)) return;
  const omitted = Number(found[1]);
  if (!Number.isSafeInteger(omitted)) return;
  const head = chunk.slice(0, found.index), tail = chunk.slice(found.index + found[0].length);
  let quoted = false, escaped = false, start = -1;
  for (let index = 0; index < head.length; index++) {
    const character = head[index];
    if (!quoted) {
      if (character === '"') { quoted = true; start = index; }
    } else if (escaped) escaped = false;
    else if (character === "\\") escaped = true;
    else if (character === '"') quoted = false;
  }
  if (!quoted) return;
  const leading = head.slice(start);
  function* strings(value: unknown): Generator<string> {
    if (typeof value === "string") yield value;
    else if (Array.isArray(value)) for (const child of value) yield* strings(child);
    else if (value && typeof value === "object")
      for (const child of Object.values(value)) yield* strings(child);
  }
  for (const value of strings(source)) {
    const encoded = JSON.stringify(value), end = leading.length + omitted;
    if (end >= encoded.length || !encoded.startsWith(leading) || !tail.startsWith(encoded.slice(end))) continue;
    const restored = head + encoded.slice(leading.length, end) + tail;
    if (compactRunLogChunk(restored) !== chunk) continue;
    try {
      const envelope = JSON.parse(restored);
      if (envelope.type === "paperclip.prp.event" && matchesPublishedEvent(source, envelope.event))
        return envelope;
    } catch { /* Another candidate cannot make malformed evidence authoritative. */ }
  }
}

export function createNativeRunLogCoverageVerifier(
  db: Db,
  companyId: string,
  runId: string,
  options?: {
    allowSourceSuffix?: boolean;
    redactChunks?: (chunk: string) => Iterable<string>;
    signal?: AbortSignal;
  },
) {
  const decoder = new StringDecoder("utf8");
  let text = "",
    cursor = 0;
  let page: Awaited<ReturnType<typeof sourcePage>> = [];
  const unproven = () => new Error("native_log_source_coverage_unproven");
  async function next() {
    if (!page.length) page = await sourcePage(db, companyId, runId, cursor, undefined, options?.signal);
    return page[0];
  }
  async function line(value: string, newlineBytes = 1) {
    if (!value.trim()) return;
    if (Buffer.byteLength(value) + newlineBytes > MAX_RUN_LOG_RECORD_BYTES) throw unproven();
    let chunk: unknown;
    try {
      chunk = JSON.parse(value).chunk;
    } catch {
      throw unproven();
    }
    if (typeof chunk !== "string") throw unproven();
    let expected: Awaited<ReturnType<typeof next>>;
    async function* sourceForms() {
      expected ??= await next();
      if (!expected) throw unproven();
      if (!options?.redactChunks) { yield expected.event; return; }
      for (const form of options.redactChunks(formatNativeRunLogEvent(expected.event))) {
        let candidate;
        try { candidate = JSON.parse(form); }
        catch { continue; } // A malformed historical privacy projection proves nothing.
        if (candidate?.type === "paperclip.prp.event" && candidate.event &&
          typeof candidate.event === "object" && !Array.isArray(candidate.event))
          yield candidate.event;
      }
    }
    let envelope: { type?: unknown; event?: unknown };
    try {
      envelope = JSON.parse(chunk);
    } catch {
      if (!chunk.includes('"paperclip.prp.event"')) return;
      let restored;
      for await (const form of sourceForms()) {
        restored = restoreCompactedEvent(chunk, form);
        if (restored) break;
      }
      if (!restored) throw unproven();
      envelope = restored;
    }
    if (envelope?.type !== "paperclip.prp.event") return;
    let event: PrpEvent;
    try {
      const parsed = validatePrpEvent(envelope.event);
      if (!parsed.ok) throw unproven();
      event = parsed.event;
    } catch {
      throw unproven();
    }
    expected ??= await next();
    if (
      !expected ||
      event.runId !== runId ||
      event.sourceInstanceId !== expected.event.sourceInstanceId ||
      event.sourceEventId !== expected.event.sourceEventId ||
      event.sourceSeq !== expected.event.sourceSeq ||
      event.normalizedSessionId !== expected.event.normalizedSessionId ||
      event.schemaVersion !== expected.event.schemaVersion ||
      event.eventType !== expected.event.eventType
    )
      throw unproven();
    if (options?.redactChunks) {
      // JSONB reorders object keys. Compare the complete redacted event
      // semantically while retaining the original published bytes.
      try {
        let matched = false;
        for await (const form of sourceForms()) {
          if (matchesPublishedEvent(form, event)) { matched = true; break; }
        }
        if (!matched) throw unproven();
      } catch {
        throw unproven();
      }
    }
    cursor = expected.cursor;
    page.shift();
  }
  return {
    async write(bytes: Buffer) {
      text += decoder.write(bytes);
      let boundary: number;
      while ((boundary = text.indexOf("\n")) !== -1) {
        await line(text.slice(0, boundary));
        text = text.slice(boundary + 1);
      }
      if (Buffer.byteLength(text) > MAX_RUN_LOG_RECORD_BYTES) throw unproven();
    },
    async finish() {
      text += decoder.end();
      if (text) await line(text, 0);
      if (!options?.allowSourceSuffix && await next()) throw unproven();
      return cursor;
    },
  };
}

/** Validate committed provenance, or prove an older unwatermarked source prefix. */
export async function nativeRunLogPrefixCursor(input: {
  db: Db;
  companyId: string;
  runId: string;
  store: Partial<Pick<RunLogStore, "read" | "recordVerifiedSourcePrefix">>;
  handle: RunLogHandle;
  redactChunks: (chunk: string) => Iterable<string>;
  signal?: AbortSignal;
}) {
  const bytes = input.handle.initialBytes ?? 0;
  const watermark = input.handle.initialSourceCursor ?? 0;
  const unproven = () => new Error("native_log_source_coverage_unproven");
  if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(watermark) || watermark < 0)
    throw unproven();
  if (!bytes && !watermark) {
    await input.store.recordVerifiedSourcePrefix?.(input.handle, 0);
    return 0;
  }
  if (input.handle.initialSourcePrefixVerified) {
    const sequence = input.handle.initialSequence ?? 0;
    const [company, , run, extra] = input.handle.logRef.split("/");
    if (input.handle.store !== "s3_segments" || company !== input.companyId || run !== input.runId || extra ||
      !bytes || !Number.isSafeInteger(sequence) || sequence < 1) throw unproven();
    // A separate immutable proof binds this exact journal index/end/sequence/cursor.
    // Legacy maximum-cursor metadata alone never establishes ordered coverage.
    // Only explicitly coverage-preserving appends can carry the proof forward;
    // an older writer's changed prefix gets no matching proof and must scan once.
    if (watermark) {
      const [source] = await sourcePage(input.db, input.companyId, input.runId,
        watermark - 1, watermark, input.signal);
      if (!source || source.cursor !== watermark) throw unproven();
    }
    return watermark;
  }
  if (!input.store.read) throw unproven();
  const verifier = createNativeRunLogCoverageVerifier(input.db, input.companyId, input.runId, {
    allowSourceSuffix: true,
    redactChunks: input.redactChunks,
    signal: input.signal,
  });
  let offset = 0;
  while (offset < bytes) {
    input.signal?.throwIfAborted();
    const page = await input.store.read(input.handle, {
      offset, limitBytes: Math.min(256_000, bytes - offset), signal: input.signal,
    });
    const content = Buffer.from(page.content);
    if (!content.length || offset + content.length > bytes) throw unproven();
    await verifier.write(content);
    offset += content.length;
  }
  const cursor = await verifier.finish();
  if (watermark > cursor) throw unproven();
  await input.store.recordVerifiedSourcePrefix?.(input.handle, cursor);
  return cursor;
}

export function createNativeRunLogExporter(input: {
  db: Db;
  companyId: string;
  runId: string;
  afterCursor: number;
  enqueue: (cursor: number, chunk: string) => Promise<void>;
  flush: () => Promise<void>;
  signal?: AbortSignal;
}) {
  let cursor = input.afterCursor;
  let queue = Promise.resolve();
  let queuedBytes = 0,
    queuedRecords = 0;
  const sourceWhere = nativeRunLogSourceWhere(input.companyId, input.runId);
  async function replay(through?: number) {
    input.signal?.throwIfAborted();
    if (through === undefined) {
      const [last] = await input.db
        .select({ seq: heartbeatRunEvents.seq })
        .from(heartbeatRunEvents)
        .where(sourceWhere)
        .orderBy(desc(heartbeatRunEvents.seq))
        .limit(1);
      through = last?.seq ?? cursor;
    }
    while (cursor < through) {
      const rows = await sourcePage(
        input.db,
        input.companyId,
        input.runId,
        cursor,
        through,
        input.signal,
      );
      if (!rows.length) break;
      for (const row of rows) {
        input.signal?.throwIfAborted();
        await input.enqueue(row.cursor, formatNativeRunLogEvent(row.event));
        cursor = row.cursor;
      }
      await input.flush();
    }
  }
  return {
    recover: () => replay(),
    async record(sourceCursor: number, chunk: string) {
      if (!Number.isSafeInteger(sourceCursor) || sourceCursor < 1)
        throw new Error("invalid_native_run_log_cursor");
      const bytes = Buffer.byteLength(chunk);
      if (queuedRecords >= 32 || queuedBytes + bytes > MAX_RUN_LOG_RECORD_BYTES)
        throw new Error("native_run_log_admission_capacity_exceeded");
      queuedRecords++;
      queuedBytes += bytes;
      const work = queue
        .then(async () => {
          if (sourceCursor <= cursor) return;
          if (sourceCursor > cursor + 1) await replay(sourceCursor - 1);
          await input.enqueue(sourceCursor, chunk);
          cursor = sourceCursor;
        })
        .finally(() => {
          queuedRecords--;
          queuedBytes -= bytes;
        });
      queue = work.catch(() => undefined);
      await work;
    },
  };
}
