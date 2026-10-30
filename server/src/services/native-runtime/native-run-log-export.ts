import { and, asc, desc, eq, gt, isNotNull, lte, not, or, sql } from "drizzle-orm";
import { StringDecoder } from "node:string_decoder";
import { heartbeatRunEvents, type Db } from "@paperclipai/db";
import { validatePrpEvent, type PrpEvent } from "../../vendor/paperclip-runner/index.js";
import { nativeSha256 } from "./canonical.js";

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

export function createNativeRunLogCoverageVerifier(db: Db, companyId: string, runId: string) {
  const decoder = new StringDecoder("utf8");
  let text = "",
    cursor = 0;
  let page: Awaited<ReturnType<typeof sourcePage>> = [];
  const unproven = () => new Error("native_log_source_coverage_unproven");
  async function next() {
    if (!page.length) page = await sourcePage(db, companyId, runId, cursor);
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
    if (typeof chunk !== "string" || !chunk.startsWith('{"type":"paperclip.prp.event"')) return;
    let event: PrpEvent;
    try {
      const parsed = validatePrpEvent(JSON.parse(chunk).event);
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
      if (await next()) throw unproven();
      return cursor;
    },
  };
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
