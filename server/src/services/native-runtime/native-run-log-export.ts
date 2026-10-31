import { and, asc, desc, eq, gt, isNotNull, lte, not, or, sql } from "drizzle-orm";
import { StringDecoder } from "node:string_decoder";
import { heartbeatRunEvents, type Db } from "@paperclipai/db";
import { validatePrpEvent, type PrpEvent } from "../../vendor/paperclip-runner/index.js";
import { nativeSha256 } from "./canonical.js";
import type { RunLogHandle, RunLogStore } from "../run-log-store.js";

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

export function createNativeRunLogCoverageVerifier(
  db: Db,
  companyId: string,
  runId: string,
  options?: {
    allowSourceSuffix?: boolean;
    redactChunk?: (chunk: string) => string;
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
  async function line(value: string) {
    if (!value.trim()) return;
    if (Buffer.byteLength(value) > 1024 * 1024) throw unproven();
    let chunk: unknown;
    try {
      chunk = JSON.parse(value).chunk;
    } catch {
      throw unproven();
    }
    if (typeof chunk !== "string") throw unproven();
    let envelope: { type?: unknown; event?: unknown };
    try {
      envelope = JSON.parse(chunk);
    } catch {
      if (chunk.includes('"paperclip.prp.event"')) throw unproven();
      return;
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
    const expected = await next();
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
    if (options?.redactChunk) {
      // JSONB reorders object keys. Compare the complete redacted event
      // semantically while retaining the original published bytes.
      try {
        const expectedEnvelope = JSON.parse(options.redactChunk(formatNativeRunLogEvent(expected.event)));
        if (nativeSha256(event) !== nativeSha256(matchPublishedImageOmissions(expectedEnvelope.event, event)))
          throw unproven();
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
      if (Buffer.byteLength(text) > 1024 * 1024) throw unproven();
    },
    async finish() {
      text += decoder.end();
      if (text) await line(text);
      if (!options?.allowSourceSuffix && await next()) throw unproven();
      return cursor;
    },
  };
}

/** Prove the published source prefix before replaying an incomplete native log. */
export async function nativeRunLogPrefixCursor(input: {
  db: Db;
  companyId: string;
  runId: string;
  store: Partial<Pick<RunLogStore, "read">>;
  handle: RunLogHandle;
  redactChunk: (chunk: string) => string;
  signal?: AbortSignal;
}) {
  const bytes = input.handle.initialBytes ?? 0;
  const watermark = input.handle.initialSourceCursor ?? 0;
  if (!bytes && !watermark) return 0;
  const unproven = () => new Error("native_log_source_coverage_unproven");
  if (!input.store.read || !Number.isSafeInteger(bytes) || bytes < 0) throw unproven();
  const verifier = createNativeRunLogCoverageVerifier(input.db, input.companyId, input.runId, {
    allowSourceSuffix: true,
    redactChunk: input.redactChunk,
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
      if (queuedRecords >= 32 || queuedBytes + bytes > 8 * 1024 * 1024)
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
