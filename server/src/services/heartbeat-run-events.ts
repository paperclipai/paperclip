import { notifyLiveRunRecovery } from "./live-run-recovery-notifications.js";
import { notifyAttentionRetentionWork } from "./retention-work-notifications.js";
import { readNativeEventEvidenceOutcome } from "./native-runtime/evidence-classifier.js";
import { notifyNativeStatusReassessment } from "./native-status-reassessment-notifications.js";
import { isNativeResponseEvidence, notifyNativeResponsePresentation } from "./native-response-presentation-notifications.js";
import { isSafeNativeChatProgressEventType } from "./safe-native-chat-progress.js";
import { notifyChatNativeProgress } from "./chat-native-progress-notifications.js";
import { boundRunIssueIdSql } from "./run-task-binding.js";
import { and, eq, getTableColumns, or, sql } from "drizzle-orm";
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
