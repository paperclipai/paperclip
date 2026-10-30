import { and, asc, desc, eq, gt, isNotNull, lte } from "drizzle-orm";
import { heartbeatRunEvents, type Db } from "@paperclipai/db";
import { validatePrpEvent, type PrpEvent } from "../../vendor/paperclip-runner/index.js";
import { nativeSha256 } from "./canonical.js";

export function formatNativeRunLogEvent(event: PrpEvent) {
  return `${JSON.stringify({ type: "paperclip.prp.event", event })}\n`;
}

export function createNativeRunLogExporter(input: {
  db: Db;
  companyId: string;
  runId: string;
  afterCursor: number;
  enqueue: (cursor: number, chunk: string) => Promise<void>;
  flush: () => Promise<void>;
}) {
  let cursor = input.afterCursor;
  let queue = Promise.resolve();
  let queuedBytes = 0,
    queuedRecords = 0;
  const sourceWhere = and(
    eq(heartbeatRunEvents.companyId, input.companyId),
    eq(heartbeatRunEvents.runId, input.runId),
    isNotNull(heartbeatRunEvents.sourceEventId),
  );
  async function replay(through?: number) {
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
      const rows = await input.db
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
            sourceWhere,
            gt(heartbeatRunEvents.seq, cursor),
            lte(heartbeatRunEvents.seq, through),
          ),
        )
        .orderBy(asc(heartbeatRunEvents.seq))
        .limit(16);
      if (!rows.length) break;
      for (const row of rows) {
        const value = row.payload?.prpEvent;
        const validated = validatePrpEvent(value);
        if (
          !validated.ok ||
          validated.event.runId !== input.runId ||
          validated.event.sourceInstanceId !== row.sourceInstanceId ||
          validated.event.sourceEventId !== row.sourceEventId ||
          validated.event.sourceSeq !== row.sourceSeq ||
          nativeSha256(validated.event) !== row.sha256
        )
          throw new Error("native_run_log_source_integrity_error");
        await input.enqueue(row.seq, formatNativeRunLogEvent(validated.event));
        cursor = row.seq;
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
