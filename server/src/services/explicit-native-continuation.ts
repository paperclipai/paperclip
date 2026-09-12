import { isCancelledNativeStartup } from "./cancelled-native-startup.js";
import { hasNativeLocalProcessStop } from "./native-local-process-stop.js";
import { completeTerminatedRemoteNativeSessionCleanup } from "../vendor/paperclip-runner/index.js";
import { hasRemoteTerminationReceipt, remoteLeaseCleanupScope } from "./remote-execution-termination.js";
import { z } from "zod";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  agents, agentWakeupRequests, approvals, issueApprovals, issueThreadInteractions,
  environmentLeases, heartbeatRuns, issueComments, issueRecoveryActions,
  issues, nativeRunFinalizations, type Db,
} from "@paperclipai/db";
import { executionBlockerPredicate, getExecutionBlocker } from "./execution-blocker.js";
import { buildExecutionContinuation } from "./execution-continuation.js";
import { adapterExecutionControls } from "./adapter-execution-control.js";
import { persistActivity } from "./activity-log.js";

import { historicalAdapterType, isConversationAdapter } from "./conversation-continuation.js";
import { queuedCommentIdsFromWakePayload } from "./issue-queued-comment-queue.js";

type Run = typeof heartbeatRuns.$inferSelect;
const terminal = ["failed", "interrupted", "timed_out", "cancelled"];

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
  /** Server-recorded board intent to send an existing legacy message queue. */
  queuedCommentInterruptId?: string;
  /** Internal delivery of an unconsumed, user-authored legacy queue entry. */
  queuedCommentRequestId?: string;
  dryRun?: boolean;
  onBlocked?: (reason: string, message: string) => void;
}): Promise<{ previousRunId: string; commentId: string | null; failedRunId?: string } | null> {
  const { db, companyId, issueId, agentId, actorId, commentId } = input;
  const blocked = (reason: string, message: string) => { input.onBlocked?.(reason, message); return null; };
  if (input.actorType !== "user" || !actorId) return null;
  const retry = input.reason === "retry_failed_run" &&
    z.string().guid().safeParse(input.failedRunId).success;
  if (!retry && (!commentId || !z.string().guid().safeParse(commentId).success ||
      !["issue_commented", "issue_reopened_via_comment"].includes(input.reason ?? ""))) return null;
  const [task] = await db.select().from(issues).where(and(
    eq(issues.companyId, companyId), eq(issues.id, issueId),
  ));
  if (!task || task.assigneeAgentId !== agentId || ["done", "cancelled"].includes(task.status)) return null;
  const [interruptQueue] = input.queuedCommentInterruptId ? await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.id, input.queuedCommentInterruptId),
    eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId),
    eq(agentWakeupRequests.status, "deferred_issue_execution"),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
    sql`${agentWakeupRequests.payload}->'queuedCommentInterrupt'->>'actorId' = ${actorId}`,
  )) : [];
  const queuedInterrupt = Boolean(interruptQueue && commentId &&
    queuedCommentIdsFromWakePayload(interruptQueue.payload).includes(commentId));
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
  if (queuedRequest) {
    const ids = queuedCommentIdsFromWakePayload(savedQueue!.payload);
    const undelivered = await undeliveredLegacyUserCommentIds(db, companyId, issueId, agentId, ids);
    if (undelivered.length !== ids.length) return null;
  }
  const [comment] = retry ? [] : await db.select().from(issueComments).where(and(
    eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
    eq(issueComments.id, commentId!), eq(issueComments.authorType, "user"),
    queuedInterrupt ? undefined : eq(issueComments.authorUserId, actorId), isNull(issueComments.createdByRunId),
    isNull(issueComments.deletedAt),
  ));
  if (!retry && !comment?.body.trim()) return null;
  const authorizedAt = comment?.createdAt ?? new Date();
  const [agent] = await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)));
  if (!agent || (!isConversationAdapter(agent.adapterType) && agent.adapterType !== "paperclip_runner")) return null;
  if (queuedInterrupt && !isConversationAdapter(agent.adapterType)) return null;
  const actions = await db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId),
    executionBlockerPredicate(),
  )).for("update");
  if (!actions.length) return null;
  const blocker = await getExecutionBlocker(db, companyId, issueId);
  if (blocker && blocker.recoveryActionId === null) return null;
  const [pendingInteraction] = await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, companyId), eq(issueThreadInteractions.issueId, issueId),
    eq(issueThreadInteractions.status, "pending"),
  )).limit(1);
  const [pendingApproval] = await db.select({ id: approvals.id }).from(issueApprovals).innerJoin(approvals, and(
    eq(approvals.id, issueApprovals.approvalId), eq(approvals.companyId, companyId),
  )).where(and(eq(issueApprovals.companyId, companyId), eq(issueApprovals.issueId, issueId),
    inArray(approvals.status, ["pending", "revision_requested"]))).limit(1);
  if (pendingInteraction || pendingApproval) return blocked("decision_pending", "A pending approval or question must be resolved before this message can start.");

  const sources: Run[] = [];
  const cancelledStartupIds = new Set<string>();
  for (const action of actions) {
    const runId = action.evidence.runId ?? action.evidence.sourceRunId;
    if (typeof runId !== "string") return blocked("source_missing", "The stopped run could not be identified. Your message is saved.");
    // Text comparison keeps malformed historical evidence a hold, not a UUID cast error.
    let [run] = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId), sql`${heartbeatRuns.id}::text = ${runId}`,
    ));
    if (!run || run.agentId !== agentId || !terminal.includes(run.status) ||
        (run.nativeIssueId ?? run.contextSnapshot?.issueId) !== issueId ||
        !run.finishedAt) return blocked("source_unavailable", "The previous execution has not finished or its owner changed. Your message is saved.");
    if (!queuedInterrupt && !queuedRequest && authorizedAt <= run.finishedAt) return blocked("message_predates_stop", "This message arrived before the previous run stopped. Send a new message to continue.");
    if (adapterExecutionControls.has(run.id)) return blocked("execution_settling", "Waiting for the previous run to stop. Your message will start automatically.");
    const unusedAdmission = run.status === "cancelled" && !run.startedAt &&
      run.errorCode === "execution_reconciliation_required" &&
      !run.processPid && !run.processGroupId && !run.nativeSessionId;
    const legacyUserTurn = run.runtimeMode === "legacy" &&
      action.cause === "legacy_execution_requires_reconciliation" &&
      isConversationAdapter(agent.adapterType);
    if ((queuedInterrupt || queuedRequest) && !legacyUserTurn && !unusedAdmission) return null;
    // Saved input is a request for a new turn, never permission to undo an
    // operator Stop or redeliver a message already consumed by this run.
    if (queuedRequest && !queuedInterrupt && ((run.status === "cancelled" && !unusedAdmission) ||
        run.contextSnapshot?.wakeCommentId === commentId ||
        (Array.isArray(run.contextSnapshot?.wakeCommentIds) && run.contextSnapshot.wakeCommentIds.includes(commentId)))) return null;
    if (legacyUserTurn) {
      const historicalAdapter = await historicalAdapterType(db, run);
      // A settings change never converts a known process/webhook execution into
      // a conversation. Those adapters retain their reconciliation contract.
      if (historicalAdapter && !isConversationAdapter(historicalAdapter)) return null;
    }
    // For pre-upgrade rows without adapter evidence, only a new explicit user
    // turn is allowed, after the termination proofs below. This does not infer
    // an old adapter type, certify old outcomes, or authorize automatic replay.
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.companyId, companyId), eq(nativeRunFinalizations.runId, run.id),
    )).for("update");
    // Same lock order as the native claim. Re-read the run while holding both
    // locks before accepting the never-claimed startup proof.
    const [lockedRun] = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, run.id),
    )).for("update");
    if (!lockedRun || lockedRun.status !== run.status || lockedRun.agentId !== run.agentId ||
        lockedRun.finishedAt?.getTime() !== run.finishedAt.getTime()) return null;
    run = lockedRun;
    const cancelledStartup = await isCancelledNativeStartup(db, run, coordinator);
    if (cancelledStartup) cancelledStartupIds.add(run.id);
    if (run.runtimeMode !== "native" && !unusedAdmission && !legacyUserTurn && !cancelledStartup) return null;
    if (!cancelledStartup && coordinator && (coordinator.phase !== "terminal_failure" || coordinator.leaseOwner ||
        coordinator.resultId || coordinator.failureDetail?.successorRunId)) return blocked("controller_settling",
          run.status === "cancelled" && !coordinator.leaseOwner
            ? "The cancelled run still needs verified cleanup. Your message is saved. Inspect the run and its environment for details."
            : "Waiting for the previous run to finish recovery. Your message will start automatically.");
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
        // A missing process identity is not evidence that a provider exited.
        if (!run.processPid && !run.processGroupId &&
            !await hasNativeLocalProcessStop(db, companyId, run.id)) return blocked("process_identity_missing", "The previous run has no verified stop record. Paperclip cannot start this message yet.");
        if (run.processPid && !processStopped(run.processPid)) return blocked("process_running", "Waiting for the previous process to stop. Your message will start automatically.");
        if (run.processGroupId && !processStopped(-run.processGroupId)) return blocked("process_running", "Waiting for the previous process to stop. Your message will start automatically.");
      }
    }
    sources.push(run);
  }
  const nativeSources = sources.filter(run => run.runtimeMode === "native");
  const executedSources = sources.filter(run => run.runtimeMode === "native" || run.errorCode !== "execution_reconciliation_required" || run.startedAt);
  if (!executedSources.length || (retry && !sources.some(run => run.id === input.failedRunId))) return null;
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
  if (input.dryRun) return { previousRunId: previous.id, commentId, ...(retry ? { failedRunId: input.failedRunId! } : {}) };
  const authorization = { actorId, commentId, ...(retry ? { failedRunId: input.failedRunId } : {}),
    ...(queuedInterrupt ? { queuedCommentInterruptId: input.queuedCommentInterruptId } : {}),
    ...(queuedRequest ? { queuedCommentRequestId: input.queuedCommentRequestId } : {}), runId: input.successorRunId,
    previousRunId: previous.id, recordedAt: new Date().toISOString() };
  for (const runId of cancelledStartupIds) {
    await db.update(nativeRunFinalizations).set({
      phase: "terminal_failure", failureCode: "native_startup_cancelled", nextAttemptAt: null,
      controlDeadlineAt: null, updatedAt: new Date(),
    }).where(and(eq(nativeRunFinalizations.companyId, companyId), eq(nativeRunFinalizations.runId, runId)));
    await db.update(heartbeatRuns).set({
      ...(nativeSources.some(run => run.id === runId) ? { nativePhase: "terminal_failure", nativePhaseUpdatedAt: new Date() } : {}),
      executionControlDeadlineAt: null,
    }).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)));
  }
  if (nativeSources.length) await db.update(nativeRunFinalizations).set({
    failureDetail: sql`coalesce(${nativeRunFinalizations.failureDetail}, '{}'::jsonb) || ${JSON.stringify({ replacementDenied: "explicit_user_continuation" })}::jsonb`,
    updatedAt: new Date(),
  }).where(and(eq(nativeRunFinalizations.companyId, companyId), inArray(nativeRunFinalizations.runId, nativeSources.map(run => run.id))));
  for (const action of actions) {
    await db.update(issueRecoveryActions).set({
      status: "resolved", outcome: "cancelled", resolvedAt: new Date(), updatedAt: new Date(),
      nextAction: "The user started a fresh conversation turn. Prior action outcomes remain recorded.",
      resolutionNote: "The user continued after the prior execution stopped. No action outcomes were inferred.",
      wakePolicy: null, monitorPolicy: null,
      evidence: { ...action.evidence, explicitUserContinuation: authorization,
        ...(action.evidence.automaticRecovery ? { automaticRecovery: {
          ...(action.evidence.automaticRecovery as Record<string, unknown>), replay: "explicit_user_continuation",
        } } : {}),
      },
    }).where(eq(issueRecoveryActions.id, action.id));
  }
  await persistActivity(db, { companyId, actorType: "user", actorId,
    action: "issue.execution_recovery_settled", entityType: "issue", entityId: issueId,
    details: { continuation: retry ? "explicit_user_retry" : "explicit_user_message", ...authorization,
      recoveryActionIds: actions.map(action => action.id), previousRunIds: sources.map(run => run.id) },
  });
  return { previousRunId: previous.id, commentId, ...(retry ? { failedRunId: input.failedRunId! } : {}) };
}
