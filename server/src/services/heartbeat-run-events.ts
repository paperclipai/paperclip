import { notifyLiveRunRecovery } from "./live-run-recovery-notifications.js";
import { notifyAttentionRetentionWork } from "./retention-work-notifications.js";
import { readNativeEventEvidenceOutcome } from "./native-runtime/evidence-classifier.js";
import { notifyNativeStatusReassessment } from "./native-status-reassessment-notifications.js";
import { isNativeResponseEvidence, notifyNativeResponsePresentation } from "./native-response-presentation-notifications.js";
import { isSafeNativeChatProgressEventType } from "./safe-native-chat-progress.js";
import { notifyChatNativeProgress } from "./chat-native-progress-notifications.js";
import { boundRunIssueIdSql } from "./run-task-binding.js";
import { and, eq, getTableColumns, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";
import { nativeSha256 } from "./native-runtime/canonical.js";
import { nativeEventCursorProjectionCurrent, projectNativeEventSourceRange, readNativeEventSourceCursor,
  readRetainedNativeEventCursor, requestNativeEventCursorRebuild, type NativeEventCursorRun,
} from "./heartbeat/native-event-cursors.js";

export const RETRY_EXHAUSTION_MESSAGE_PREFIX = "Bounded retry exhausted";

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
 * Set projectionApplied only for a legacy event or after incorporating its
 * native source metadata in this same transaction. Otherwise leave the marker
 * stale so a subsequent native reader safely falls back and requests rebuild.
 */
export async function allocateHeartbeatRunEventSeq(
  db: Db,
  runId: string,
  projectionApplied = false,
): Promise<number> {
  const [updated] = await db
    .update(heartbeatRuns)
    .set({
      nextEventSeq: sql`${heartbeatRuns.nextEventSeq} + 1`,
      ...(projectionApplied ? { eventCursorProjectionSeq: sql`case
        when ${heartbeatRuns.eventCursorProjectionSeq} = ${heartbeatRuns.nextEventSeq} - 1
        then ${heartbeatRuns.nextEventSeq} else ${heartbeatRuns.eventCursorProjectionSeq} end` } : {}),
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
  const projectsRetention = input.eventType === "lifecycle" && Boolean(input.message?.startsWith(RETRY_EXHAUSTION_MESSAGE_PREFIX));
  // Terminal proof may arrive after controller retirement and a quiet Stop
  // check. Register the scoped wake before writing it, in the same transaction.
  const projectsRecovery = ["native.process_start_requested", "native.process_identity_recorded", "native.local_process_stopped"].includes(input.eventType)
    || Boolean(input.nativeSource && ["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"].includes(input.eventType));
  const projectsReassessment = readNativeEventEvidenceOutcome(input.payload?.prpEvent) !== null;
  const projectsProgress = isSafeNativeChatProgressEventType(input.eventType);
  const projectsResponse = isNativeResponseEvidence(input.eventType, input.payload?.prpEvent);
  if (!input.nativeSource && !input.retryExhaustion && !projectsProgress && !projectsResponse && !projectsReassessment && !projectsRecovery && !projectsRetention) {
    const allocated = db.$with("allocated_run_event", {}).as(sql`
      update ${heartbeatRuns}
      set next_event_seq = ${heartbeatRuns.nextEventSeq} + 1,
          event_cursor_projection_seq = case
            when ${heartbeatRuns.eventCursorProjectionSeq} = ${heartbeatRuns.nextEventSeq} - 1
            then ${heartbeatRuns.nextEventSeq} else ${heartbeatRuns.eventCursorProjectionSeq} end,
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
      .select({ companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
        ...(input.nativeSource ? { nextEventSeq: heartbeatRuns.nextEventSeq,
          eventCursorProjectionSeq: heartbeatRuns.eventCursorProjectionSeq,
          eventCursorRebuildPending: heartbeatRuns.eventCursorRebuildPending } : {}),
        // Only progress needs the task binding. Other native/recovery events
        // must not read a potentially large context snapshot to append a log.
        ...(projectsProgress || projectsResponse || projectsReassessment ? { runtimeMode: heartbeatRuns.runtimeMode } : {}),
        ...(projectsProgress ? { issueId: boundRunIssueIdSql() } : {}) })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, input.runId))
      .for("update")
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!run || run.companyId !== input.companyId || run.agentId !== input.agentId) {
      throw new Error("heartbeat_run_event_binding_mismatch");
    }

    const cursorRun = input.nativeSource ? { ...run, id: input.runId } as NativeEventCursorRun : null;
    const sourceScope = input.nativeSource ? { companyId: input.companyId, runId: input.runId,
      sourceInstanceId: input.nativeSource.sourceInstanceId } : null;
    const projectionCurrent = cursorRun !== null && nativeEventCursorProjectionCurrent(cursorRun);
    if (projectsRecovery) await notifyLiveRunRecovery(tx, input);

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
          sql`${heartbeatRunEvents.message} like ${`${RETRY_EXHAUSTION_MESSAGE_PREFIX}%`}`,
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
      const existingRows = await tx
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
        .limit(2);
      const existing = existingRows[0];
      if (existing) {
        if (existingRows.some(row => row.sourcePayloadSha256 !== sourceHash
          || row.sourceInstanceId !== input.nativeSource!.sourceInstanceId
          || row.sourceEventId !== input.nativeSource!.sourceEventId
          || row.sourceSeq !== input.nativeSource!.sourceSeq)) {
          throw new HeartbeatRunEventConflictError();
        }
        if (!projectionCurrent) await requestNativeEventCursorRebuild(tx as unknown as Db, cursorRun!);
        return {
          row: existing,
          disposition: "duplicate" as const,
          highestContiguousSourceSeq: await (projectionCurrent ? readNativeEventSourceCursor : readRetainedNativeEventCursor)(
            tx as unknown as Db, sourceScope!),
        };
      }
    }

    if (projectsReassessment && run.runtimeMode === "native") {
      await notifyNativeStatusReassessment(tx, { companyId: run.companyId, runId: input.runId });
    }
    if (projectsProgress && run.runtimeMode === "native" && run.issueId) {
      await notifyChatNativeProgress(tx, { companyId: run.companyId, issueId: run.issueId });
    }
    if (projectsResponse && run.runtimeMode === "native") {
      await notifyNativeResponsePresentation(tx, { companyId: run.companyId, runId: input.runId });
    }
    if (projectsRetention) await notifyAttentionRetentionWork(tx, { companyId: input.companyId, sourceKind: "failed_run" });
    let projectedSourceCursor = 0;
    if (input.nativeSource) {
      if (projectionCurrent) projectedSourceCursor = await projectNativeEventSourceRange(
        tx as unknown as Db, sourceScope!, input.nativeSource.sourceSeq);
      else await requestNativeEventCursorRebuild(tx as unknown as Db, cursorRun!);
    }
    const seq = await allocateHeartbeatRunEventSeq(
      tx as unknown as Db,
      input.runId,
      !input.nativeSource || projectionCurrent,
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
        ? projectionCurrent ? projectedSourceCursor : await readRetainedNativeEventCursor(tx as unknown as Db, sourceScope!)
        : 0,
    };
  });
}

/**
 * Ordinary display text keeps its individual replay identities, but shares one
 * run lock, sequence reservation and insert. Semantic/control events retain
 * their singleton append and notification boundaries.
 */
export async function appendHeartbeatRunEvents(
  db: Db,
  values: readonly AppendHeartbeatRunEventInput[],
): Promise<AppendHeartbeatRunEventResult[]> {
  if (values.length === 0) return [];
  if (values.length > 64) throw new Error("native_event_batch_invalid");
  // Clone and hash before taking the run lock. A caller cannot change the
  // payload behind the replay check while the transaction is waiting.
  const inputs = values.map(value => structuredClone(value));
  const binding = inputs[0]!;
  let bytes = 0;
  type Candidate = {
    input: AppendHeartbeatRunEventInput & { nativeSource: NonNullable<AppendHeartbeatRunEventInput["nativeSource"]> };
    hash: string;
    firstIndex: number;
    row?: typeof heartbeatRunEvents.$inferSelect;
    fresh?: boolean;
  };
  const byEventId = new Map<string, Candidate>();
  const bySourceSeq = new Map<string, Map<number, Candidate>>();
  const candidates: Candidate[] = [];
  const entries: Candidate[] = [];
  const matches = (candidate: Candidate, source: NonNullable<AppendHeartbeatRunEventInput["nativeSource"]>, hash: string) =>
    candidate.hash === hash && candidate.input.nativeSource.sourceEventId === source.sourceEventId
    && candidate.input.nativeSource.sourceInstanceId === source.sourceInstanceId
    && candidate.input.nativeSource.sourceSeq === source.sourceSeq;
  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index]!;
    const source = input.nativeSource;
    const event = source?.canonicalPayload;
    const payload = event?.payload as Record<string, unknown> | undefined;
    if (input.companyId !== binding.companyId || input.runId !== binding.runId || input.agentId !== binding.agentId
      || input.eventType !== "item.delta" || input.retryExhaustion !== undefined || source === undefined
      || !Number.isSafeInteger(source.sourceSeq) || source.sourceSeq < 1
      || event?.eventType !== "item.delta" || event.sourceKind !== "runner" || (event.priority !== 1 && event.priority !== 2)
      || event.sourceEventId !== source.sourceEventId || event.sourceInstanceId !== source.sourceInstanceId
      || event.sourceSeq !== source.sourceSeq || event.runId !== input.runId
      || (payload?.kind !== "agentMessage" && payload?.kind !== "reasoning") || typeof payload?.text !== "string") {
      throw new Error("native_event_batch_invalid");
    }
    bytes += Buffer.byteLength(JSON.stringify(event), "utf8");
    if (bytes > 64 * 1024) throw new Error("native_event_batch_invalid");
    const hash = nativeSha256(event);
    const eventCandidate = byEventId.get(source.sourceEventId);
    const sourceCandidates = bySourceSeq.get(source.sourceInstanceId) ?? new Map<number, Candidate>();
    const sequenceCandidate = sourceCandidates.get(source.sourceSeq);
    if (eventCandidate && !matches(eventCandidate, source, hash)
      || sequenceCandidate && !matches(sequenceCandidate, source, hash)) {
      throw new HeartbeatRunEventConflictError();
    }
    const candidate = eventCandidate ?? sequenceCandidate ?? {
      input: input as Candidate["input"], hash, firstIndex: index,
    };
    if (!eventCandidate && !sequenceCandidate) candidates.push(candidate);
    byEventId.set(source.sourceEventId, candidate);
    sourceCandidates.set(source.sourceSeq, candidate);
    bySourceSeq.set(source.sourceInstanceId, sourceCandidates);
    entries.push(candidate);
  }

  return db.transaction(async tx => {
    const [run] = await tx.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId, nextEventSeq: heartbeatRuns.nextEventSeq,
      eventCursorProjectionSeq: heartbeatRuns.eventCursorProjectionSeq,
      eventCursorRebuildPending: heartbeatRuns.eventCursorRebuildPending,
    }).from(heartbeatRuns).where(eq(heartbeatRuns.id, binding.runId)).for("update").limit(1);
    if (!run || run.companyId !== binding.companyId || run.agentId !== binding.agentId) {
      throw new Error("heartbeat_run_event_binding_mismatch");
    }
    const existing = await tx.select().from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.runId, run.id),
      or(inArray(heartbeatRunEvents.sourceEventId, [...byEventId.keys()]),
        ...[...bySourceSeq].map(([sourceInstanceId, sequences]) => and(
          eq(heartbeatRunEvents.sourceInstanceId, sourceInstanceId),
          inArray(heartbeatRunEvents.sourceSeq, [...sequences.keys()]),
        ))),
    ));
    for (const row of existing) {
      const identified = new Set([
        row.sourceEventId === null ? undefined : byEventId.get(row.sourceEventId),
        row.sourceInstanceId === null || row.sourceSeq === null ? undefined : bySourceSeq.get(row.sourceInstanceId)?.get(row.sourceSeq),
      ]);
      for (const candidate of identified) {
        if (candidate === undefined) continue;
        const source = candidate.input.nativeSource;
        if (row.companyId !== binding.companyId || row.agentId !== binding.agentId
          || row.sourcePayloadSha256 !== candidate.hash || row.sourceEventId !== source.sourceEventId
          || row.sourceInstanceId !== source.sourceInstanceId || row.sourceSeq !== source.sourceSeq
          || candidate.row !== undefined && candidate.row.id !== row.id) {
          throw new HeartbeatRunEventConflictError();
        }
        candidate.row = row;
      }
    }
    const projectionCurrent = nativeEventCursorProjectionCurrent(run);
    if (!projectionCurrent) await requestNativeEventCursorRebuild(tx as unknown as Db, run);
    const added = candidates.filter(candidate => candidate.row === undefined);
    const cursors = new Map<string, number>();
    if (added.length > 0) {
      await tx.update(heartbeatRuns).set({
        nextEventSeq: run.nextEventSeq + added.length,
        ...(projectionCurrent ? { eventCursorProjectionSeq: run.nextEventSeq + added.length - 1 } : {}),
        updatedAt: new Date(),
      }).where(eq(heartbeatRuns.id, run.id));
      const inserted = await tx.insert(heartbeatRunEvents).values(added.map((candidate, index) => {
        const { input } = candidate;
        return { companyId: input.companyId, runId: input.runId, agentId: input.agentId,
          seq: run.nextEventSeq + index, eventType: input.eventType,
          stream: input.stream ?? null, level: input.level ?? null, color: input.color ?? null,
          message: input.message ?? null, payload: input.payload ?? null,
          sourceInstanceId: input.nativeSource.sourceInstanceId, sourceEventId: input.nativeSource.sourceEventId,
          sourceSeq: input.nativeSource.sourceSeq, sourcePayloadSha256: candidate.hash,
          protocolSchemaVersion: input.nativeSource.protocolSchemaVersion,
        };
      })).returning();
      for (const row of inserted) {
        const candidate = byEventId.get(row.sourceEventId!)!;
        candidate.row = row;
        candidate.fresh = true;
      }
      if (inserted.length !== added.length) throw new Error("heartbeat_run_event_not_persisted");

      if (projectionCurrent) {
        const ranges = new Map<string, number[]>();
        for (const candidate of added) {
          const source = candidate.input.nativeSource;
          const values = ranges.get(source.sourceInstanceId) ?? [];
          values.push(source.sourceSeq);
          ranges.set(source.sourceInstanceId, values);
        }
        for (const [sourceInstanceId, values] of ranges) {
          values.sort((a, b) => a - b);
          const scope = { companyId: run.companyId, runId: run.id, sourceInstanceId };
          let start = values[0]!, end = start;
          for (const value of values.slice(1)) {
            if (value === end + 1) { end = value; continue; }
            await projectNativeEventSourceRange(tx as unknown as Db, scope, start, end);
            start = end = value;
          }
          cursors.set(sourceInstanceId, await projectNativeEventSourceRange(tx as unknown as Db, scope, start, end));
        }
      }
    }
    for (const sourceInstanceId of bySourceSeq.keys()) if (!cursors.has(sourceInstanceId)) {
      cursors.set(sourceInstanceId, await (projectionCurrent ? readNativeEventSourceCursor : readRetainedNativeEventCursor)(
        tx as unknown as Db, { companyId: run.companyId, runId: run.id, sourceInstanceId }));
    }
    return entries.map((candidate, index) => ({ row: candidate.row!,
      disposition: candidate.fresh && candidate.firstIndex === index ? "committed" as const : "duplicate" as const,
      highestContiguousSourceSeq: cursors.get(candidate.input.nativeSource.sourceInstanceId)!,
    }));
  });
}
