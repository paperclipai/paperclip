import { and, asc, eq, sql } from "drizzle-orm";
import { heartbeatRunEvents, heartbeatRuns, issueRecoveryActions, type Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";

type Source = Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "agentId" | "error">;

export async function readFailedPreparationSettlement(db: Db, source: Source, allowRunStarted = false): Promise<{
  unsupportedHarnessWarning: { message: string | null; revision: string } | null;
} | null> {
  if (typeof source.error !== "string" || !source.error.length) return null;
  const events = await db.select().from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, source.companyId), eq(heartbeatRunEvents.runId, source.id),
  )).orderBy(asc(heartbeatRunEvents.seq)).limit(allowRunStarted ? 7 : 6);
  const hostEvent = (event: typeof heartbeatRunEvents.$inferSelect) => event.agentId === source.agentId
    && event.stream === "system" && event.sourceInstanceId === null && event.sourceEventId === null
    && event.sourceSeq === null && event.sourcePayloadSha256 === null && event.protocolSchemaVersion === null;
  let offset = 0;
  const promotion = events[0];
  if (promotion?.message === "Scheduled retry became due and was promoted to the queued run pool") {
    if (!hostEvent(promotion) || promotion.seq !== 1 || promotion.eventType !== "lifecycle"
      || promotion.level !== "info" || !await matchesScheduledRetryPromotion(db, source, promotion)) return null;
    offset++;
  }
  let unsupportedHarnessWarning: { message: string | null; revision: string } | null = null;
  const warning = events[offset];
  if (warning?.eventType === "agent_observability.unavailable") {
    if (!hostEvent(warning) || warning.seq !== 1 + offset || warning.level !== "warn"
      || warning.payload?.reason !== "unsupported_harness" || typeof warning.payload.revision !== "string" || !isUuidLike(warning.payload.revision)
      || Object.keys(warning.payload).some(key => !["reason", "revision"].includes(key))) return null;
    unsupportedHarnessWarning = { message: warning.message, revision: warning.payload.revision };
    offset++;
  }
  const started = events[offset];
  if (allowRunStarted && started?.eventType === "lifecycle" && started.message === "run started") {
    if (!hostEvent(started) || started.seq !== 1 + offset || started.level !== "info" || started.payload !== null) return null;
    offset++;
  }
  const [error, measured, settledHold] = events.slice(offset);
  if (settledHold && !(hostEvent(settledHold) && await isRecoveryHoldSettlement(db, source, settledHold, 3 + offset))) return null;
  if (events.length !== (settledHold ? 3 : 2) + offset || !error || !measured || !hostEvent(error) || !hostEvent(measured)
    || error.seq !== 1 + offset || error.eventType !== "error" || error.level !== "error"
    || error.message !== source.error || error.payload !== null
    || measured.seq !== 2 + offset || measured.eventType !== "lifecycle" || measured.level !== "info" || measured.message !== "task.run.measured"
    || measured.payload?.phase !== "task.run.measured" || measured.payload.outcome !== "failed"
    || measured.payload.durableSettlement !== true
    || Object.keys(measured.payload).some(key => !["phase", "outcome", "durationMs", "durableSettlement"].includes(key))
    || typeof measured.payload.durationMs !== "number"
    || !Number.isFinite(measured.payload.durationMs) || measured.payload.durationMs < 0) return null;
  return { unsupportedHarnessWarning };
}

async function matchesScheduledRetryPromotion(db: Db, source: Source, event: typeof heartbeatRunEvents.$inferSelect) {
  const [run] = await db.select({ retryOfRunId: heartbeatRuns.retryOfRunId,
    scheduledRetryAt: heartbeatRuns.scheduledRetryAt, scheduledRetryAttempt: heartbeatRuns.scheduledRetryAttempt,
    scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
    retryContext: sql<Record<string, unknown>>`jsonb_build_object(
      'retryOfRunId', ${heartbeatRuns.contextSnapshot}->'retryOfRunId',
      'retryReason', ${heartbeatRuns.contextSnapshot}->'retryReason',
      'scheduledRetryAt', ${heartbeatRuns.contextSnapshot}->'scheduledRetryAt',
      'scheduledRetryAttempt', ${heartbeatRuns.contextSnapshot}->'scheduledRetryAttempt')`,
  }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, source.companyId),
    eq(heartbeatRuns.agentId, source.agentId), eq(heartbeatRuns.id, source.id)));
  const due = run?.scheduledRetryAt?.toISOString();
  return Boolean(run && run.retryOfRunId && isUuidLike(run.retryOfRunId) && due
    && Number.isSafeInteger(run.scheduledRetryAttempt) && run.scheduledRetryAttempt! > 0
    && typeof run.scheduledRetryReason === "string" && run.scheduledRetryReason.length > 0
    && run.retryContext.retryOfRunId === run.retryOfRunId
    && run.retryContext.retryReason === run.scheduledRetryReason
    && run.retryContext.scheduledRetryAt === due
    && run.retryContext.scheduledRetryAttempt === run.scheduledRetryAttempt
    && event.createdAt >= run.scheduledRetryAt!
    && event.payload?.scheduledRetryAt === due
    && event.payload.scheduledRetryAttempt === run.scheduledRetryAttempt
    && event.payload.scheduledRetryReason === run.scheduledRetryReason
    && Object.keys(event.payload).every(key => ["scheduledRetryAt", "scheduledRetryAttempt", "scheduledRetryReason"].includes(key)));
}

async function isRecoveryHoldSettlement(db: Db, source: Source, event: typeof heartbeatRunEvents.$inferSelect, seq: number) {
  const payload = event.payload;
  if (event.seq !== seq || event.eventType !== "lifecycle" || event.level !== "warn" || !payload
    || Object.keys(payload).some(key => !["recoveryActionId", "cause", "automaticRecovery", "replay"].includes(key))
    || payload.cause !== "legacy_execution_requires_reconciliation" || payload.automaticRecovery !== "preserve_without_replay_v1"
    || payload.replay !== "blocked" || typeof payload.recoveryActionId !== "string" || !isUuidLike(payload.recoveryActionId)) return false;
  const [hold] = await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, source.companyId), eq(issueRecoveryActions.id, payload.recoveryActionId),
    eq(issueRecoveryActions.cause, "legacy_execution_requires_reconciliation"), eq(issueRecoveryActions.status, "resolved"),
    sql`${issueRecoveryActions.evidence}->>'runId' = ${source.id}`,
    sql`${issueRecoveryActions.evidence}#>>'{automaticRecovery,replay}' = 'blocked'`,
  )).limit(1);
  return Boolean(hold);
}
