import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issueRecoveryActions, type Db } from "@paperclipai/db";
import { queuedCommentIdsFromWakePayload } from "./issue-queued-comment-queue.js";
import { FRESH_CONTINUATION_SCHEMA, settleCoalescedFreshContinuationHolds } from "./fresh-continuation-fallback.js";

const LIVE_CONTINUATION_STATUSES = ["queued", "running"];

function retrySourceRunId(payload: unknown): string | null {
  const taskRetry = (payload as { taskRetry?: { sourceRunId?: unknown } } | null)?.taskRetry;
  return typeof taskRetry?.sourceRunId === "string" ? taskRetry.sourceRunId : null;
}

export async function foldWaitingRetriesIntoContinuation(tx: Db, input: {
  companyId: string; issueId: string; runId: string; sourceRunId: string | null;
}) {
  if (!input.sourceRunId) return;
  const [continuation] = await tx.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId)));
  if (!continuation || !LIVE_CONTINUATION_STATUSES.includes(continuation.status)) return;
  const waiting = await tx.select({ id: agentWakeupRequests.id, payload: agentWakeupRequests.payload }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.status, "deferred_issue_execution"),
    eq(agentWakeupRequests.reason, "task_retry"), eq(agentWakeupRequests.requestedByActorType, "user"),
    isNull(agentWakeupRequests.runId), sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`)).for("update");
  const retries = waiting.filter(wake => queuedCommentIdsFromWakePayload(wake.payload).length === 0
    && retrySourceRunId(wake.payload) === input.sourceRunId).map(wake => wake.id);
  if (!retries.length) return;
  const now = new Date();
  await tx.update(agentWakeupRequests).set({ status: "coalesced", runId: input.runId, finishedAt: now, updatedAt: now,
    payload: sql`coalesce(${agentWakeupRequests.payload}, '{}'::jsonb) || ${JSON.stringify({ coalescedIntoFreshContinuationRun: input.runId })}::jsonb` })
    .where(and(eq(agentWakeupRequests.companyId, input.companyId), inArray(agentWakeupRequests.id, retries),
      eq(agentWakeupRequests.status, "deferred_issue_execution")));
}

export async function foldWaitingRetriesIntoRecordedContinuation(tx: Db, input: {
  companyId: string; issueId: string; runId: string; recoveryActionId: string | null; sourceRunId: string | null;
}) {
  if (!input.recoveryActionId || !input.sourceRunId) return;
  const [record] = await tx.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.sourceIssueId, input.issueId),
    sql`${issueRecoveryActions.id}::text = ${input.recoveryActionId}`,
    sql`${issueRecoveryActions.evidence}#>>'{freshContinuation,schema}' = ${FRESH_CONTINUATION_SCHEMA}`,
    sql`${issueRecoveryActions.evidence}#>>'{freshContinuation,sourceRunId}' = ${input.sourceRunId}`)).limit(1);
  if (record) await foldWaitingRetriesIntoContinuation(tx, input);
}

export type UndeliveredContinuation = { recoveryActionId: string; sourceRunId: string; isolation: string | null };

/** Caller holds the task row lock. The task's recorded continuation that no run took yet: a run admitted now is that continuation. */
export async function undeliveredContinuation(tx: Db, input: { companyId: string; issueId: string }): Promise<UndeliveredContinuation | null> {
  const [record] = await tx.select({ id: issueRecoveryActions.id, evidence: issueRecoveryActions.evidence }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.sourceIssueId, input.issueId),
    eq(issueRecoveryActions.status, "resolved"),
    sql`${issueRecoveryActions.evidence}->>'continuationDelivery' = 'pending'`,
    sql`${issueRecoveryActions.evidence}#>>'{freshContinuation,schema}' = ${FRESH_CONTINUATION_SCHEMA}`))
    .orderBy(desc(sql`${issueRecoveryActions.evidence}#>>'{freshContinuation,recordedAt}'`)).limit(1).for("update");
  if (!record) return null;
  const fresh = record.evidence.freshContinuation as { recordedAt?: unknown; isolation?: unknown } | undefined;
  const sourceRunId = (record.evidence.executionReconciliation as { runId?: unknown } | undefined)?.runId;
  if (typeof sourceRunId !== "string" || typeof fresh?.recordedAt !== "string") return null;
  const [intervening] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), sql`${heartbeatRuns.id}::text <> ${sourceRunId}`,
    or(eq(heartbeatRuns.nativeIssueId, input.issueId), eq(heartbeatRuns.issueId, input.issueId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}::text`),
    sql`${heartbeatRuns.createdAt} >= ${fresh.recordedAt}::timestamptz`)).limit(1);
  if (intervening) return null;
  return { recoveryActionId: record.id, sourceRunId, isolation: typeof fresh.isolation === "string" ? fresh.isolation : null };
}

export function undeliveredContinuationContext(continuation: UndeliveredContinuation, context: Record<string, unknown>) {
  return { recoveryActionId: continuation.recoveryActionId, retryOfRunId: continuation.sourceRunId, forceFreshSession: true,
    ...(typeof context.previousRunId === "string" ? {} : { previousRunId: continuation.sourceRunId }),
    ...(continuation.isolation === "fresh_isolated_workspace" ? { freshContinuationIsolation: continuation.recoveryActionId } : {}) };
}

/** In the admitting transaction: the new run is the recorded continuation, so the delivery pass finds nothing left to start. */
export async function deliverContinuationAsRun(tx: Db, input: { companyId: string; issueId: string; runId: string;
  continuation: UndeliveredContinuation }) {
  const { continuation } = input;
  await tx.update(heartbeatRuns).set({ retryOfRunId: continuation.sourceRunId })
    .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId)));
  await tx.update(issueRecoveryActions).set({ evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify({
    continuationDelivery: "delivered", continuationRunId: input.runId, continuationDeliveredByPersonRun: true })}::jsonb` })
    .where(and(eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.id, continuation.recoveryActionId),
      sql`${issueRecoveryActions.evidence}->>'continuationDelivery' = 'pending'`));
  await settleCoalescedFreshContinuationHolds(tx, { companyId: input.companyId, primaryId: continuation.recoveryActionId,
    delivery: "delivered", continuationRunId: input.runId });
  await foldWaitingRetriesIntoContinuation(tx, { companyId: input.companyId, issueId: input.issueId, runId: input.runId,
    sourceRunId: continuation.sourceRunId });
}
