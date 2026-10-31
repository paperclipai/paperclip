import { notifyUnsafeWorkspaceExportRecovery } from "./unsafe-workspace-export-notifications.js";
import { assertDurableChatWakeupRequest, assertDurableChatWakeupReceipt, type DurableChatWakeupRequest } from "./durable-chat-wakeup.js";
import { notifyExecutionRunWork } from "./execution-control-notifications.js";
import { canSelectFreshWorkspace, type ContinuationReadiness } from "./fresh-workspace-continuation.js";
import { readTaskRetryIntent } from "./task-retry.js";
import { readSystemRecovery } from "./system-recovery-state.js";
import { hasRequiredWorkspaceRecovery } from "./workspace-restore-recovery-state.js";
import { hasVerifiedWorkspaceRepair } from "./workspace-recovery-receipt.js";
import { preserveNativeFailedWorkspace } from "./native-runtime/native-failed-workspace-recovery.js";
import { createHash } from "node:crypto";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { canContinueCancelledRun } from "./run-cancellation.js";
import { readQueuedInteractionResponse } from "./queued-interaction-response.js";
import { isCancelledNativeStartup } from "./cancelled-native-startup.js";
import { hasNativeLocalProcessStop, hasHistoricalSuspendedNativeSession, recordedLocalExecutionStopped } from "./native-local-process-stop.js";
import { completeTerminatedRemoteNativeSessionCleanup } from "../vendor/paperclip-runner/index.js";
import { hasRemoteTerminationReceipt, remoteLeaseCleanupScope } from "./remote-execution-termination.js";
import { z } from "zod";
import { and, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  agents, agentWakeupRequests, approvals, issueApprovals, issueThreadInteractions,
  environmentLeases, heartbeatRuns, issueComments, issueRecoveryActions,
  issues, nativeRunFinalizations, nativeRunResults, type Db,
} from "@paperclipai/db";
import { executionBlockerPredicate, getExecutionBlocker, hasPendingRunCleanup, nativeExecutionRecoveryActionPredicate } from "./execution-blocker.js";
import { buildExecutionContinuation } from "./execution-continuation.js";
import { adapterExecutionControls } from "./adapter-execution-control.js";
import { persistActivity } from "./activity-log.js";
import { activeIssueInteractionCondition } from "./issue-question-context.js";

import { historicalAdapterType, isConversationAdapter } from "./conversation-continuation.js";
import { queuedCommentIdsFromWakePayload } from "./issue-queued-comment-queue.js";

type Run = Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "agentId" | "status" | "startedAt" | "finishedAt" | "createdAt" |
  "issueId" | "nativeIssueId" | "nativeSessionId" | "runnerInstanceId" | "runtimeMode" |
  "runtimeModeResolvedAt" | "errorCode" | "error" | "resultJson" | "contextSnapshot" |
  "runnerProfileJson" | "processPid" | "processGroupId" | "processStartedAt" |
  "sessionIdAfter" | "controllerBootId" | "controllerLeaseExpiresAt" | "executionStage">;
const continuationContextKeys = ["issueId", "wakeCommentId", "wakeCommentIds", "source",
  "connectionIntentResolution", "interactionKind", "interactionStatus", "mutation", "interactionId"];
const continuationContext = sql<Run["contextSnapshot"]>`case
  when ${heartbeatRuns.contextSnapshot} is null then null else (
    select coalesce(jsonb_object_agg(field.key, field.value), '{}'::jsonb)
    from jsonb_each(case when jsonb_typeof(${heartbeatRuns.contextSnapshot}) = 'object'
      then ${heartbeatRuns.contextSnapshot} else '{}'::jsonb end) as field(key, value)
    where field.key in (${sql.join(continuationContextKeys.map(key => sql`${key}`), sql`, `)})
  ) end`;
const preflightProfile = sql<Run["runnerProfileJson"]>`case
  when ${heartbeatRuns.runnerProfileJson} is null then null else (
    select coalesce(jsonb_object_agg(field.key, case when field.key = 'adapterDispatch'
      then jsonb_build_object('adapterType', field.value->'adapterType') else field.value end), '{}'::jsonb)
    from jsonb_each(case when jsonb_typeof(${heartbeatRuns.runnerProfileJson}) = 'object'
      then ${heartbeatRuns.runnerProfileJson} else '{}'::jsonb end) as field(key, value)
    where field.key in ('adapterDispatch', 'nativeWorkspaceSync')
  ) end`;
const continuationRunFields = {
  id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
  status: heartbeatRuns.status, startedAt: heartbeatRuns.startedAt, finishedAt: heartbeatRuns.finishedAt,
  createdAt: heartbeatRuns.createdAt, issueId: heartbeatRuns.issueId, nativeIssueId: heartbeatRuns.nativeIssueId,
  nativeSessionId: heartbeatRuns.nativeSessionId, runnerInstanceId: heartbeatRuns.runnerInstanceId,
  runtimeMode: heartbeatRuns.runtimeMode, runtimeModeResolvedAt: heartbeatRuns.runtimeModeResolvedAt,
  errorCode: heartbeatRuns.errorCode, error: heartbeatRuns.error, resultJson: heartbeatRuns.resultJson,
  contextSnapshot: continuationContext, runnerProfileJson: heartbeatRuns.runnerProfileJson,
  processPid: heartbeatRuns.processPid, processGroupId: heartbeatRuns.processGroupId,
  processStartedAt: heartbeatRuns.processStartedAt, sessionIdAfter: heartbeatRuns.sessionIdAfter,
  controllerBootId: heartbeatRuns.controllerBootId, controllerLeaseExpiresAt: heartbeatRuns.controllerLeaseExpiresAt,
  executionStage: heartbeatRuns.executionStage,
};
const terminal = ["failed", "interrupted", "timed_out", "cancelled"];

export function isUserCommentContinuationReason(reason: string | null | undefined): boolean {
  return reason === "issue_commented" || reason === "issue_reopened_via_comment" || reason === "issue_assigned";
}

function processStopped(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

/** Validate the whole saved queue, preserving order and original authors.
 * Call again under the task lock before adopting IDs into a new run.
 */
export async function undeliveredLegacyUserCommentIds(
  db: Db, companyId: string, issueId: string, agentId: string, commentIds: string[],
): Promise<string[]> {
  if (!commentIds.length) return [];
  const comments = await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
    inArray(issueComments.id, commentIds), eq(issueComments.authorType, "user"),
    isNull(issueComments.createdByRunId), isNull(issueComments.deletedAt),
    sql`nullif(trim(${issueComments.body}), '') is not null`,
    sql`nullif(trim(${issueComments.authorUserId}), '') is not null`,
  ));
  const valid = new Set(comments.map(comment => comment.id));
  const previous = await db.select({ context: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId),
    sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`,
    // A queued turn cancelled before dispatch has not consumed input, whatever
    // cancelled it (pause, stale assignment, or rejected admission). Reserved
    // native identity/process metadata is not proof that its prompt was sent.
    // Admission separately verifies process termination before a new turn.
    sql`not (${heartbeatRuns.status} = 'cancelled' and ${heartbeatRuns.startedAt} is null)`,
    or(...commentIds.map(id => or(
      sql`${heartbeatRuns.contextSnapshot}->>'wakeCommentId' = ${id}`,
      sql`${heartbeatRuns.contextSnapshot}->'wakeCommentIds' @> ${JSON.stringify([id])}::jsonb`,
    ))),
  ));
  for (const { context } of previous) {
    if (typeof context?.wakeCommentId === "string") valid.delete(context.wakeCommentId);
    if (Array.isArray(context?.wakeCommentIds)) {
      for (const id of context.wakeCommentIds) if (typeof id === "string") valid.delete(id);
    }
  }
  return commentIds.filter(id => valid.has(id));
}

/** Called under the issue lock, in the transaction that creates the new turn.
 * A user request authorizes a new conversation, not replay of the failed run.
 * Unknown action outcomes and all prior records stay intact.
 */
export async function admitExplicitNativeContinuation(input: {
  db: Db; companyId: string; issueId: string; agentId: string;
  actorType: string | null | undefined; actorId: string | null | undefined;
  reason: string | null; commentId: string | null; successorRunId: string;
  failedRunId?: string | null;
  taskRetryRequestId?: string;
  queuedCommentInterruptId?: string;
  /** Internal delivery of an unconsumed, user-authored saved queue entry. */
  queuedCommentRequestId?: string;
  durableChatRequest?: DurableChatWakeupRequest;
  dryRun?: boolean;
  onBlocked?: (reason: string, message: string) => void;
}): Promise<{ previousRunId: string; commentId: string | null; failedRunId?: string; taskRetryRequestId?: string; queuedCommentInterruptId?: string; readiness?: ContinuationReadiness } | null> {
  const { db, companyId, issueId, agentId, actorId, commentId } = input;
  const blocked = (reason: string, message: string) => { input.onBlocked?.(reason, message); return null; };
  if (input.actorType !== "user" || !actorId) return null;
  const retry = input.reason === "retry_failed_run" &&
    z.string().guid().safeParse(input.failedRunId).success;
  if (!retry && !input.taskRetryRequestId && !input.queuedCommentInterruptId && (!commentId || !z.string().guid().safeParse(commentId).success ||
      !isUserCommentContinuationReason(input.reason))) return null;
  const [task] = await db.select().from(issues).where(and(
    eq(issues.companyId, companyId), eq(issues.id, issueId),
  ));
  if (!task || task.assigneeAgentId !== agentId || ["done", "cancelled"].includes(task.status)) return null;
  const [retryWake] = input.taskRetryRequestId ? await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.id, input.taskRetryRequestId),
    eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.status, "deferred_issue_execution"),
    eq(agentWakeupRequests.requestedByActorType, "user"), eq(agentWakeupRequests.requestedByActorId, actorId),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
  )) : [];
  const taskRetry = readTaskRetryIntent(retryWake?.payload);
  if (input.taskRetryRequestId && (!taskRetry || taskRetry.generationId !== retryWake?.id || taskRetry.actorId !== actorId)) return null;
  const [interruptQueue] = input.queuedCommentInterruptId ? await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.id, input.queuedCommentInterruptId),
    eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId),
    eq(agentWakeupRequests.status, "deferred_issue_execution"),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
    sql`${agentWakeupRequests.payload}->'queuedCommentInterrupt'->>'actorId' = ${actorId}`,
  )) : [];
  const response = interruptQueue
    ? await readQueuedInteractionResponse(db, companyId, issueId, interruptQueue.payload) : null;
  const queuedInterrupt = Boolean(interruptQueue && (response || (commentId &&
    queuedCommentIdsFromWakePayload(interruptQueue.payload).includes(commentId))));
  if (input.queuedCommentInterruptId && !queuedInterrupt) return null;
  const [savedQueue] = input.queuedCommentRequestId ? await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.id, input.queuedCommentRequestId),
    eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId),
    eq(agentWakeupRequests.status, "deferred_issue_execution"),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
  )) : [];
  const queuedRequest = Boolean(savedQueue && commentId &&
    !savedQueue.idempotencyKey?.startsWith("chat-inbound:") &&
    queuedCommentIdsFromWakePayload(savedQueue.payload).includes(commentId));
  if (input.queuedCommentRequestId && !queuedRequest) return null;
  const chatRequest = input.durableChatRequest;
  let savedChatRequestId: string | undefined;
  if (chatRequest) {
    assertDurableChatWakeupRequest(chatRequest, { companyId, issueId, agentId, commentId,
      requestedByActorType: input.actorType ?? undefined, requestedByActorId: actorId });
    if (chatRequest.failedRunRetry || !chatRequest.resumeDeferred) return null;
    const [receipt] = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.id, chatRequest.id), eq(agentWakeupRequests.companyId, companyId),
      eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.status, "deferred_issue_execution"),
      isNull(agentWakeupRequests.runId), sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
    ));
    if (!receipt || !commentId || !queuedCommentIdsFromWakePayload(receipt.payload).includes(commentId)) return null;
    assertDurableChatWakeupReceipt(chatRequest, receipt);
    savedChatRequestId = receipt.id;
  }
  let partiallyDeliveredQueue = false;
  if (queuedRequest) {
    const ids = queuedCommentIdsFromWakePayload(savedQueue!.payload);
    const undelivered = await undeliveredLegacyUserCommentIds(db, companyId, issueId, agentId, ids);
    // A partly consumed queue still owns its remaining input. Admission and
    // adoption both recheck the durable queue and discard already delivered IDs.
    if (undelivered.at(-1) !== commentId) return null;
    partiallyDeliveredQueue = undelivered.length !== ids.length;
  }
  const [comment] = retry || taskRetry || response ? [] : await db.select().from(issueComments).where(and(
    eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
    eq(issueComments.id, commentId!), eq(issueComments.authorType, "user"),
    queuedInterrupt ? undefined : eq(issueComments.authorUserId, actorId), isNull(issueComments.createdByRunId),
    isNull(issueComments.deletedAt),
  ));
  if (!retry && !taskRetry && !response && !comment?.body.trim()) return null;
  const [agent] = await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)));
  if (!agent || (!isConversationAdapter(agent.adapterType) && agent.adapterType !== "paperclip_runner")) return null;
  const agentIsNative = agent.adapterType === "paperclip_runner";
  const interruptIntent = interruptQueue?.payload?.queuedCommentInterrupt as Record<string, unknown> | undefined;
  const interruptRequestedAt = typeof interruptIntent?.requestedAt === "string" ? new Date(interruptIntent.requestedAt) : null;
  const nativeQueuedSend = queuedInterrupt && agentIsNative;
  if (nativeQueuedSend && (!interruptRequestedAt || !Number.isFinite(interruptRequestedAt.getTime())))
    return blocked("send_intent_missing", "Send the saved message again to continue.");
  const authorizedAt = nativeQueuedSend ? interruptRequestedAt!
    : response?.comment.createdAt ?? comment?.createdAt ?? retryWake?.requestedAt ?? new Date();
  const blocker = await getExecutionBlocker(db, companyId, issueId);
  const [boundary] = await db.select({ createdAt: issueComments.createdAt }).from(issues).innerJoin(issueComments, and(
    eq(issueComments.companyId, issues.companyId), eq(issueComments.issueId, issues.id),
    eq(issueComments.id, issues.conversationBoundaryCommentId),
  )).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId), sql`${issues.conversationAgentId} is not null`)).limit(1);
  const actions = await db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId),
    boundary ? or(gt(issueRecoveryActions.createdAt, boundary.createdAt), nativeExecutionRecoveryActionPredicate(),
      blocker?.recoveryActionId ? eq(issueRecoveryActions.id, blocker.recoveryActionId) : undefined) : undefined,
    or(executionBlockerPredicate(), and(
      inArray(issueRecoveryActions.cause, ["native_workspace_sync_out_unrecoverable", "native_workspace_sync_out_retry_exhausted"]),
      sql`${issueRecoveryActions.evidence}#>>'{workspaceRecovery,status}' = 'recovered'`,
      sql`${issueRecoveryActions.evidence}->'executionReconciliation' is null`,
      sql`${issueRecoveryActions.evidence}->'explicitUserContinuation' is null`,
      sql`not exists (select 1 from ${heartbeatRuns} completed
        join ${nativeRunFinalizations} finalized on finalized.run_id = completed.id and finalized.company_id = completed.company_id
        join ${nativeRunResults} result on result.id = finalized.result_id and result.run_id = completed.id and result.company_id = completed.company_id
        where completed.company_id = ${companyId} and result.issue_id = ${issueId}
          and completed.id::text = coalesce(${issueRecoveryActions.evidence}->>'runId', ${issueRecoveryActions.evidence}->>'sourceRunId')
          and completed.runtime_mode = 'native' and completed.status = 'succeeded' and finalized.phase = 'committed'
          and result.schema_status = 'accepted' and result.result_json#>>'{terminal,runTerminalState}' = 'succeeded')`,
    )),
  )).for("update");
  const sourceChecks = actions.map(action => ({ cause: action.cause, evidence: action.evidence }));
  if (nativeQueuedSend) {
    const [latest] = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, runtimeMode: heartbeatRuns.runtimeMode })
      .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId),
        eq(heartbeatRuns.runtimeMode, "native"),
        or(eq(heartbeatRuns.nativeIssueId, issueId), eq(heartbeatRuns.issueId, issueId),
          sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`)))
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
    if (latest?.runtimeMode === "native" && ["cancelled", "failed"].includes(latest.status) &&
        !sourceChecks.some(source => (source.evidence.runId ?? source.evidence.sourceRunId) === latest.id)) {
      sourceChecks.push({ cause: "native_continuation_requires_reconciliation", evidence: { runId: latest.id } });
    }
  }
  if (!sourceChecks.length) return null;
  if (blocker && blocker.recoveryActionId === null) return null;
  const [pendingInteraction] = await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, companyId), eq(issueThreadInteractions.issueId, issueId),
    eq(issueThreadInteractions.status, "pending"),
    activeIssueInteractionCondition({ responsibleUserId: actorId }),
  )).limit(1);
  const [pendingApproval] = await db.select({ id: approvals.id }).from(issueApprovals).innerJoin(approvals, and(
    eq(approvals.id, issueApprovals.approvalId), eq(approvals.companyId, companyId),
  )).where(and(eq(issueApprovals.companyId, companyId), eq(issueApprovals.issueId, issueId),
    inArray(approvals.status, ["pending", "revision_requested"]))).limit(1);
  if (pendingInteraction || pendingApproval) return blocked("decision_pending", "A pending approval or question must be resolved before this message can start.");

  const sources: Run[] = [];
  let readiness: ContinuationReadiness | undefined;
  const freshSources = new Map<string, string>();
  const stoppedSessions: Array<{ evidence: Record<string, unknown>; retire: () => boolean }> = [];
  const cancelledStartupIds = new Set<string>();
  for (const action of sourceChecks) {
    const runId = action.evidence.runId ?? action.evidence.sourceRunId;
    if (typeof runId !== "string") return blocked("source_missing", "The stopped run could not be identified. Your message is saved.");
    // Text comparison keeps malformed historical evidence a hold, not a UUID cast error.
    let [run] = await db.select({ ...continuationRunFields, runnerProfileJson: preflightProfile }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId), sql`${heartbeatRuns.id}::text = ${runId}`,
    ));
    if (!run || run.agentId !== agentId || !terminal.includes(run.status) ||
        (run.nativeIssueId ?? run.issueId ?? run.contextSnapshot?.issueId) !== issueId ||
        !run.finishedAt) return blocked("source_unavailable", "The previous execution has not finished or its owner changed. Your message is saved.");
    if (!queuedInterrupt && !queuedRequest && authorizedAt <= run.finishedAt) return blocked("message_predates_stop", "This message arrived before the previous run stopped. Send a new message to continue.");
    if (adapterExecutionControls.has(run.id)) return blocked("execution_settling", "Waiting for the previous run to stop. Your message will start automatically.");
    const unusedAdmission = run.status === "cancelled" && !run.startedAt &&
      run.errorCode === "execution_reconciliation_required" &&
      !run.processPid && !run.processGroupId && !run.nativeSessionId;
    const sourceRunId = run.id;
    const strategyRequestId = input.taskRetryRequestId ?? input.queuedCommentRequestId ?? savedChatRequestId;
    const strategyEvidence = strategyRequestId && !Object.hasOwn(action.evidence, "systemRecovery")
      ? actions.find(candidate => {
          const recovery = readSystemRecovery(candidate.evidence);
          return candidate.evidence.runId === sourceRunId && recovery?.sourceRunId === sourceRunId &&
            (input.taskRetryRequestId ? recovery.intentId === input.taskRetryRequestId : true);
        })?.evidence ?? action.evidence
      : action.evidence;
    const freshIntent = await canSelectFreshWorkspace({ db, companyId, issueId, agentId, actorId,
      sourceRunId: run.id, evidence: strategyEvidence, taskRetryRequestId: input.taskRetryRequestId,
      queuedRequestId: input.queuedCommentRequestId ?? savedChatRequestId });
    const legacyUserTurn = run.runtimeMode === "legacy" &&
      action.cause === "legacy_execution_requires_reconciliation" &&
      (isConversationAdapter(agent.adapterType) ||
        (agent.adapterType === "paperclip_runner" && (freshIntent || await hasVerifiedWorkspaceRepair(db, run))));
    // Saved input is a request for a new turn, never permission to undo an
    // operator Stop or redeliver a message already consumed by this run.
    if (queuedRequest && !queuedInterrupt && (run.contextSnapshot?.wakeCommentId === commentId ||
        (Array.isArray(run.contextSnapshot?.wakeCommentIds) && run.contextSnapshot.wakeCommentIds.includes(commentId)))) return null;
    if (legacyUserTurn) {
      const historicalAdapter = await historicalAdapterType(db, run);
      // A settings change never converts a known process/webhook execution into
      // a conversation. Those adapters retain their reconciliation contract.
      if (historicalAdapter && !isConversationAdapter(historicalAdapter)) return null;
      if (!historicalAdapter && agent.adapterType === "paperclip_runner") return null;
    }
    // For pre-upgrade rows without adapter evidence, only a new explicit user
    // turn is allowed, after the termination proofs below. This does not infer
    // an old adapter type, certify old outcomes, or authorize automatic replay.
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.companyId, companyId), eq(nativeRunFinalizations.runId, run.id),
    )).for("update");
    // Same lock order as the native claim. Re-read the run while holding both
    // locks before accepting the never-claimed startup proof.
    const [lockedRun] = await db.select(continuationRunFields).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, run.id),
    )).for("update");
    if (!lockedRun || lockedRun.status !== run.status || lockedRun.agentId !== run.agentId ||
        lockedRun.finishedAt?.getTime() !== run.finishedAt.getTime()) return null;
    run = lockedRun;
    const interruptedByThisClick = response?.source.requiresFreshSession === true &&
      interruptIntent?.targetRunId === run.id && run.resultJson?.operatorInterrupted === true &&
      run.resultJson?.interruptionSource === "issue_comment_interrupt" && run.resultJson?.interruptedIssueId === issueId &&
      run.resultJson?.interruptedByActorType === "user" && run.resultJson?.interruptedByActorId === actorId &&
      run.resultJson?.queuedCommentInterruptQueueId === input.queuedCommentInterruptId;
    if (nativeQueuedSend && authorizedAt <= run.finishedAt! && !interruptedByThisClick)
      return blocked("send_predates_stop", "Send the saved message again now that the previous run has stopped.");
    if (coordinator && coordinator.phase !== "committed" && coordinator.resultId &&
        readSystemRecovery(action.evidence)) {
      const [completedResult] = await db.select({ id: nativeRunResults.id }).from(nativeRunResults).where(and(
        eq(nativeRunResults.companyId, companyId), eq(nativeRunResults.issueId, issueId),
        eq(nativeRunResults.runId, run.id), eq(nativeRunResults.id, coordinator.resultId),
        eq(nativeRunResults.schemaStatus, "accepted"),
        sql`${nativeRunResults.resultJson}#>>'{terminal,runTerminalState}' = 'succeeded'`,
      )).limit(1);
      if (completedResult) return blocked("finalizing_saved_result", "Paperclip is finishing the saved result.");
    }
    // A repaired export no longer blocks execution. Its machine receipt still
    // binds the saved user turn; finalized file state alone is insufficient.
    if (["native_workspace_sync_out_unrecoverable", "native_workspace_sync_out_retry_exhausted"].includes(action.cause)
      && !freshIntent && !await hasVerifiedWorkspaceRepair(db, run)) return blocked("workspace_repair_required",
      "Paperclip is recovering saved work before continuing. Your message is saved.");
    if ((run.resultJson?.workspaceRestoreFailure === "restore_unsafe_archive" || hasRequiredWorkspaceRecovery(run.resultJson))
      && !freshIntent && !await hasVerifiedWorkspaceRepair(db, run)) {
      return blocked("workspace_repair_required", "Paperclip is recovering saved work before continuing. Your message is saved.");
    }
    const cancelledStartup = await isCancelledNativeStartup(db, run, coordinator);
    if (partiallyDeliveredQueue && run.runtimeMode !== "native" && !unusedAdmission && !cancelledStartup) return null;
    if ((queuedInterrupt || queuedRequest) && !legacyUserTurn && !unusedAdmission &&
        !(queuedRequest && run.runtimeMode === "native" &&
          (run.status !== "cancelled" || authorizedAt > run.finishedAt!)) &&
        !(queuedRequest && cancelledStartup && authorizedAt > run.finishedAt!) &&
        !(nativeQueuedSend && (run.runtimeMode === "native" || cancelledStartup) && authorizedAt > run.finishedAt!) &&
        !(queuedInterrupt && response?.source.requiresFreshSession && run.runtimeMode === "native")) return null;
    // A saved native message sent after Stop is a new user direction. Older
    // input cannot restart a cancelled run merely because it is still queued.
    if (queuedRequest && !queuedInterrupt && run.status === "cancelled" && !unusedAdmission &&
        !canContinueCancelledRun(run) && !(run.runtimeMode === "native" && authorizedAt > run.finishedAt!) &&
        !(cancelledStartup && authorizedAt > run.finishedAt!)) return null;
    if (retry && run.status === "cancelled" && !canContinueCancelledRun(run) && !cancelledStartup)
      return blocked("cancelled_by_operator", "Inspect the stopped run and send a new message to continue.");
    if (cancelledStartup) cancelledStartupIds.add(run.id);
    if (run.runtimeMode !== "native" && !unusedAdmission && !legacyUserTurn && !cancelledStartup) return null;
    // A provider failure can finish the normal result/assessment commit path.
    // Its accepted failed result is immutable history, not a live controller.
    // Only a new user turn may pass this gate; the process/lease stop proofs
    // below remain mandatory and no previous action is automatically replayed.
    const [committedFailure] = coordinator?.phase === "committed" && coordinator.resultId && run.status === "failed"
      ? await db.select({ id: nativeRunResults.id }).from(nativeRunResults).where(and(
          eq(nativeRunResults.companyId, companyId), eq(nativeRunResults.issueId, issueId),
          eq(nativeRunResults.runId, run.id), eq(nativeRunResults.id, coordinator.resultId),
          eq(nativeRunResults.schemaStatus, "accepted"),
          sql`${nativeRunResults.resultJson}->'terminal'->>'runTerminalState' = 'failed'`,
        )).limit(1)
      : [];
    // A terminal failure may retain a result accepted before checkpoint or
    // cleanup failed. That immutable result is history, not an active commit.
    // Keep it intact and require the same controller/process/lease stop proofs
    // before admitting new user input; never apply or replay the old result.
    if (!cancelledStartup && coordinator && (
        (coordinator.phase !== "terminal_failure" && !committedFailure) || coordinator.leaseOwner ||
        coordinator.failureDetail?.successorRunId)) return blocked("controller_settling",
          run.status === "cancelled" && !coordinator.leaseOwner
            ? "The cancelled run still needs verified cleanup. Your message is saved. Inspect the run and its environment for details."
            : "Waiting for the previous run to finish recovery. Your message will start automatically.");
    const preserved = hasRequiredWorkspaceRecovery(run.resultJson) ? null
      : await preserveNativeFailedWorkspace(db, run);
    if (preserved && hasRequiredWorkspaceRecovery(preserved.resultJson)) return blocked("workspace_repair_required",
      "Paperclip is recovering saved work before continuing. Your message is saved.");
    const leases = await db.select()
      .from(environmentLeases).where(and(
        eq(environmentLeases.companyId, companyId), eq(environmentLeases.heartbeatRunId, run.id),
      ));
    const remote = leases.some(lease => lease.provider !== "local");
    if (remote) {
      // Never interpret remote PIDs using the control-plane host's process table.
      if (!leases.every(hasRemoteTerminationReceipt)) return blocked("remote_cleanup", "Waiting for the previous environment to stop. Your message will start automatically.");
      if (run.runtimeMode === "native" && !input.dryRun && !leases.every(lease => completeTerminatedRemoteNativeSessionCleanup({
        companyId, runId: run.id, remoteCleanupScope: remoteLeaseCleanupScope(lease)!,
      }))) return null;
    } else {
      if (leases.some(lease => !lease.releasedAt || lease.cleanupStatus === "failed")) return blocked("local_cleanup", "Waiting for the previous environment to finish cleanup. Your message will start automatically.");
      if (!unusedAdmission && !cancelledStartup) {
        if (freshIntent && (run.processPid || run.processGroupId) && !await recordedLocalExecutionStopped(db, run))
          return blocked("process_identity_missing", "Paperclip is verifying that the previous session stopped.");
        // A missing process identity is not evidence that a provider exited.
        if (!run.processPid && !run.processGroupId &&
            !await hasNativeLocalProcessStop(db, companyId, run.id) &&
            !await hasHistoricalSuspendedNativeSession(db, run)) return blocked("process_identity_missing", "The previous run has no verified stop record. Paperclip cannot start this message yet.");
        if (run.processPid && !processStopped(run.processPid)) return blocked("process_running", "Waiting for the previous process to stop. Your message will start automatically.");
        if (run.processGroupId && !processStopped(-run.processGroupId)) return blocked("process_running", "Waiting for the previous process to stop. Your message will start automatically.");
      }
    }
    if (!remote && run.runtimeMode === "native" && run.errorCode === "native_session_cleanup_quarantined") {
      // This is new user input, never permission to retry the interrupted turn.
      if (retry) return blocked("cleanup_quarantined", "Send a new message after the previous provider has stopped.");
      const { verifyStoppedNativeSessionForContinuation } = await import("./native-runtime/native-session-executor.js");
      const stopped = await verifyStoppedNativeSessionForContinuation(db, run);
      if (!stopped) return blocked("local_cleanup", "Waiting for the previous provider and its tools to stop. Your message is saved.");
      stoppedSessions.push(stopped);
    }
    if (nativeQueuedSend && await hasPendingRunCleanup(db, companyId, run.id))
      return blocked("cleanup_pending", "Waiting for the previous run to finish cleanup. Your message is saved.");
    if (freshIntent && !await hasVerifiedWorkspaceRepair(db, run)) {
      freshSources.set(run.id, freshIntent);
      readiness = { mode: "fresh_isolated_workspace", retryIntentId: freshIntent, sourceRunId: run.id,
        retainedSourceIds: [...new Set([...(readiness?.mode === "fresh_isolated_workspace" ? readiness.retainedSourceIds : []),
          ...leases.map(lease => lease.id)])] };
    }
    sources.push(run);
  }
  const nativeSources = sources.filter(run => run.runtimeMode === "native");
  const executedSources = sources.filter(run => run.runtimeMode === "native" || run.errorCode !== "execution_reconciliation_required" || run.startedAt);
  if (!executedSources.length || (retry && !sources.some(run => run.id === input.failedRunId)) ||
      (taskRetry && !sources.some(run => run.id === taskRetry.sourceRunId))) return null;
  const [active] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId),
    or(eq(heartbeatRuns.nativeIssueId, issueId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`),
    inArray(heartbeatRuns.status, ["running", "queued", "scheduled_retry"]),
    ne(heartbeatRuns.id, input.successorRunId),
  )).limit(1);
  if (active) return blocked("execution_active", "Waiting for the current run. Your message is saved.");
  const previous = executedSources.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!;
  // Prove required task history is available before retiring any hold.
  await buildExecutionContinuation({ db, companyId, issueId, agentId,
    context: { previousRunId: previous.id, wakeCommentId: commentId },
    summary: null, exposeLowTrustRaw: false });
  const continuation = { previousRunId: previous.id, commentId, ...(retry ? { failedRunId: input.failedRunId! } : {}),
    ...(queuedInterrupt ? { queuedCommentInterruptId: input.queuedCommentInterruptId! } : {}),
    ...(taskRetry ? { taskRetryRequestId: input.taskRetryRequestId! } : {}), ...(readiness ? { readiness } : {}) };
  if (input.dryRun) return continuation;
  for (const stopped of stoppedSessions) {
    if (!stopped.retire()) return blocked("local_cleanup", "The previous provider cleanup changed. Your message is saved.");
    await appendHeartbeatRunEvent(db, {
      companyId, runId: String(stopped.evidence.runId), agentId,
      eventType: "native.stopped_conversation_verified", stream: "system", level: "info",
      message: "The old runner and provider stopped. New user input will use a fresh session; prior action outcomes remain recorded.",
      payload: stopped.evidence,
    });
  }
  const authorization = { ...continuation, actorId, commentId, ...(response ? { interactionId: response.source.interactionId } : {}), ...(retry ? { failedRunId: input.failedRunId } : {}),
    ...(comment ? { commentUpdatedAt: comment.updatedAt.toISOString(),
      commentBodyHash: createHash("sha256").update(comment.body).digest("hex") } : {}),
    ...(queuedInterrupt ? { queuedCommentInterruptId: input.queuedCommentInterruptId } : {}),
    ...(queuedRequest ? { queuedCommentRequestId: input.queuedCommentRequestId } : {}), runId: input.successorRunId,
    previousRunId: previous.id, recordedAt: new Date().toISOString() };
  if (input.queuedCommentInterruptId) await db.update(agentWakeupRequests).set({
    payload: sql`jsonb_set(${agentWakeupRequests.payload}, '{queuedCommentInterrupt,continuation}', ${JSON.stringify(authorization)}::jsonb)`,
  }).where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.id, input.queuedCommentInterruptId),
    eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.status, "deferred_issue_execution")));
  if (cancelledStartupIds.size) await db.transaction(async tx => {
    await notifyExecutionRunWork(tx);
    for (const runId of cancelledStartupIds) {
      await tx.update(nativeRunFinalizations).set({
        phase: "terminal_failure", failureCode: "native_startup_cancelled", nextAttemptAt: null,
        controlDeadlineAt: null, updatedAt: new Date(),
      }).where(and(eq(nativeRunFinalizations.companyId, companyId), eq(nativeRunFinalizations.runId, runId)));
      await tx.update(heartbeatRuns).set({
        ...(nativeSources.some(run => run.id === runId) ? { nativePhase: "terminal_failure", nativePhaseUpdatedAt: new Date() } : {}),
        executionControlDeadlineAt: null,
      }).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)));
    }
  });
  if (nativeSources.length) await db.update(nativeRunFinalizations).set({
    failureDetail: sql`coalesce(${nativeRunFinalizations.failureDetail}, '{}'::jsonb) || ${JSON.stringify({ replacementDenied: "explicit_user_continuation" })}::jsonb`,
    updatedAt: new Date(),
  }).where(and(eq(nativeRunFinalizations.companyId, companyId), inArray(nativeRunFinalizations.runId, nativeSources.map(run => run.id))));
  if (actions.length) await db.transaction(async tx => {
    await notifyUnsafeWorkspaceExportRecovery(tx, { companyId, issueId });
  for (const action of actions) {
    await tx.update(issueRecoveryActions).set({
      status: "resolved", outcome: "cancelled", resolvedAt: new Date(), updatedAt: new Date(),
      nextAction: "The user started a fresh conversation turn. Prior action outcomes remain recorded.",
      resolutionNote: "The user continued after the prior execution stopped. No action outcomes were inferred.",
      wakePolicy: null, monitorPolicy: null,
      evidence: { ...action.evidence, explicitUserContinuation: authorization,
        ...(freshSources.has(String(action.evidence.runId)) && readSystemRecovery(action.evidence) ? {
          systemRecovery: { ...readSystemRecovery(action.evidence)!,
            revision: readSystemRecovery(action.evidence)!.revision + 1, freshAttemptRunId: input.successorRunId },
        } : {}),
        ...(action.evidence.automaticRecovery ? { automaticRecovery: {
          ...(action.evidence.automaticRecovery as Record<string, unknown>), replay: "explicit_user_continuation",
        } } : {}),
      },
    }).where(eq(issueRecoveryActions.id, action.id));
  }
  });
  await persistActivity(db, { companyId, actorType: "user", actorId,
    action: "issue.execution_recovery_settled", entityType: "issue", entityId: issueId,
    details: { continuation: retry ? "explicit_user_retry" : "explicit_user_message", ...authorization,
      recoveryActionIds: actions.map(action => action.id), previousRunIds: sources.map(run => run.id) },
  });
  if (readiness) await persistActivity(db, { companyId, actorType: "system", actorId: "task-recovery",
    action: "issue.fresh_workspace_selected", entityType: "issue", entityId: issueId,
    details: { ...readiness, runId: input.successorRunId } });
  if (input.taskRetryRequestId) await db.update(agentWakeupRequests).set({
    payload: sql`jsonb_set(${agentWakeupRequests.payload}, '{taskRetry,strategy}',
      ${JSON.stringify(readiness?.mode === "fresh_isolated_workspace" ? "fresh_isolated_workspace" : "continue")}::jsonb)`,
  }).where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.id, input.taskRetryRequestId)));
  return continuation;
}

/** Re-admit a bounded automatic retry without lending it its parent's receipt.
 * The caller holds the task lock and creates the successor in this transaction.
 * Only unchanged user messages are renewable; Retry/Interrupt intents keep their
 * separate one-run contracts. The scheduler still owns retry and cleanup policy.
 */
export async function admitExplicitContinuationRetry(input: {
  db: Db; companyId: string; issueId: string; agentId: string;
  parentRunId: string; successorRunId: string; now: Date;
}): Promise<{ previousRunId: string; commentId: string } | null> {
  const { db, companyId, issueId, agentId } = input;
  const [task] = await db.select().from(issues).where(and(
    eq(issues.companyId, companyId), eq(issues.id, issueId),
  )).for("update");
  const [parent] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, input.parentRunId),
    eq(heartbeatRuns.agentId, agentId),
  )).for("update");
  if (!task || task.assigneeAgentId !== agentId || task.executionRunId !== input.parentRunId ||
      ["done", "cancelled"].includes(task.status) || !parent ||
      !["failed", "timed_out"].includes(parent.status) || !parent.finishedAt ||
      parent.runtimeMode !== "legacy" || parent.contextSnapshot?.issueId !== issueId ||
      (parent.nativeIssueId !== null && parent.nativeIssueId !== issueId) ||
      adapterExecutionControls.has(parent.id) ||
      await getExecutionBlocker(db, companyId, issueId)) return null;
  const context = parent.contextSnapshot;
  const explicit = context.explicitUserContinuation as Record<string, unknown> | undefined;
  if (!explicit || !z.string().guid().safeParse(explicit.previousRunId).success ||
      !z.string().guid().safeParse(explicit.commentId).success || explicit.failedRunId) return null;
  const commentId = explicit.commentId as string;
  const [comment] = await db.select().from(issueComments).where(and(
    eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
    eq(issueComments.id, commentId), eq(issueComments.authorType, "user"),
    isNull(issueComments.createdByRunId), isNull(issueComments.deletedAt),
  ));
  if (!comment?.authorUserId || !comment.body.trim()) return null;
  const receipts = await db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId),
    eq(issueRecoveryActions.status, "resolved"),
    sql`${issueRecoveryActions.evidence}->'explicitUserContinuation'->>'runId' = ${parent.id}`,
  ));
  const receipt = receipts.find(row => {
    const auth = row.evidence.explicitUserContinuation as Record<string, unknown> | undefined;
    return auth && auth.previousRunId === explicit.previousRunId && auth.commentId === commentId &&
      auth.actorId === comment.authorUserId && !auth.failedRunId && !auth.queuedCommentInterruptId &&
      auth.commentUpdatedAt === comment.updatedAt.toISOString() &&
      auth.commentBodyHash === createHash("sha256").update(comment.body).digest("hex");
  });
  if (!receipt) return null;
  const [superseding] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId),
    or(eq(heartbeatRuns.nativeIssueId, issueId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`),
    ne(heartbeatRuns.id, parent.id), ne(heartbeatRuns.id, input.successorRunId),
    or(eq(heartbeatRuns.retryOfRunId, parent.id),
      // Keep PostgreSQL's timestamp precision: Date would round the parent
      // down and mistake an older run in the same millisecond for a successor.
      sql`${heartbeatRuns.createdAt} > (select source.created_at from heartbeat_runs source
        where source.company_id = ${companyId} and source.id = ${parent.id})`,
      inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"])),
  )).limit(1);
  if (superseding) return null;
  // Reuse dispatch's complete source/actor/receipt validation on the parent.
  // It proves only the parent; the new receipt below authorizes the successor.
  try {
    await buildExecutionContinuation({ db, companyId, issueId, agentId, runId: parent.id,
      context, summary: null, exposeLowTrustRaw: false });
  } catch (error) {
    if (error instanceof Error && ["continuation_user_authorization_missing",
      "continuation_source_context_missing", "continuation_task_ownership_changed"].includes(error.message)) return null;
    throw error;
  }
  const continuation = { previousRunId: parent.id, commentId };
  await db.insert(issueRecoveryActions).values({
    companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
    cause: "explicit_user_continuation_retry", fingerprint: input.successorRunId,
    status: "resolved", outcome: "retry_authorized", resolvedAt: input.now,
    nextAction: "The bounded retry has its own authorization for the unchanged user message.",
    evidence: { explicitUserContinuation: {
      ...continuation, actorId: comment.authorUserId, runId: input.successorRunId,
      commentUpdatedAt: comment.updatedAt.toISOString(),
      commentBodyHash: createHash("sha256").update(comment.body).digest("hex"),
      recordedAt: input.now.toISOString(), automaticRetry: {
        sourceRunId: parent.id, sourceAuthorizationId: receipt.id,
      },
    } },
  });
  return continuation;
}
