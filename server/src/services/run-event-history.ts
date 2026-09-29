import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { heartbeatRunEvents, heartbeatRuns, heartbeatRunEventEpochs, heartbeatRunEventHeads, heartbeatRunEventLinks, type Db } from "@paperclipai/db";

export const RUN_EVENT_EPOCH_LIMIT = 1_000_000;
const epochPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type RunEventPosition = { eventEpoch: string; seq: number };
export function runEventCursor(row: RunEventPosition): string {
  return row.eventEpoch ? `e:${row.eventEpoch}:${row.seq}` : String(row.seq);
}
export function parseRunEventCursor(value: number | string): RunEventPosition {
  const encoded = String(value);
  const match = /^e:([^:]+):(0|[1-9][0-9]*)$/.exec(encoded);
  const ordinal = match?.[2] ?? encoded;
  if ((!match && !/^(0|[1-9][0-9]*)$/.test(encoded)) || (match && !epochPattern.test(match[1]))) throw new Error("invalid_run_event_cursor");
  const seq = Number(ordinal);
  if (!Number.isSafeInteger(seq) || seq < 0) throw new Error("invalid_run_event_cursor");
  return { eventEpoch: match?.[1] ?? "", seq };
}
export function runEventLane(kind: "type" | "request" | "provider-session", key: string): string {
  return `${kind}:${createHash("sha256").update(key).digest("hex")}`;
}

export function runEventSettlementLane(sourceInstanceId: string, turnId?: string): string {
  const key = `${Buffer.byteLength(sourceInstanceId)}:${sourceInstanceId}:${turnId ?? ""}`;
  return `settlement:${createHash("sha256").update(key).digest("hex")}`;
}

export function runEventExhaustionLane(input: { retryReason: string; scheduledRetryAttempt: number; maxAttempts: number }): string {
  const key = `${Buffer.byteLength(input.retryReason)}:${input.retryReason}:${input.scheduledRetryAttempt}:${input.maxAttempts}`;
  return `exhaustion-receipt:${createHash("sha256").update(key).digest("hex")}`;
}

/** Caller must append in this transaction. The run lock serializes allocation,
 * rotation, index maintenance and every native/legacy writer. */
export async function allocateRunEventPosition(db: Db, runId: string, epochLimit = RUN_EVENT_EPOCH_LIMIT): Promise<RunEventPosition> {
  if (!Number.isSafeInteger(epochLimit) || epochLimit < 2 || epochLimit > RUN_EVENT_EPOCH_LIMIT) throw new Error("invalid_run_event_epoch_limit");
  const [run] = await db.select({ eventEpoch: heartbeatRuns.eventEpoch, seq: heartbeatRuns.nextEventSeq, companyId: heartbeatRuns.companyId })
    .from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).for("update");
  if (!run) throw new Error("heartbeat_run_event_binding_mismatch");
  if (!Number.isSafeInteger(run.seq) || run.seq < 1) throw new Error("invalid_run_event_head");
  let position: RunEventPosition = run;
  if (run.seq > epochLimit) {
    let nextEpoch: string | undefined;
    for (let attempt = 0; attempt < 32; attempt++) {
      const candidate = randomUUID();
      if (candidate === run.eventEpoch) continue;
      const [used] = await db.select({ epoch: heartbeatRunEventEpochs.epoch }).from(heartbeatRunEventEpochs)
        .where(and(eq(heartbeatRunEventEpochs.runId, runId), eq(heartbeatRunEventEpochs.epoch, candidate))).limit(1);
      if (!used) { nextEpoch = candidate; break; }
    }
    if (!nextEpoch) throw new Error("run_event_epoch_identity_unavailable");
    await db.insert(heartbeatRunEventEpochs).values({ companyId: run.companyId, runId, epoch: run.eventEpoch, nextEpoch, finalSeq: run.seq - 1 });
    position = { eventEpoch: nextEpoch, seq: 1 };
  }
  await db.update(heartbeatRuns).set({ eventEpoch: position.eventEpoch, nextEventSeq: position.seq + 1, updatedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
  return { eventEpoch: position.eventEpoch, seq: position.seq };
}

/** Newest first, bounded in both index probes and materialized rows. The CTE
 * follows exact predecessor keys; epoch count and unrelated output do not enter
 * the query plan. Hydrate through Drizzle to preserve encoded NUL payloads. */
export async function readRunEventLaneIds(db: Db, runId: string, lane: string, limit = 200, beforeId?: string | number): Promise<string[]> {
  const count = Math.max(1, Math.min(1001, Math.floor(limit)));
  const anchor = beforeId === undefined
    ? sql`select ${heartbeatRunEventHeads.eventId}, 1 from ${heartbeatRunEventHeads}
        where ${heartbeatRunEventHeads.runId} = ${runId} and ${heartbeatRunEventHeads.lane} = ${lane}`
    : sql`select ${heartbeatRunEventLinks.previousId}, 1 from ${heartbeatRunEventLinks}
        where ${heartbeatRunEventLinks.runId} = ${runId} and ${heartbeatRunEventLinks.lane} = ${lane}
          and ${heartbeatRunEventLinks.eventId} = ${String(beforeId)} and ${heartbeatRunEventLinks.previousId} is not null`;
  const records = await db.execute(sql`
    with recursive history_window(event_id, depth) as (
      ${anchor}
      union all
      select link.previous_id, history_window.depth + 1 from history_window
      join ${heartbeatRunEventLinks} link on link.run_id = ${runId} and link.lane = ${lane} and link.event_id = history_window.event_id
      where history_window.depth < ${count} and link.previous_id is not null
    ) select event_id from history_window order by depth asc`);
  return Array.from(records as unknown as Iterable<{ event_id: string }>).map(row => row.event_id);
}
export async function readRunEventLane(db: Db, runId: string, lane: string, limit = 200, beforeId?: string | number) {
  const ids = await readRunEventLaneIds(db, runId, lane, limit, beforeId);
  if (!ids.length) return [];
  const rows = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, runId), inArray(heartbeatRunEvents.id, ids)));
  const byId = new Map(rows.map(row => [String(row.id), row]));
  return ids.map(id => { const row = byId.get(id); if (!row) throw new Error("run_event_index_incomplete"); return row; });
}

const EVENT_PAGE_BYTES = 4 * 1024 * 1024;
const pageMetadata = {
  id: heartbeatRunEvents.id,
  eventEpoch: heartbeatRunEvents.eventEpoch,
  seq: heartbeatRunEvents.seq,
  // Measure uncompressed JSON before moving payloads into the server heap.
  bytes: sql<number>`coalesce(octet_length(${heartbeatRunEvents.payload}::text), 0)
    + coalesce(octet_length(${heartbeatRunEvents.message}), 0) + 2048`.mapWith(Number),
};
type PageMetadata = RunEventPosition & { id: string | number; bytes: number };
function budgetedRows(rows: PageMetadata[], limit: number): PageMetadata[] {
  let bytes = 0;
  const selected: PageMetadata[] = [];
  for (const row of rows) {
    if (selected.length >= limit || (selected.length && bytes + row.bytes > EVENT_PAGE_BYTES)) break;
    // One individually bounded protocol frame can exceed the page target.
    // Keep it intact so a page can always advance through retained legacy data.
    selected.push(row); bytes += row.bytes;
  }
  return selected;
}
async function hydratePage(db: Db, runId: string, selected: PageMetadata[]) {
  if (!selected.length) return [];
  const rows = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, runId), inArray(heartbeatRunEvents.id, selected.map(row => row.id))));
  const byId = new Map(rows.map(row => [String(row.id), row]));
  return selected.map(metadata => {
    const row = byId.get(String(metadata.id));
    if (!row) throw new Error("run_event_index_incomplete");
    return { ...row, cursor: runEventCursor(row) };
  });
}

/** Forward pages never compare ordinals belonging to different epochs. One
 * bounded page may cross several small test epochs, retaining arrival order. */
export async function readRunEventPage(db: Db, runId: string, after: number | string = 0, limit = 200) {
  const count = Math.max(1, Math.min(1000, Math.floor(limit)));
  if (after === "tail") {
    const ids = await readRunEventLaneIds(db, runId, "all", count + 1);
    if (!ids.length) return [];
    const metadata = await db.select(pageMetadata).from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, runId), inArray(heartbeatRunEvents.id, ids)));
    const byId = new Map(metadata.map(row => [String(row.id), row]));
    const newest = ids.map(id => { const row = byId.get(id); if (!row) throw new Error("run_event_index_incomplete"); return row; });
    const selected = budgetedRows(newest, count);
    const rows = await hydratePage(db, runId, selected.reverse());
    return rows.map((row, index) => ({ ...row, ...(index === 0 && newest.length > selected.length ? { historyBefore: true } : {}) }));
  }
  let position = parseRunEventCursor(after);
  const result: PageMetadata[] = [];
  // Each committed epoch contains at least one event. This is page-sized work,
  // never an unbounded walk from the first namespace to the current head.
  for (let boundaries = 0; boundaries <= count + 1; boundaries++) {
    const rows = await db.select(pageMetadata).from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, runId), eq(heartbeatRunEvents.eventEpoch, position.eventEpoch), gt(heartbeatRunEvents.seq, position.seq)))
      .orderBy(asc(heartbeatRunEvents.seq)).limit(count + 1 - result.length);
    result.push(...rows);
    if (result.length === count + 1) break;
    const last = rows.at(-1);
    if (last) position = last;
    const [closed] = await db.select().from(heartbeatRunEventEpochs).where(and(eq(heartbeatRunEventEpochs.runId, runId), eq(heartbeatRunEventEpochs.epoch, position.eventEpoch))).limit(1);
    if (!closed) break;
    if (position.seq > closed.finalSeq) throw new Error("invalid_run_event_cursor");
    if (position.seq < closed.finalSeq) throw new Error("run_event_epoch_incomplete");
    position = { eventEpoch: closed.nextEpoch, seq: 0 };
  }
  const selected = budgetedRows(result, count);
  const rows = await hydratePage(db, runId, selected);
  return rows.map((row, index) => ({ ...row, ...(index === rows.length - 1 && result.length > selected.length ? { historyAfter: true } : {}) }));
}
