import { and, asc, eq, getTableColumns, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";
import { nativeSha256 } from "./native-runtime/canonical.js";

export interface AppendHeartbeatRunEventInput {
  companyId: string;
  runId: string;
  agentId: string;
  eventType: string;
  stream?: string | null;
  level?: string | null;
  color?: string | null;
  message?: string | null;
  payload?: Record<string, unknown> | null;
  /** Reuse an existing exhaustion receipt, including receipts from older builds. */
  retryExhaustion?: {
    retryReason: string;
    scheduledRetryAttempt: number;
    maxAttempts: number;
  };
  nativeSource?: {
    sourceInstanceId: string;
    sourceEventId: string;
    sourceSeq: number;
    protocolSchemaVersion: number;
    canonicalPayload: Record<string, unknown>;
  };
}

export interface AppendHeartbeatRunEventResult {
  row: typeof heartbeatRunEvents.$inferSelect;
  disposition: "committed" | "duplicate";
  highestContiguousSourceSeq: number;
}

export class HeartbeatRunEventConflictError extends Error {
  readonly code = "native_event_replay_conflict" as const;
  constructor() {
    super("native_event_replay_conflict");
    this.name = "HeartbeatRunEventConflictError";
  }
}

/**
 * Atomically reserve the next event sequence on the run row. Both native PRP
 * ingestion and legacy/direct-adapter writers use this allocator so the
 * database uniqueness invariant cannot turn a concurrent log/cancel/recovery
 * race into a failed run.
 */
export async function allocateHeartbeatRunEventSeq(
  db: Db,
  runId: string,
): Promise<number> {
  const [updated] = await db
    .update(heartbeatRuns)
    .set({
      nextEventSeq: sql`${heartbeatRuns.nextEventSeq} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(heartbeatRuns.id, runId))
    .returning({ nextEventSeq: heartbeatRuns.nextEventSeq });
  if (!updated) throw new Error("heartbeat_run_event_binding_mismatch");
  return Number(updated.nextEventSeq) - 1;
}

export async function appendHeartbeatRunEvent(
  db: Db,
  input: AppendHeartbeatRunEventInput,
): Promise<AppendHeartbeatRunEventResult> {
  if (!input.nativeSource && !input.retryExhaustion) {
    const allocated = db.$with("allocated_run_event", {}).as(sql`
      update ${heartbeatRuns}
      set next_event_seq = ${heartbeatRuns.nextEventSeq} + 1,
          updated_at = ${sql.param(new Date(), heartbeatRuns.updatedAt)}
      where ${heartbeatRuns.id} = ${input.runId}
        and ${heartbeatRuns.companyId} = ${input.companyId}
        and ${heartbeatRuns.agentId} = ${input.agentId}
      returning company_id, id as run_id, agent_id, next_event_seq - 1 as seq
    `);
    const appended = db.$with("appended_run_event", getTableColumns(heartbeatRunEvents)).as(sql`
      insert into ${heartbeatRunEvents}
        (company_id, run_id, agent_id, seq, event_type, stream, level, color, message, payload)
      select company_id, run_id, agent_id, seq,
        ${input.eventType}, ${input.stream ?? null}, ${input.level ?? null},
        ${input.color ?? null}, ${input.message ?? null},
        ${sql.param(input.payload ?? null, heartbeatRunEvents.payload)}
      from ${allocated}
      returning *
    `);
    const [row] = await db.with(allocated, appended).select().from(appended);
    if (!row) throw new Error("heartbeat_run_event_binding_mismatch");
    return { row, disposition: "committed", highestContiguousSourceSeq: 0 };
  }
  return db.transaction(async (tx) => {
    const run = await tx
      .select({ companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, input.runId))
      .for("update")
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!run || run.companyId !== input.companyId || run.agentId !== input.agentId) {
      throw new Error("heartbeat_run_event_binding_mismatch");
    }

    if (input.retryExhaustion && !input.nativeSource) {
      // The run lock also serializes concurrent recovery checks across server
      // instances. Reusing the receipt must not allocate a sequence or publish
      // another live event on each scheduler tick.
      const existing = await tx
        .select()
        .from(heartbeatRunEvents)
        .where(and(
          eq(heartbeatRunEvents.companyId, input.companyId),
          eq(heartbeatRunEvents.runId, input.runId),
          eq(heartbeatRunEvents.agentId, input.agentId),
          eq(heartbeatRunEvents.eventType, "lifecycle"),
          sql`${heartbeatRunEvents.message} like 'Bounded retry exhausted%'`,
          sql`${heartbeatRunEvents.payload} @> ${JSON.stringify(input.retryExhaustion)}::jsonb`,
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (existing) {
        return {
          row: existing,
          disposition: "duplicate" as const,
          highestContiguousSourceSeq: 0,
        };
      }
    }

    const sourceHash = input.nativeSource
      ? nativeSha256(input.nativeSource.canonicalPayload)
      : null;
    if (input.nativeSource) {
      const existing = await tx
        .select()
        .from(heartbeatRunEvents)
        .where(and(
          eq(heartbeatRunEvents.runId, input.runId),
          or(
            eq(heartbeatRunEvents.sourceEventId, input.nativeSource.sourceEventId),
            and(
              eq(heartbeatRunEvents.sourceInstanceId, input.nativeSource.sourceInstanceId),
              eq(heartbeatRunEvents.sourceSeq, input.nativeSource.sourceSeq),
            ),
          ),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (existing) {
        if (existing.sourcePayloadSha256 !== sourceHash) {
          throw new HeartbeatRunEventConflictError();
        }
        return {
          row: existing,
          disposition: "duplicate" as const,
          highestContiguousSourceSeq: await contiguousCursor(
            tx as unknown as Db,
            input.runId,
            input.nativeSource.sourceInstanceId,
          ),
        };
      }
    }

    const seq = await allocateHeartbeatRunEventSeq(
      tx as unknown as Db,
      input.runId,
    );
    const [row] = await tx.insert(heartbeatRunEvents).values({
      companyId: input.companyId,
      runId: input.runId,
      agentId: input.agentId,
      seq,
      eventType: input.eventType,
      stream: input.stream ?? null,
      level: input.level ?? null,
      color: input.color ?? null,
      message: input.message ?? null,
      payload: input.payload ?? null,
      sourceInstanceId: input.nativeSource?.sourceInstanceId ?? null,
      sourceEventId: input.nativeSource?.sourceEventId ?? null,
      sourceSeq: input.nativeSource?.sourceSeq ?? null,
      sourcePayloadSha256: sourceHash,
      protocolSchemaVersion: input.nativeSource?.protocolSchemaVersion ?? null,
    }).returning();
    if (!row) throw new Error("heartbeat_run_event_not_persisted");
    return {
      row,
      disposition: "committed" as const,
      highestContiguousSourceSeq: input.nativeSource
        ? await contiguousCursor(
            tx as unknown as Db,
            input.runId,
            input.nativeSource.sourceInstanceId,
          )
        : 0,
    };
  });
}

async function contiguousCursor(db: Db, runId: string, sourceInstanceId: string): Promise<number> {
  const scope = and(
    eq(heartbeatRunEvents.runId, runId),
    eq(heartbeatRunEvents.sourceInstanceId, sourceInstanceId),
    sql`${heartbeatRunEvents.sourceSeq} >= 1`,
  );
  const [range] = await db
    .select({
      count: sql<number>`count(*)`.mapWith(Number),
      max: sql<number | null>`max(${heartbeatRunEvents.sourceSeq})`.mapWith(Number),
    })
    .from(heartbeatRunEvents)
    .where(scope);
  if (!range || !range.count) return 0;
  if (range.max === range.count) return range.count;
  const [first] = await db
    .select({ sourceSeq: heartbeatRunEvents.sourceSeq })
    .from(heartbeatRunEvents)
    .where(and(scope, eq(heartbeatRunEvents.sourceSeq, 1)))
    .limit(1);
  if (!first) return 0;
  const [last] = await db
    .select({ sourceSeq: heartbeatRunEvents.sourceSeq })
    .from(heartbeatRunEvents)
    .where(and(scope, sql`not exists (
      select 1 from heartbeat_run_events next_event
      where next_event.run_id = heartbeat_run_events.run_id
        and next_event.source_instance_id = heartbeat_run_events.source_instance_id
        and next_event.source_seq = heartbeat_run_events.source_seq + 1
    )`))
    .orderBy(asc(heartbeatRunEvents.sourceSeq))
    .limit(1);
  return last?.sourceSeq ?? 0;
}
