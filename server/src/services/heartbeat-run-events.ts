import { allocateRunEventPosition, runEventExhaustionLane } from "./run-event-history.js";
import { and, asc, desc, eq, gt, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRunEvents, heartbeatRuns, nativeSourceCursors, nativeSourceEpochs, nativeOutputBodyChunks, heartbeatRunEventHeads } from "@paperclipai/db";
import { isEventEpochTransition, type EventEpochTransition } from "../vendor/paperclip-runner/index.js";
import { nativeSha256 } from "./native-runtime/canonical.js";
import { recordNativeProcessEvidence } from "./native-process-evidence.js";
import { prepareRunOutputChunkPayload } from "./run-output-body.js";

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
    sourceEpoch?: string;
    sourceEpochTransition?: EventEpochTransition;
    protocolSchemaVersion: number;
    canonicalPayload: Record<string, unknown>;
    /** Retained hidden-coordinator rows use tagged digests. Preserve exact replay bytes. */
    hashEncoding?: "sha256";
  };
}

export interface AppendHeartbeatRunEventResult {
  row: typeof heartbeatRunEvents.$inferSelect;
  disposition: "committed" | "duplicate";
  highestContiguousSourceSeq: number;
  highestContiguousSourceEpoch?: string;
}

export class HeartbeatRunEventConflictError extends Error {
  readonly code = "native_event_replay_conflict" as const;
  constructor() {
    super("native_event_replay_conflict");
    this.name = "HeartbeatRunEventConflictError";
  }
}

export async function appendHeartbeatRunEvent(
  db: Db,
  input: AppendHeartbeatRunEventInput,
): Promise<AppendHeartbeatRunEventResult> {
  if (input.eventType === "output.body.chunk") {
    const [run] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId),
    ));
    if (!run) throw new Error("heartbeat_run_event_binding_mismatch");
  }
  const payload = await prepareRunOutputChunkPayload(input);
  return db.transaction((tx) => appendHeartbeatRunEventInTransaction(tx, input, payload));
}

export async function appendHeartbeatRunEventInTransaction(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  input: AppendHeartbeatRunEventInput,
  preparedPayload?: Record<string, unknown> | null,
): Promise<AppendHeartbeatRunEventResult> {
    const run = await tx
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, input.runId))
      .for("update")
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!run || run.companyId !== input.companyId || run.agentId !== input.agentId) {
      throw new Error("heartbeat_run_event_binding_mismatch");
    }
    const storedPayload = preparedPayload === undefined ? await prepareRunOutputChunkPayload(input) : preparedPayload;

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
          sql`${heartbeatRunEvents.id} = (select ${heartbeatRunEventHeads.eventId} from ${heartbeatRunEventHeads}
            where ${heartbeatRunEventHeads.runId} = ${input.runId} and ${heartbeatRunEventHeads.lane} = ${runEventExhaustionLane(input.retryExhaustion)})`,
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
      ? `${input.nativeSource.hashEncoding === "sha256" ? "sha256:" : ""}${nativeSha256(input.nativeSource.canonicalPayload)}`
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
              eq(heartbeatRunEvents.sourceEpoch, input.nativeSource.sourceEpoch ?? ""),
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
          ...await contiguousCursor(
            tx as unknown as Db,
            input.runId,
            input.nativeSource.sourceInstanceId,
            input.companyId,
          ),
        };
      }
    }

    if (input.nativeSource) await acceptSourceEpoch(tx as unknown as Db, input);
    const position = await allocateRunEventPosition(
      tx as unknown as Db,
      input.runId,
    );
    const [row] = await tx.insert(heartbeatRunEvents).values({
      companyId: input.companyId,
      runId: input.runId,
      agentId: input.agentId,
      ...position,
      eventType: input.eventType,
      stream: input.stream ?? null,
      level: input.level ?? null,
      color: input.color ?? null,
      message: input.message ?? null,
      payload: storedPayload,
      sourceInstanceId: input.nativeSource?.sourceInstanceId ?? null,
      sourceEventId: input.nativeSource?.sourceEventId ?? null,
      sourceSeq: input.nativeSource?.sourceSeq ?? null,
      sourceEpoch: input.nativeSource?.sourceEpoch ?? "",
      sourcePayloadSha256: sourceHash,
      protocolSchemaVersion: input.nativeSource?.protocolSchemaVersion ?? null,
    }).returning();
    if (!row) throw new Error("heartbeat_run_event_not_persisted");
    await recordNativeProcessEvidence(tx, row);
    if (input.eventType === "output.body.chunk") {
      const event = input.nativeSource?.canonicalPayload;
      const chunk = event?.payload as { body?: { bodyId?: unknown } } | undefined;
      const bodyId = chunk?.body?.bodyId;
      if (typeof bodyId !== "string" || !/^[a-f0-9]{64}$/.test(bodyId) || !input.nativeSource) {
        throw new Error("native_output_body_binding_invalid");
      }
      await indexRunOutputChunk(tx as unknown as Db, { companyId: input.companyId, runId: input.runId,
        bodyId, sourceSeq: input.nativeSource.sourceSeq, eventId: row.id, payload: event!.payload });
    }
    return {
      row,
      disposition: "committed" as const,
      ...(input.nativeSource
        ? await contiguousCursor(
            tx as unknown as Db,
            input.runId,
            input.nativeSource.sourceInstanceId,
            input.companyId,
          )
        : { highestContiguousSourceSeq: 0 }),
    };
}

async function contiguousCursor(db: Db, runId: string, sourceInstanceId: string, companyId: string): Promise<{highestContiguousSourceSeq: number; highestContiguousSourceEpoch?: string}> {
  // The caller holds the run row lock, serializing insertion and cursor updates.
  const scope = and(eq(nativeSourceCursors.runId, runId), eq(nativeSourceCursors.sourceInstanceId, sourceInstanceId), eq(nativeSourceCursors.companyId, companyId));
  let stored = await db.select().from(nativeSourceCursors).where(scope).limit(1).then((rows) => rows[0]);
  if (!stored) {
    // Existing runs pay one migration scan, never a scan on each append.
    // New runs normally have only their first event here.
    const result = await db.execute(sql`select coalesce(min(case when source_seq <> ordinal then ordinal - 1 end), max(source_seq), 0)::bigint as cursor from (select source_seq, row_number() over(order by source_seq) as ordinal from heartbeat_run_events where run_id = ${runId} and source_instance_id = ${sourceInstanceId} and source_epoch = '') numbered`);
    const cursor = Number(result[0]?.cursor ?? 0);
    [stored] = await db.insert(nativeSourceCursors).values({ companyId, runId, sourceInstanceId, cursor }).returning();
  }
  let cursor = stored!.cursor;
  let gap = false;
  do {
    const rows = await db.select({ sourceSeq: heartbeatRunEvents.sourceSeq }).from(heartbeatRunEvents)
      .where(and(eq(heartbeatRunEvents.runId, runId), eq(heartbeatRunEvents.sourceInstanceId, sourceInstanceId), eq(heartbeatRunEvents.sourceEpoch, stored!.sourceEpoch), gt(heartbeatRunEvents.sourceSeq, cursor)))
      .orderBy(asc(heartbeatRunEvents.sourceSeq)).limit(128);
    if (!rows.length) break;
    for (const row of rows) {
      if (row.sourceSeq === cursor + 1) cursor++;
      else { gap = true; break; }
    }
    if (rows.length < 128) break;
  } while (!gap);
  if (cursor !== stored!.cursor) await db.update(nativeSourceCursors).set({ cursor }).where(scope);
  return { highestContiguousSourceSeq: cursor, ...(stored!.sourceEpoch ? { highestContiguousSourceEpoch: stored!.sourceEpoch } : {}) };
}

/** Called under the run lock, before inserting a new event. Duplicates take the
 * exact immutable event receipt path and cannot move this head backwards. */
async function acceptSourceEpoch(db: Db, input: AppendHeartbeatRunEventInput): Promise<void> {
  const source = input.nativeSource!;
  if (!Number.isSafeInteger(source.sourceSeq) || source.sourceSeq < 1) throw new HeartbeatRunEventConflictError();
  const scope = and(eq(nativeSourceCursors.runId, input.runId), eq(nativeSourceCursors.sourceInstanceId, source.sourceInstanceId), eq(nativeSourceCursors.companyId, input.companyId));
  await contiguousCursor(db, input.runId, source.sourceInstanceId, input.companyId);
  const [head] = await db.select().from(nativeSourceCursors).where(scope).limit(1);
  const sourceEpoch = source.sourceEpoch ?? "";
  if (head!.sourceEpoch === sourceEpoch) {
    if (source.sourceEpochTransition) throw new HeartbeatRunEventConflictError();
    return;
  }
  const t = source.sourceEpochTransition;
  if (!isEventEpochTransition(t) || t.runId !== input.runId || t.fromEpoch !== (head!.sourceEpoch || null)
    || t.nextEpoch !== sourceEpoch || source.sourceSeq !== 1 || t.finalOrdinal !== head!.cursor) throw new HeartbeatRunEventConflictError();
  const [tail] = await db.select({ seq: heartbeatRunEvents.sourceSeq }).from(heartbeatRunEvents)
    .where(and(eq(heartbeatRunEvents.runId, input.runId), eq(heartbeatRunEvents.sourceInstanceId, source.sourceInstanceId), eq(heartbeatRunEvents.sourceEpoch, head!.sourceEpoch)))
    .orderBy(desc(heartbeatRunEvents.sourceSeq)).limit(1);
  if (tail?.seq !== t.finalOrdinal) throw new HeartbeatRunEventConflictError();
  const [reused] = await db.select({ id: nativeSourceEpochs.transitionId }).from(nativeSourceEpochs).where(and(
    eq(nativeSourceEpochs.runId, input.runId), eq(nativeSourceEpochs.sourceInstanceId, source.sourceInstanceId),
    or(eq(nativeSourceEpochs.fromEpoch, sourceEpoch), eq(nativeSourceEpochs.nextEpoch, sourceEpoch), eq(nativeSourceEpochs.transitionId, t.transitionId)),
  )).limit(1);
  if (reused) throw new HeartbeatRunEventConflictError();
  await db.insert(nativeSourceEpochs).values({ companyId: input.companyId, runId: input.runId, sourceInstanceId: source.sourceInstanceId,
    fromEpoch: head!.sourceEpoch, nextEpoch: sourceEpoch, transitionId: t.transitionId, finalOrdinal: t.finalOrdinal, transition: { ...t } });
  await db.update(nativeSourceCursors).set({ sourceEpoch, cursor: 0 }).where(scope);
}

/** Body-local offsets are bounded by one provider frame and do not reset when
 * the source event namespace rotates. Repeated identical bodies share chunks. */
export async function indexRunOutputChunk(db: Db, input: { companyId: string; runId: string; bodyId: string; sourceSeq: number; eventId: number | string; payload: unknown }): Promise<void> {
  const chunk = input.payload as { offset?: unknown; sha256?: unknown };
  if (!chunk || typeof chunk.offset !== "string" || !/^(0|[1-9][0-9]{0,6})$/.test(chunk.offset)
    || Number(chunk.offset) >= 4194304 || typeof chunk.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(chunk.sha256)) throw new Error("native_output_body_binding_invalid");
  const { payload: _, ...row } = input;
  const chunkOffset = Number(chunk.offset), chunkSha256 = chunk.sha256;
  const [inserted] = await db.insert(nativeOutputBodyChunks).values({ ...row, chunkOffset, chunkSha256 }).onConflictDoNothing().returning();
  if (!inserted) {
    const [existing] = await db.select().from(nativeOutputBodyChunks).where(and(eq(nativeOutputBodyChunks.companyId, input.companyId), eq(nativeOutputBodyChunks.runId, input.runId),
      eq(nativeOutputBodyChunks.bodyId, input.bodyId), eq(nativeOutputBodyChunks.chunkOffset, chunkOffset))).limit(1);
    if (!existing || existing.chunkSha256 !== chunkSha256) throw new HeartbeatRunEventConflictError();
  }
}
