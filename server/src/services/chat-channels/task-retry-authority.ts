import { and, eq, sql } from "drizzle-orm";
import { agentWakeupRequests, environmentLeases, heartbeatRuns, issueRecoveryActions, nativeRunFinalizations, nativeRunResults, issues, type Db } from "@paperclipai/db";
import { buildExecutionContinuation } from "../execution-continuation.js";
import { readTaskRetryIntent } from "../task-retry.js";
import { hasNativeLocalProcessStop, hasHistoricalSuspendedNativeSession, recordedLocalExecutionStopped } from "../native-local-process-stop.js";
import { hasRemoteTerminationReceipt } from "../remote-execution-termination.js";
import { adapterExecutionControls } from "../adapter-execution-control.js";
import { getExecutionBlocker } from "../execution-blocker.js";
import { readSystemRecovery } from "../system-recovery-state.js";

/** This receipt changes the workspace strategy, never the external principal,
 * accepted inbound batch, publication scope, or current conversation access. */
export async function readTaskChatRetryIntent(db: Db, input: {
  companyId: string; issueId: string; agentId: string; sourceRunId: string;
  intentId: string; chatActionId?: string;
}) {
  const [wake] = await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.id, input.intentId),
    eq(agentWakeupRequests.agentId, input.agentId), eq(agentWakeupRequests.reason, "task_retry"),
    eq(agentWakeupRequests.requestedByActorType, "user"),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`,
    sql`${agentWakeupRequests.idempotencyKey} like 'task-retry:%'`,
  ));
  const intent = readTaskRetryIntent(wake?.payload);
  return wake && intent && intent.generationId === wake.id && !intent.canonicalIntentId &&
    intent.sourceRunId === input.sourceRunId && intent.actorId === wake.requestedByActorId &&
    (!input.chatActionId || intent.chatActionId === input.chatActionId)
    ? { wake, intent } : null;
}

/** An unusable checkpoint does not prevent an isolated attempt. The old
 * executor must still be contained; a terminal database row is insufficient. */
export async function taskChatRetryExecutionStopped(db: Db, run: typeof heartbeatRuns.$inferSelect) {
  return taskChatRetryExecutionContained(db, run, false);
}

async function taskChatRetryExecutionContained(db: Db, run: typeof heartbeatRuns.$inferSelect, admittedFailure: boolean) {
  if (adapterExecutionControls.has(run.id) ||
      (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date())) return false;
  const [coordinator] = await db.select().from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, run.companyId), eq(nativeRunFinalizations.runId, run.id),
  )).for("share", { noWait: true });
  if (coordinator && (coordinator.leaseOwner || coordinator.failureDetail?.successorRunId ||
      !["terminal_failure", "committed"].includes(coordinator.phase))) return false;
  if (coordinator?.resultId) {
    if (!admittedFailure || run.runtimeMode !== "native" || run.status !== "failed" ||
        run.nativePhase !== "committed" || !run.completionContractId || coordinator.phase !== "committed" ||
        coordinator.issueId !== run.nativeIssueId) return false;
    const [failedResult] = await db.select({ id: nativeRunResults.id }).from(nativeRunResults).where(and(
      eq(nativeRunResults.companyId, run.companyId), eq(nativeRunResults.runId, run.id),
      eq(nativeRunResults.issueId, run.nativeIssueId!), eq(nativeRunResults.id, coordinator.resultId),
      eq(nativeRunResults.schemaStatus, "accepted"), eq(nativeRunResults.completionContractId, run.completionContractId),
      sql`${nativeRunResults.resultJson}#>>'{terminal,runTerminalState}' = 'failed'`,
    )).limit(1);
    if (!failedResult) return false;
  }
  const leases = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
  )).for("share", { noWait: true });
  if (leases.some(lease => lease.provider !== "local")) return leases.every(hasRemoteTerminationReceipt);
  return await recordedLocalExecutionStopped(db, run) ||
    await hasNativeLocalProcessStop(db, run.companyId, run.id) ||
    await hasHistoricalSuspendedNativeSession(db, run);
}

/** Dispatch revalidates the canonical admission receipt, not an admission which
 * has already resolved its recovery holds. This exception certifies only the
 * exact current successor; it never makes the failed result replayable. */
export async function taskChatRetryAdmittedContinuationStopped(db: Db, run: typeof heartbeatRuns.$inferSelect,
  input: { issueId: string; intentId: string; successorRunId: string; commentId: string }) {
  if (run.nativeIssueId !== input.issueId) return false;
  const retry = await readTaskChatRetryIntent(db, { companyId: run.companyId, issueId: input.issueId,
    agentId: run.agentId, sourceRunId: run.id, intentId: input.intentId });
  if (!retry?.intent.chatActionId) return false;
  const [task] = await db.select({ assignee: issues.assigneeAgentId, executionRunId: issues.executionRunId })
    .from(issues).where(and(eq(issues.companyId, run.companyId), eq(issues.id, input.issueId)));
  const [successor] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, run.companyId),
    eq(heartbeatRuns.id, input.successorRunId), eq(heartbeatRuns.agentId, run.agentId))).for("share", { noWait: true });
  const [receipt] = await db.select({ runId: agentWakeupRequests.runId, status: agentWakeupRequests.status })
    .from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, run.companyId),
      eq(agentWakeupRequests.id, retry.intent.chatActionId), eq(agentWakeupRequests.agentId, run.agentId)));
  const explicit = successor?.contextSnapshot?.explicitUserContinuation as Record<string, unknown> | undefined;
  if (!successor || task?.assignee !== run.agentId || task.executionRunId !== successor.id ||
      successor.contextSnapshot?.issueId !== input.issueId ||
      (successor.nativeIssueId !== null && successor.nativeIssueId !== input.issueId) ||
      successor.status !== "running" || successor.wakeupRequestId !== retry.intent.chatActionId ||
      successor.retryOfRunId !== run.id || receipt?.runId !== successor.id || receipt.status !== "claimed" ||
      successor.contextSnapshot?.taskRetryRequestId !== input.intentId ||
      explicit?.previousRunId !== run.id || explicit.commentId !== input.commentId ||
      explicit.taskRetryRequestId !== input.intentId || await getExecutionBlocker(db, run.companyId, input.issueId)) return false;
  try {
    await buildExecutionContinuation({ db, companyId: run.companyId, issueId: input.issueId,
      agentId: run.agentId, runId: successor.id, context: successor.contextSnapshot!, summary: null, exposeLowTrustRaw: false });
  } catch (error) {
    if (error instanceof Error && ["continuation_user_authorization_missing", "continuation_source_context_missing",
      "continuation_task_ownership_changed"].includes(error.message)) return false;
    throw error;
  }
  return taskChatRetryExecutionContained(db, run, true);
}

/** Admission may persist a wait for the exact recovery this user requested.
 * This grants no execution authority: promotion and execution still require
 * containment, and the queue retains the source's current execution blocker. */
export async function taskChatRetryCanAwaitRecovery(db: Db, run: typeof heartbeatRuns.$inferSelect,
  issueId: string, intentId: string) {
  const retry = await readTaskChatRetryIntent(db, { companyId: run.companyId, issueId,
    agentId: run.agentId, sourceRunId: run.id, intentId });
  if (!retry || retry.wake.status !== "deferred_issue_execution" || retry.wake.runId) return false;
  const blocker = await getExecutionBlocker(db, run.companyId, issueId);
  if (blocker?.runId !== run.id || !blocker.recoveryActionId) return false;
  const [action] = await db.select({ evidence: issueRecoveryActions.evidence }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, run.companyId), eq(issueRecoveryActions.sourceIssueId, issueId),
    eq(issueRecoveryActions.id, blocker.recoveryActionId),
  )).for("share", { noWait: true });
  const recovery = readSystemRecovery(action?.evidence);
  // Attaching Retry to active automatic recovery preserves that recovery's
  // generation and budget. Its current intentId binds this user request; the
  // Retry receipt's generation is a different identity.
  return Boolean(recovery && recovery.sourceRunId === run.id && recovery.intentId === intentId &&
    ["scheduled", "running", "awaiting_evidence"].includes(recovery.state));
}
