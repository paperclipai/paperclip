import { and, asc, eq, gt, lt, sql } from "drizzle-orm";
import { heartbeatRunEventCursors, heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";

export type NativeEventCursorScope = { companyId: string; runId: string };
export type NativeEventCursorSource = NativeEventCursorScope & { sourceInstanceId: string };
export type NativeEventCursorRun = Pick<typeof heartbeatRuns.$inferSelect,
  "companyId" | "nextEventSeq" | "eventCursorProjectionSeq" | "eventCursorRebuildPending"> & { id: string };

export function nativeEventCursorProjectionCurrent(run: NativeEventCursorRun): boolean {
  return run.eventCursorProjectionSeq === run.nextEventSeq - 1;
}

/** Caller holds the run lock; source state never grants execution authority. */
export async function requestNativeEventCursorRebuild(db: Db, run: NativeEventCursorRun): Promise<void> {
  if (run.eventCursorRebuildPending) return;
  await notifyDeliveryWork(db, DELIVERY_QUEUES.nativeEventCursorRebuild,
    JSON.stringify({ companyId: run.companyId, runId: run.id }));
  await db.update(heartbeatRuns).set({ eventCursorRebuildPending: true })
    .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId)));
}

export async function readNativeEventSourceCursor(db: Db, scope: NativeEventCursorSource): Promise<number> {
  const [row] = await db.select({ cursor: heartbeatRunEventCursors.contiguousSourceSeq })
    .from(heartbeatRunEventCursors).where(and(
      eq(heartbeatRunEventCursors.companyId, scope.companyId),
      eq(heartbeatRunEventCursors.runId, scope.runId),
      eq(heartbeatRunEventCursors.sourceInstanceId, scope.sourceInstanceId),
    )).limit(1);
  return row?.cursor ?? 0;
}

/** Incorporate one bounded received interval under the run lock. The ordinary
 * in-order path is one UPSERT regardless of the retained transcript length. */
export async function projectNativeEventSourceRange(
  db: Db, scope: NativeEventCursorSource, startSeq: number, endSeq = startSeq,
): Promise<number> {
  if (startSeq < 1 || endSeq < startSeq) return readNativeEventSourceCursor(db, scope);
  const rows = await db.execute(sql`
    with projected as (insert into heartbeat_run_event_cursors
      (company_id, run_id, source_instance_id, contiguous_source_seq, pending_range_count)
    values (${scope.companyId}, ${scope.runId}, ${scope.sourceInstanceId},
      case when ${startSeq}::bigint = 1 then ${endSeq}::bigint else 0 end, 0)
    on conflict (company_id, run_id, source_instance_id) do update
    set contiguous_source_seq = case
      when ${startSeq} <= heartbeat_run_event_cursors.contiguous_source_seq + 1
      then greatest(heartbeat_run_event_cursors.contiguous_source_seq, ${endSeq})
      else heartbeat_run_event_cursors.contiguous_source_seq end
    returning contiguous_source_seq as cursor, pending_range_count as pending),
    extended as (
      update heartbeat_run_event_source_ranges received
      set start_seq = least(received.start_seq, ${startSeq}),
          end_seq = greatest(received.end_seq, ${endSeq})
      from projected
      where projected.pending = 1 and projected.cursor < ${startSeq}::bigint - 1
        and received.company_id = ${scope.companyId} and received.run_id = ${scope.runId}
        and received.source_instance_id = ${scope.sourceInstanceId}
        and received.start_seq <= ${endSeq + 1} and received.end_seq >= ${startSeq - 1}
      returning received.start_seq
    )
    select projected.*, exists (select 1 from extended) as extended from projected
  `);
  let cursor = Number(rows[0].cursor), pending = Number(rows[0].pending);
  if (cursor >= endSeq && pending === 0 || rows[0].extended === true) return cursor;

  if (cursor >= startSeq - 1) {
    // A newly closed hole may join a very large received suffix. Delete its
    // range metadata, never fetch the underlying historical event rows.
    const joined = await db.execute(sql`
      delete from heartbeat_run_event_source_ranges
      where company_id = ${scope.companyId} and run_id = ${scope.runId}
        and source_instance_id = ${scope.sourceInstanceId} and start_seq <= ${cursor + 1}
      returning end_seq
    `);
    if (joined.length === 0) return cursor;
    cursor = Math.max(cursor, ...joined.map(row => Number(row.end_seq)));
    pending -= joined.length;
  } else {
    // Only the predecessor and starts within this bounded input interval can
    // overlap or touch it. The primary key supports both indexed reads.
    const adjacent = await db.execute(sql`
      select start_seq, end_seq from (
        (select start_seq, end_seq from heartbeat_run_event_source_ranges
          where company_id = ${scope.companyId} and run_id = ${scope.runId}
            and source_instance_id = ${scope.sourceInstanceId} and start_seq <= ${startSeq}
          order by start_seq desc limit 1)
        union all
        (select start_seq, end_seq from heartbeat_run_event_source_ranges
          where company_id = ${scope.companyId} and run_id = ${scope.runId}
            and source_instance_id = ${scope.sourceInstanceId}
            and start_seq > ${startSeq} and start_seq <= ${endSeq + 1})
      ) neighbors where end_seq >= ${startSeq - 1}
    `);
    const first = Math.min(startSeq, ...adjacent.map(row => Number(row.start_seq)));
    const last = Math.max(endSeq, ...adjacent.map(row => Number(row.end_seq)));
    if (adjacent.length > 0) await db.execute(sql`
      delete from heartbeat_run_event_source_ranges
      where company_id = ${scope.companyId} and run_id = ${scope.runId}
        and source_instance_id = ${scope.sourceInstanceId}
        and start_seq >= ${first} and start_seq <= ${endSeq + 1}
    `);
    await db.execute(sql`
      insert into heartbeat_run_event_source_ranges
        (company_id, run_id, source_instance_id, start_seq, end_seq)
      values (${scope.companyId}, ${scope.runId}, ${scope.sourceInstanceId}, ${first}, ${last})
    `);
    pending += 1 - adjacent.length;
  }
  await db.execute(sql`
    update heartbeat_run_event_cursors
    set contiguous_source_seq = ${cursor}, pending_range_count = ${pending}
    where company_id = ${scope.companyId} and run_id = ${scope.runId}
      and source_instance_id = ${scope.sourceInstanceId}
  `);
  return cursor;
}

/** Correct compatibility path while an older writer's suffix is unprojected. */
export async function readRetainedNativeEventCursor(db: Db, scope: NativeEventCursorSource): Promise<number> {
  const source = and(eq(heartbeatRunEvents.runId, scope.runId),
    eq(heartbeatRunEvents.sourceInstanceId, scope.sourceInstanceId), sql`${heartbeatRunEvents.sourceSeq} >= 1`);
  const [range] = await db.select({ count: sql<number>`count(*)`.mapWith(Number),
    max: sql<number | null>`max(${heartbeatRunEvents.sourceSeq})`.mapWith(Number) })
    .from(heartbeatRunEvents).where(source);
  if (!range?.count) return 0;
  if (range.max === range.count) return range.count;
  const [first] = await db.select({ sourceSeq: heartbeatRunEvents.sourceSeq }).from(heartbeatRunEvents)
    .where(and(source, eq(heartbeatRunEvents.sourceSeq, 1))).limit(1);
  if (!first) return 0;
  const [last] = await db.select({ sourceSeq: heartbeatRunEvents.sourceSeq }).from(heartbeatRunEvents)
    .where(and(source, sql`not exists (
      select 1 from heartbeat_run_events next_event
      where next_event.run_id = heartbeat_run_events.run_id
        and next_event.source_instance_id = heartbeat_run_events.source_instance_id
        and next_event.source_seq = heartbeat_run_events.source_seq + 1
    )`)).orderBy(asc(heartbeatRunEvents.sourceSeq)).limit(1);
  return last?.sourceSeq ?? 0;
}

/** One bounded page per transaction. The marker detects older writers and
 * permits the projection to be discarded/rebuilt without changing receipts. */
export async function rebuildNativeEventCursorPage(
  db: Db, scope: NativeEventCursorScope, signal?: AbortSignal,
): Promise<{ pending: boolean; contended: boolean; processed: number }> {
  signal?.throwIfAborted();
  return db.transaction(async tx => {
    const [run] = await tx.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId,
      nextEventSeq: heartbeatRuns.nextEventSeq, eventCursorProjectionSeq: heartbeatRuns.eventCursorProjectionSeq,
      eventCursorRebuildPending: heartbeatRuns.eventCursorRebuildPending })
      .from(heartbeatRuns).where(and(eq(heartbeatRuns.id, scope.runId),
        eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.eventCursorRebuildPending, true)))
      .for("update", { skipLocked: true }).limit(1);
    if (!run) {
      const [pending] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.id, scope.runId), eq(heartbeatRuns.companyId, scope.companyId),
          eq(heartbeatRuns.eventCursorRebuildPending, true))).limit(1);
      return { pending: Boolean(pending), contended: Boolean(pending), processed: 0 };
    }
    const rows = await tx.select({ seq: heartbeatRunEvents.seq,
      sourceInstanceId: heartbeatRunEvents.sourceInstanceId, sourceSeq: heartbeatRunEvents.sourceSeq })
      .from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, run.id),
        gt(heartbeatRunEvents.seq, run.eventCursorProjectionSeq), lt(heartbeatRunEvents.seq, run.nextEventSeq)))
      .orderBy(asc(heartbeatRunEvents.seq)).limit(512);
    const sources = new Map<string, number[]>();
    for (const row of rows) if (row.sourceInstanceId !== null && row.sourceSeq !== null && row.sourceSeq >= 1) {
      const values = sources.get(row.sourceInstanceId) ?? [];
      values.push(row.sourceSeq); sources.set(row.sourceInstanceId, values);
    }
    for (const [sourceInstanceId, values] of sources) {
      values.sort((a, b) => a - b);
      let start = values[0], end = start;
      for (const value of values.slice(1)) {
        if (value <= end + 1) { end = Math.max(end, value); continue; }
        await projectNativeEventSourceRange(tx as unknown as Db, { ...scope, sourceInstanceId }, start, end);
        start = end = value;
      }
      await projectNativeEventSourceRange(tx as unknown as Db, { ...scope, sourceInstanceId }, start, end);
    }
    const through = rows.length < 512 ? run.nextEventSeq - 1 : rows.at(-1)!.seq;
    const pending = through < run.nextEventSeq - 1;
    signal?.throwIfAborted();
    await tx.update(heartbeatRuns).set({ eventCursorProjectionSeq: through, eventCursorRebuildPending: pending })
      .where(eq(heartbeatRuns.id, run.id));
    return { pending, contended: false, processed: rows.length };
  });
}
