import { isPreDispatchReviewWait } from "./pre-dispatch-review-wait.js";
import { preDispatchExecutionWaitRecoveryActionPredicate } from "./pre-dispatch-execution-wait.js";
import { and, desc, eq, gt, inArray, not, or, sql } from "drizzle-orm";
import { conversationRecoveryActionPredicate, getConversationOwnershipBlocker } from "./conversation-continuation.js";
import { z } from "zod";
import { agentWakeupRequests, chatConversations, chatEndpoints, environmentLeases, heartbeatRuns, issueComments, issues, issueRecoveryActions, nativeRunFinalizations, toolConnections, type Db } from "@paperclipai/db";
import { canContinueCancelledRun, readRunCancellation } from "./run-cancellation.js";
import { canRetryStoppedRun } from "./cancelled-native-startup.js";
import { queuedCommentIdsFromWakePayload } from "./issue-queued-comment-queue.js";
import { EXECUTION_RECONCILIATION_CAUSES, type ExecutionBlocker } from "@paperclipai/shared";
import { hasRequiredWorkspaceRecovery, LEGACY_WORKSPACE_RECOVERY_SCHEMA, nativeRunHasNoWorkspaceAccess } from "./workspace-restore-recovery-state.js";
import { unreconciledNativeExportPredicate } from "./native-runtime/native-workspace-reconstruction.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { readNativeWorkspaceSyncReference } from "./native-runtime/native-workspace-sync.js";
import { hasVerifiedWorkspaceRepair, workspaceRecoveryDisplay } from "./workspace-recovery-receipt.js";

const blockerContextKeys = ["issueId", "taskId", "source", "connectionIntentResolution",
  "interactionKind", "interactionStatus", "mutation", "interactionId"] as const;
const blockerProfileKeys = ["adapterDispatch", "nativeExecutionInput", "nativeWorkspaceSync"] as const;
const blockerContextColumn = sql<Record<string, unknown> | null>`case
  when ${heartbeatRuns.contextSnapshot} is null then null else (
    select coalesce(jsonb_object_agg(field.key, field.value), '{}'::jsonb)
    from jsonb_each(case when jsonb_typeof(${heartbeatRuns.contextSnapshot}) = 'object'
      then ${heartbeatRuns.contextSnapshot} else '{}'::jsonb end) as field(key, value)
    where field.key in (${sql.join(blockerContextKeys.map(key => sql`${key}`), sql`, `)})
  ) end`;
const blockerProfileColumn = sql<Record<string, unknown> | null>`case
  when ${heartbeatRuns.runnerProfileJson} is null then null else (
    select coalesce(jsonb_object_agg(field.key, case field.key
      when 'adapterDispatch' then jsonb_build_object('adapterType', field.value->'adapterType')
      when 'nativeExecutionInput' then case when jsonb_typeof(field.value) = 'object' then (
        select coalesce(jsonb_object_agg(input_field.key, input_field.value), '{}'::jsonb)
        from jsonb_each(field.value) as input_field(key, value)
        where input_field.key in ('schema', 'binding', 'provider', 'workspace')
      ) else field.value end
      else field.value end), '{}'::jsonb)
    from jsonb_each(case when jsonb_typeof(${heartbeatRuns.runnerProfileJson}) = 'object'
      then ${heartbeatRuns.runnerProfileJson} else '{}'::jsonb end) as field(key, value)
    where field.key in (${sql.join(blockerProfileKeys.map(key => sql`${key}`), sql`, `)})
  ) end`;
const blockerRunFields = {
  id: heartbeatRuns.id,
  companyId: heartbeatRuns.companyId,
  agentId: heartbeatRuns.agentId,
  status: heartbeatRuns.status,
  startedAt: heartbeatRuns.startedAt,
  finishedAt: heartbeatRuns.finishedAt,
  error: heartbeatRuns.error,
  errorCode: heartbeatRuns.errorCode,
  issueId: heartbeatRuns.issueId,
  nativeIssueId: heartbeatRuns.nativeIssueId,
  nativeSessionId: heartbeatRuns.nativeSessionId,
  runtimeMode: heartbeatRuns.runtimeMode,
  runtimeModeResolvedAt: heartbeatRuns.runtimeModeResolvedAt,
  driverKind: heartbeatRuns.driverKind,
  processPid: heartbeatRuns.processPid,
  processGroupId: heartbeatRuns.processGroupId,
  processStartedAt: heartbeatRuns.processStartedAt,
  sessionIdAfter: heartbeatRuns.sessionIdAfter,
  controllerBootId: heartbeatRuns.controllerBootId,
  controllerLeaseExpiresAt: heartbeatRuns.controllerLeaseExpiresAt,
  executionStage: heartbeatRuns.executionStage,
  resultJson: heartbeatRuns.resultJson,
  contextSnapshot: blockerContextColumn,
  runnerProfileJson: blockerProfileColumn,
};

export async function hasPendingRunCleanup(db: Db, companyId: string, runId: string): Promise<boolean> {
  const [state] = await db.execute<{ pending: boolean }>(sql`SELECT
    ${heartbeatRuns.runnerProfileJson}->>'nativeWorkspaceFinalizationOwner' IS NOT NULL
    OR EXISTS (SELECT 1 FROM ${environmentLeases}
      WHERE ${environmentLeases.companyId} = ${companyId} AND ${environmentLeases.heartbeatRunId} = ${runId}
        AND (( ${environmentLeases.releasedAt} IS NULL AND NOT COALESCE(
            ${environmentLeases.status} = 'retained' AND ${environmentLeases.leasePolicy} = 'reuse_by_environment'
              AND ${environmentLeases.cleanupStatus} = 'success', false))
          OR ${environmentLeases.status} IN ('active', 'pending_cleanup') OR ${environmentLeases.cleanupStatus} = 'failed'
          OR COALESCE(${environmentLeases.metadata}->>'pendingCleanupInFlight', 'false') <> 'false'
          OR (${heartbeatRuns.runtimeMode} = 'native' AND NOT COALESCE(
            (${environmentLeases.status} IN ('released', 'expired', 'failed')
              AND ${environmentLeases.releasedAt} IS NOT NULL AND (${environmentLeases.cleanupStatus} = 'success'
                OR (${environmentLeases.cleanupStatus} IS NULL AND (
                  (${environmentLeases.provider} = 'local' AND ${environmentLeases.providerLeaseId} IS NULL)
                  OR (${environmentLeases.provider} = 'ssh' AND ${environmentLeases.metadata}->>'driver' = 'ssh'
                    AND ${environmentLeases.providerLeaseId} LIKE 'ssh://%')))))
            OR (${environmentLeases.status} = 'retained' AND ${environmentLeases.leasePolicy} = 'reuse_by_environment'
              AND ${environmentLeases.cleanupStatus} = 'success'), false))))
    OR EXISTS (SELECT 1 FROM ${nativeRunFinalizations}
      WHERE ${nativeRunFinalizations.companyId} = ${companyId} AND ${nativeRunFinalizations.runId} = ${runId}
        AND (${nativeRunFinalizations.leaseOwner} IS NOT NULL
          OR ${nativeRunFinalizations.phase} NOT IN ('committed', 'applied', 'terminal_failure'))) AS pending
    FROM ${heartbeatRuns} WHERE ${heartbeatRuns.companyId} = ${companyId} AND ${heartbeatRuns.id} = ${runId} LIMIT 1`);
  return state?.pending !== false;
}

/** Resolved recovery bookkeeping can still carry an effective no-replay hold. */
export function executionBlockerPredicate() {
  return and(
    not(conversationRecoveryActionPredicate()!),
    not(preDispatchExecutionWaitRecoveryActionPredicate()),
    or(unreconciledNativeExportPredicate(), and(
      inArray(issueRecoveryActions.cause, [...EXECUTION_RECONCILIATION_CAUSES]),
      or(inArray(issueRecoveryActions.status, ["active", "escalated"]),
        sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`),
    )),
  );
}

export function nativeExecutionRecoveryActionPredicate() {
  return sql`exists (select 1 from ${heartbeatRuns}
    where ${heartbeatRuns.companyId} = ${issueRecoveryActions.companyId}
      and ${heartbeatRuns.id}::text = coalesce(${issueRecoveryActions.evidence}->>'runId', ${issueRecoveryActions.evidence}->>'sourceRunId')
      and ${heartbeatRuns.runtimeMode} = 'native')`;
}

export async function getExecutionBlocker(db: Db, companyId: string, issueId: string, options?: { conversationResetCommentId?: string | null }): Promise<ExecutionBlocker | null> {
  const [conversation] = await db.select({ agentId: issues.conversationAgentId,
    boundaryId: issues.conversationBoundaryCommentId, status: issues.status,
    assigneeAgentId: issues.assigneeAgentId, statusVersion: issues.statusVersion,
    executionRunId: issues.executionRunId, checkoutRunId: issues.checkoutRunId }).from(issues).where(and(
    eq(issues.companyId, companyId), eq(issues.id, issueId),
  )).limit(1);
  // Resetting model context cannot repair or recover a workspace. This hold
  // survives conversation boundaries until the existing repair/reconciliation path clears it.
  const [restoreHold] = await db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, companyId),
    eq(issueRecoveryActions.sourceIssueId, issueId),
    executionBlockerPredicate(),
    or(
      unreconciledNativeExportPredicate(),
      sql`${issueRecoveryActions.evidence}->>'workspaceRestoreFailure' = 'restore_unsafe_archive'`,
      sql`${issueRecoveryActions.evidence}->'workspaceRestoreRecovery'->>'schema' = ${LEGACY_WORKSPACE_RECOVERY_SCHEMA}`,
    ),
  )).orderBy(desc(issueRecoveryActions.updatedAt)).limit(1);
  // A persisted user /new is an ordered context command, not a retry of uncertain work.
  // The normal issue execution lock still serializes it behind any active turn.
  if (!restoreHold && conversation?.agentId && options?.conversationResetCommentId) {
    const [command] = await db.select().from(issueComments).where(and(
      eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
      eq(issueComments.id, options.conversationResetCommentId),
    )).limit(1);
    if (command?.authorUserId && !command.deletedAt && command.body.trim() === "/new") return null;
  }
  const [boundary] = conversation?.agentId && conversation.boundaryId
    ? await db.select({ createdAt: issueComments.createdAt }).from(issueComments).where(and(
      eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
      eq(issueComments.id, conversation.boundaryId),
    )).limit(1) : [];

  const ownership = await getConversationOwnershipBlocker(db, companyId, issueId);
  if (ownership) return { ...ownership, recoveryActionId: null };
  const [action] = restoreHold ? [restoreHold] : await db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, companyId),
    eq(issueRecoveryActions.sourceIssueId, issueId),
    executionBlockerPredicate(),
    boundary ? or(gt(issueRecoveryActions.createdAt, boundary.createdAt), nativeExecutionRecoveryActionPredicate()) : undefined,
  )).orderBy(desc(issueRecoveryActions.updatedAt), desc(issueRecoveryActions.id)).limit(1);
  if (!action) return null;
  const parsedRunId = z.string().guid().safeParse(action.evidence.runId ?? action.evidence.sourceRunId);
  const runId = parsedRunId.success ? parsedRunId.data : null;
  const [run] = runId ? await db.select(blockerRunFields).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId),
  )).limit(1) : [];
  const withoutWorkspace = Boolean(run?.driverKind === "grok_bot_mcp" && nativeRunHasNoWorkspaceAccess(run));
  const workspaceRepairRequired = Boolean(restoreHold && !withoutWorkspace && (!run || !await hasVerifiedWorkspaceRepair(db, run)));
  const workspaceRecovery = workspaceRecoveryDisplay(action.evidence, runId);
  const reconstructableExport = ["native_workspace_sync_out_unrecoverable", "native_workspace_sync_out_retry_exhausted"].includes(action.cause);
  const exportSource = reconstructableExport ? readNativeWorkspaceSyncReference(run?.runnerProfileJson?.nativeWorkspaceSync) : null;
  const [exportLease] = exportSource ? await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, companyId), eq(environmentLeases.heartbeatRunId, run!.id), eq(environmentLeases.id, exportSource.leaseId),
    eq(environmentLeases.providerLeaseId, exportSource.providerLeaseId),
  )).limit(1) : [];
  const canReconstructWorkspace = Boolean(exportLease && hasRemoteTerminationReceipt(exportLease)
    && (exportLease.metadata?.remoteExecutionTermination as { state?: string } | undefined)?.state === "destroyed"
    && !action.evidence.executionReconciliation && conversation && ["blocked", "in_progress"].includes(conversation.status)
    && !conversation.executionRunId && !conversation.checkoutRunId && conversation.assigneeAgentId === run?.agentId);
  const reconstructionPending = Boolean((action.evidence.executionReconciliation as { workspaceReconstruction?: unknown } | undefined)?.workspaceReconstruction
    && action.evidence.continuationDelivery === "pending");
  const queue = await db.select({ payload: agentWakeupRequests.payload }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.status, "deferred_issue_execution"),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
  ));
  const savedIds = [...new Set(queue.flatMap(entry => {
    const context = entry.payload?._paperclipWakeContext as Record<string, unknown> | undefined;
    return [...queuedCommentIdsFromWakePayload(entry.payload), entry.payload?.commentId, context?.wakeCommentId]
      .filter((id): id is string => z.string().guid().safeParse(id).success);
  }))];
  const saved = savedIds.length ? await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
    inArray(issueComments.id, savedIds), eq(issueComments.authorType, "user"), sql`${issueComments.deletedAt} is null`,
    sql`not exists (select 1 from ${heartbeatRuns} consumed where consumed.company_id = ${companyId}
      and consumed.context_snapshot->>'issueId' = ${issueId}
      and not (consumed.status = 'cancelled' and consumed.started_at is null)
      and (consumed.context_snapshot->>'wakeCommentId' = ${issueComments.id}::text
        or consumed.context_snapshot->'wakeCommentIds' @> jsonb_build_array(${issueComments.id}::text)))`,
  )) : [];
  const cancellation = run ? readRunCancellation(run.resultJson) : null;
  const eligibleContinuation = Boolean(!restoreHold && run && conversation?.assigneeAgentId === run.agentId &&
    !["done", "cancelled"].includes(conversation.status) && canContinueCancelledRun(run));
  const canRetry = Boolean(!restoreHold && run && conversation?.assigneeAgentId === run.agentId &&
    !["done", "cancelled"].includes(conversation.status) && await canRetryStoppedRun(db, run));
  const runError = run && canRetry && isPreDispatchReviewWait(run)
    ? "Waiting for review; this continuation never started."
    : cancellation?.reason ?? (run?.status === "cancelled"
      ? "Execution was cancelled; its source was not recorded."
      : run?.error);
  const [chatBinding] = eligibleContinuation || canRetry ? await db.select({
    state: chatConversations.state, endpointStatus: chatEndpoints.status,
    connectionStatus: toolConnections.status, connectionEnabled: toolConnections.enabled,
  }).from(chatConversations).leftJoin(chatEndpoints, and(
    eq(chatEndpoints.companyId, companyId), eq(chatEndpoints.id, chatConversations.endpointId),
  )).leftJoin(toolConnections, and(
    eq(toolConnections.companyId, companyId), eq(toolConnections.id, chatEndpoints.connectionId),
  )).where(and(
    eq(chatConversations.companyId, companyId), eq(chatConversations.issueId, issueId),
  )).limit(1) : [];
  let nextAction = action.nextAction;
  if (canRetry && !eligibleContinuation) nextAction += " Try again or send a new message to continue once the previous execution has stopped.";
  if (chatBinding && !restoreHold) {
    if (chatBinding.state === "endpoint_removed" || !chatBinding.endpointStatus || chatBinding.endpointStatus === "archived") {
      nextAction = "This chat connection was removed. Inspect the stopped run and create a new task to continue the work.";
    } else if (chatBinding.state === "unavailable" || !["active", "verifying"].includes(chatBinding.endpointStatus) ||
        chatBinding.connectionStatus !== "active" || !chatBinding.connectionEnabled) {
      nextAction = "This chat connection is unavailable. Restore access in Apps or create a new task to continue the work.";
    } else {
      nextAction = "Send a new chat message to continue this conversation.";
    }
  } else if (!restoreHold && run?.status === "cancelled" && !eligibleContinuation && !canRetry && action.cause === "legacy_execution_requires_reconciliation") {
    nextAction += " Inspect the run before sending a new message to request continuation.";
  }

  if (withoutWorkspace && (restoreHold || run?.status === "cancelled") && !run?.resultJson?.externalWorkspaceInspection) {
    nextAction = run?.driverKind === "grok_bot_mcp"
      ? "Inspect this Bot in Grok Bot, then clear the recovery hold and verify the connection in the agent's Runtime settings before assigning more work."
      : "Inspect the stopped work in the external agent and its connection before requesting continuation.";
  }

  if (run?.resultJson?.externalWorkspaceInspection && !restoreHold) {
    nextAction = "Verify the Grok connection, then send a new message to continue. The stopped work will not be replayed.";
  }

  return {
    recoveryActionId: action.id,
    runId,
    // A stopped reviewer can differ from the task owner who receives the work back.
    agentId: run?.agentId ?? null,
    cause: action.cause,
    nextAction: workspaceRecovery?.message ?? (reconstructionPending ? "Continuation from saved sources is queued and waiting for execution checks." : nextAction),
    ...(workspaceRecovery ? { workspaceRecovery } : {}),
    runStatus: run?.status ?? null,
    runError: runError?.slice(0, 1024) ?? null,
    canContinue: eligibleContinuation && !chatBinding,
    canRetry: canRetry && !chatBinding,
    ...(restoreHold ? { workspaceRepairRequired, canRecordWorkspaceRepair: workspaceRepairRequired && hasRequiredWorkspaceRecovery(action.evidence) } : {}),
    savedMessageCount: saved.length,
    ...(canReconstructWorkspace ? { canReconstructWorkspace, workspaceRecoveryStatusVersion: conversation!.statusVersion } : {}),
    ...(reconstructionPending ? { workspaceReconstructionPending: true } : {}),
  };
}
