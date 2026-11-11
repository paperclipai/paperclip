import { isPreDispatchReviewWait, neverStartedDispatchCancellationPredicate } from "./pre-dispatch-review-wait.js";
import { canonicalExecutionUuid } from "./execution-identity.js";
import { preDispatchExecutionWaitRecoveryActionPredicate } from "./pre-dispatch-execution-wait.js";
import { legacyShutdownBeforeDispatchCondition } from "./legacy-shutdown-before-dispatch.js";
import { and, desc, eq, gt, inArray, not, or, sql, type SQL } from "drizzle-orm";
import { conversationRecoveryActionPredicate, getConversationOwnershipBlocker } from "./conversation-continuation.js";
import { z } from "zod";
import { agentWakeupRequests, chatConversations, chatEndpoints, environmentLeases, heartbeatRunEvents, heartbeatRuns, issueComments, issues, issueRecoveryActions, nativeRunFinalizations, nativeRunResults, toolConnections, workspaceOperations, type Db } from "@paperclipai/db";
import { canContinueCancelledRun, readRunCancellation } from "./run-cancellation.js";
import { canRetryStoppedRun } from "./cancelled-native-startup.js";
import { queuedCommentIdsFromWakePayload } from "./issue-queued-comment-queue.js";
import { EXECUTION_RECONCILIATION_CAUSES, readRunFailureCause, withoutSqlStatementText, type ExecutionBlocker } from "@paperclipai/shared";
import { hasRequiredWorkspaceRecovery, LEGACY_WORKSPACE_RECOVERY_SCHEMA, nativeRunHasNoWorkspaceAccess } from "./workspace-restore-recovery-state.js";
import { unreconciledNativeExportPredicate } from "./native-runtime/native-workspace-reconstruction.js";
import { hasRecoveredCleanupStopReceipt, hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { readNativeWorkspaceSyncReference } from "./native-runtime/native-workspace-sync.js";
import { completedWorkspaceRecoveryCondition, hasVerifiedWorkspaceRepair, workspaceRecoveryDisplay } from "./workspace-recovery-receipt.js";
import { nativeManualAdmissionHoldsExecution } from "./native-runtime/native-runner-ownership.js";
import { PROCESS_IDENTITY_RECORDED, PROCESS_START_REQUESTED } from "./native-local-process-stop.js";
import { NATIVE_CLEANUP_SETTLING_MESSAGE, NATIVE_SESSION_CLEANUP_QUARANTINED } from "./native-runtime/completed-turn-cleanup.js";

const blockerContextKeys = ["issueId", "taskId", "source", "connectionIntentResolution",
  "interactionKind", "interactionStatus", "mutation", "interactionId"] as const;
const blockerProfileKeys = ["adapterDispatch", "nativeExecutionInput", "nativeWorkspaceSync", "remoteWorkspace", "legacyWorkspaceRecoveryMigration", "finalizedWorkspaceRecoveryMigration"] as const;
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

/** Appended when the person can retry the stopped run on this task. */
export const EXECUTION_BLOCKER_PERSON_RETRY_ACTION =
  "A person can use Retry on this task, or send it a new message, to continue once the previous execution has stopped. Agents cannot retry it for them.";

export async function hasPendingRunCleanup(db: Db, companyId: string, runId: string): Promise<boolean> {
  if (await nativeManualAdmissionHoldsExecution(db, { companyId, runId })) return true;
  // Recovery saved the files and re-stopped this sandbox before queueing its
  // destroy. That destroy is resource cleanup, not a live owner of the run.
  const recoveredStopped = (await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, companyId), eq(environmentLeases.heartbeatRunId, runId),
    sql`${environmentLeases.metadata}->'workspaceRecoveryCleanup' is not null`,
  ))).filter(hasRecoveredCleanupStopReceipt).map(lease => lease.id);
  // A missing predecessor row owns nothing: deleting a run nulls its leases'
  // run reference and removes its finalization coordinator. Failing closed on
  // absence stranded the successor with no next action (invariants 3 and 7).
  const [state] = await db.execute<{ pending: boolean }>(sql`SELECT EXISTS (SELECT 1 FROM ${heartbeatRuns}
    WHERE ${heartbeatRuns.companyId} = ${companyId} AND ${heartbeatRuns.id} = ${runId} AND (
    ${heartbeatRuns.runnerProfileJson}->>'nativeWorkspaceFinalizationOwner' IS NOT NULL
    OR EXISTS (SELECT 1 FROM ${environmentLeases}
      WHERE ${environmentLeases.companyId} = ${companyId} AND ${environmentLeases.heartbeatRunId} = ${runId}
        ${recoveredStopped.length ? sql`AND ${environmentLeases.id}::text NOT IN (${sql.join(recoveredStopped.map(id => sql`${id}`), sql`, `)})` : sql``}
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
              AND ${environmentLeases.cleanupStatus} = 'success'), false))))))
    OR EXISTS (SELECT 1 FROM ${nativeRunFinalizations}
      WHERE ${nativeRunFinalizations.companyId} = ${companyId} AND ${nativeRunFinalizations.runId} = ${runId}
        AND (${nativeRunFinalizations.leaseOwner} IS NOT NULL
          OR ${nativeRunFinalizations.phase} NOT IN ('committed', 'applied', 'terminal_failure'))) AS pending`);
  return state?.pending === true;
}

/** Resolved recovery bookkeeping can still carry an effective no-replay hold. */
export function executionBlockerPredicate() {
  return and(
    not(conversationRecoveryActionPredicate()!),
    not(preDispatchExecutionWaitRecoveryActionPredicate()),
    // Holds saved before shutdown certified pre-dispatch interruptions carry
    // the same row proof; they have no unknown outcome to reconcile.
    sql`not (${issueRecoveryActions.cause} = 'legacy_execution_requires_reconciliation' and exists (
      select 1 from ${heartbeatRuns}
      where ${heartbeatRuns.companyId} = ${issueRecoveryActions.companyId}
        and ${heartbeatRuns.id} = ${canonicalExecutionUuid(sql`coalesce(${issueRecoveryActions.evidence}->>'runId', ${issueRecoveryActions.evidence}->>'sourceRunId')`)}
        and ${issueRecoveryActions.sourceIssueId} = ${canonicalExecutionUuid(sql`${heartbeatRuns.contextSnapshot}->>'issueId'`)}
        and ${legacyShutdownBeforeDispatchCondition()}
        and coalesce(${issueRecoveryActions.evidence}->>'workspaceRestoreFailure', '') <> 'restore_unsafe_archive'
        and ${issueRecoveryActions.evidence}->'workspaceRestoreRecovery' is null
    ))`,
    sql`not (${issueRecoveryActions.cause} = 'legacy_execution_requires_reconciliation' and exists (
      select 1 from ${heartbeatRuns}
      where ${heartbeatRuns.companyId} = ${issueRecoveryActions.companyId}
        and ${heartbeatRuns.id} = ${canonicalExecutionUuid(sql`coalesce(${issueRecoveryActions.evidence}->>'runId', ${issueRecoveryActions.evidence}->>'sourceRunId')`)}
        and ${issueRecoveryActions.sourceIssueId} = ${canonicalExecutionUuid(sql`${heartbeatRuns.contextSnapshot}->>'issueId'`)}
        and (${heartbeatRuns.issueId} is null or ${heartbeatRuns.issueId} = ${issueRecoveryActions.sourceIssueId})
        and ${neverStartedDispatchCancellationPredicate()}
        and ${heartbeatRuns.errorCode} <> 'issue_continuation_waiting_on_review'
        and coalesce(${issueRecoveryActions.evidence}->>'workspaceRestoreFailure', '') <> 'restore_unsafe_archive'
        and coalesce(${issueRecoveryActions.evidence}->'workspaceRestoreRecovery'->>'schema', '') <> ${LEGACY_WORKSPACE_RECOVERY_SCHEMA}
    ))`,
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

// Exact runner startup lifecycle events (event-v3 schema): they open no turn.
// Every other runner-sourced event counts as provider work, so a new, unlisted
// or turn-scoped event (for example workspace.diff.recorded or a session goal)
// keeps the hold (fail closed). Server-side records without a source event
// (spans, process identity, lifecycle) count only when they name turn or
// provider work.
export const PROVIDER_STARTUP_EVENT_TYPES = ["harness.starting", "harness.ready", "harness.diagnostic", "harness.exited",
  "session.starting", "session.started", "session.resuming", "session.resumed", "session.reconciled", "session.updated",
  "session.capabilities.updated", "session.closed", "session.failed", "workspace.ready", "runtime.phase.changed",
  "runtime.activity.recorded", "provider.notice.recorded", "auth.credentials.updated", "run.attached", "run.detached",
  "mcp_app.discovered", "mcp_app.initializing", "mcp_app.ready", "mcp_app.resource.resolved",
  "mcp_app.host_context.changed", "mcp_app.teardown", "mcp_app.failed"] as const;
const SERVER_TURN_WORK_EVENT_PREFIXES = ["turn.", "item.", "tool.", "semantic_tool.", "run.result."] as const;
const SERVER_TURN_WORK_EVENT_TYPES = ["provider.event", "provider.rpc_result"] as const;

const anyPrefix = (eventType: SQL, prefixes: readonly string[]) =>
  sql.join(prefixes.map(prefix => sql`starts_with(${eventType}, ${prefix})`), sql` or `);
const anyType = (eventType: SQL, types: readonly string[]) =>
  sql`${eventType} in (${sql.join(types.map(type => sql`${type}`), sql`, `)})`;

/** SQL truth for an event row (alias columns) that may prove provider turn work. */
export function providerTurnWorkEventCondition(eventType: SQL, sourceEventId: SQL) {
  return sql`((${sourceEventId} is not null and not ${anyType(eventType, PROVIDER_STARTUP_EVENT_TYPES)})
    or ${anyType(eventType, SERVER_TURN_WORK_EVENT_TYPES)} or ${anyPrefix(eventType, SERVER_TURN_WORK_EVENT_PREFIXES)})`;
}

/**
 * A Stop that the native startup owner fenced before it published a provider
 * handle proves that no provider turn ran. The run's own durable record must
 * agree: no turn, tool or provider event and no native result. `stopped` is
 * the SQL alias of the stopped run.
 */
export function stoppedBeforeProviderTurnCondition() {
  return sql`(stopped.status = 'cancelled' and stopped.runtime_mode = 'native'
    and stopped.result_json->'nativeCancellation'->>'schema' = 'paperclip.native-cancellation.v1'
    and stopped.result_json->'nativeCancellation'->>'runId' = stopped.id::text
    and stopped.result_json->'nativeCancellation'->>'scope' = 'run'
    and stopped.result_json->'nativeCancellation'->>'dispatchState' = 'acknowledged'
    and stopped.result_json->'nativeCancellation'->'beforeProviderTurn' = 'true'::jsonb
    and not exists (select 1 from ${heartbeatRunEvents} work
      where work.company_id = stopped.company_id and work.run_id = stopped.id
        and ${providerTurnWorkEventCondition(sql`work.event_type`, sql`work.source_event_id`)})
    and not exists (select 1 from ${nativeRunResults} result
      where result.company_id = stopped.company_id and result.run_id = stopped.id))`;
}

export function interruptedPreparationBeforeProviderWorkCondition() {
  return sql`(stopped.status = 'interrupted' and stopped.runtime_mode = 'legacy'
    and stopped.runtime_mode_resolved_at is null and stopped.execution_stage = 'preparing'
    and stopped.runner_profile_json#>>'{adapterDispatch,adapterType}' = 'paperclip_runner'
    and stopped.runner_profile_json->'nativeExecutionInput' is null
    and stopped.process_pid is null and stopped.process_group_id is null and stopped.process_started_at is null
    and stopped.session_id_after is null and stopped.native_issue_id is null and stopped.native_session_id is null
    and (stopped.controller_lease_expires_at is null or stopped.controller_lease_expires_at <= now())
    and (stopped.runner_profile_json->'remoteWorkspace' is null or exists (
      select 1 from jsonb_array_elements_text(case when jsonb_typeof(${issueRecoveryActions.evidence}#>'{systemRecovery,preservationOperationIds}') = 'array'
        then ${issueRecoveryActions.evidence}#>'{systemRecovery,preservationOperationIds}' else '[]'::jsonb end) saved(id)
      join ${workspaceOperations} op on op.id::text = saved.id
      where op.company_id = stopped.company_id and op.heartbeat_run_id = stopped.id and op.status = 'succeeded'
        and op.metadata->>'snapshotId' = stopped.runner_profile_json#>>'{remoteWorkspace,snapshotId}'))
    and coalesce(stopped.result_json#>'{executionRecovery,providerWorkStarted}', 'false'::jsonb) = 'false'::jsonb
    and case when stopped.result_json->'cancellation' is null then stopped.error_code = 'server_shutdown_interrupted'
      else stopped.result_json#>>'{cancellation,initiator,type}' = 'system'
        and coalesce(stopped.result_json#>>'{cancellation,source}', '') <> 'operator'
        and (stopped.result_json#>>'{cancellation,source}' = 'shutdown'
          or stopped.result_json#>'{cancellation,expected}' = 'false'::jsonb) end
    and not exists (select 1 from ${heartbeatRunEvents} work
      where work.company_id = stopped.company_id and work.run_id = stopped.id
        and (work.source_event_id is not null
          or work.event_type in ('adapter.invoke', ${PROCESS_START_REQUESTED}, ${PROCESS_IDENTITY_RECORDED})
          or ${providerTurnWorkEventCondition(sql`work.event_type`, sql`work.source_event_id`)}))
    and not exists (select 1 from ${nativeRunFinalizations} coordinator
      where coordinator.company_id = stopped.company_id and coordinator.run_id = stopped.id)
    and not exists (select 1 from ${nativeRunResults} result
      where result.company_id = stopped.company_id and result.run_id = stopped.id)
    and not exists (select 1 from ${environmentLeases} lease
      where lease.company_id = stopped.company_id and lease.heartbeat_run_id = stopped.id
        and not coalesce(lease.released_at is not null and lease.cleanup_status = 'success'
          and lease.status in ('released', 'expired', 'failed')
          and coalesce(lease.metadata->>'pendingCleanupInFlight', 'false') = 'false'
          and (lease.provider = 'local' or (
            lease.metadata#>>'{remoteExecutionTermination,schema}' = 'paperclip.remote-termination.v1'
            and lease.metadata#>>'{remoteExecutionTermination,companyId}' = lease.company_id::text
            and lease.metadata#>>'{remoteExecutionTermination,runId}' = stopped.id::text
            and lease.metadata#>>'{remoteExecutionTermination,leaseId}' = lease.id::text
            and lease.metadata#>>'{remoteExecutionTermination,provider}' = lease.provider
            and lease.metadata#>>'{remoteExecutionTermination,providerLeaseId}' = lease.provider_lease_id
            and lease.metadata#>>'{remoteExecutionTermination,state}' in ('stopped', 'destroyed'))), false)))`;
}

/**
 * A file-preservation hold binds a newer task owner only until automatic
 * recovery saved the stopped run's files. That owner's turn is a fresh
 * assignment, not a replay: the stopped run's unknown outcomes stay with its
 * own agent, which keeps the hold. A Stop fenced before any provider turn, or a
 * shutdown that interrupted preparation before any provider work, has no
 * unknown outcome, so its hold releases for the same agent too. The proof is
 * the durable completed-recovery receipt bound to this action, so later reuse
 * of the workspace by the current owner (new epoch, writer or snapshot) cannot
 * re-arm the hold.
 */
export function restoreHoldReleasedForCurrentOwnerPredicate() {
  const sourceRunId = sql`coalesce(${issueRecoveryActions.evidence}->>'runId', ${issueRecoveryActions.evidence}->>'sourceRunId')`;
  const operationIds = sql`case when jsonb_typeof(${issueRecoveryActions.evidence}#>'{systemRecovery,preservationOperationIds}') = 'array'
    then ${issueRecoveryActions.evidence}#>'{systemRecovery,preservationOperationIds}' else '[]'::jsonb end`;
  // JSON reads are NULL for other holds. Callers negate this predicate, so it
  // must be strictly true or false: NOT NULL would hide unrelated blockers.
  return sql`coalesce((${and(
    sql`${issueRecoveryActions.evidence}->'workspaceRestoreRecovery'->>'schema' = ${LEGACY_WORKSPACE_RECOVERY_SCHEMA}`,
    sql`coalesce(${issueRecoveryActions.evidence}->>'workspaceRestoreFailure', '') <> 'restore_unsafe_archive'`,
    sql`exists (select 1 from ${heartbeatRuns} stopped
      join ${issues} task on task.company_id = stopped.company_id and task.id = ${issueRecoveryActions.sourceIssueId}
      where stopped.company_id = ${issueRecoveryActions.companyId}
        and stopped.id::text = ${sourceRunId}
        and stopped.status in ('failed', 'timed_out', 'interrupted', 'cancelled')
        and stopped.finished_at is not null
        and task.assignee_agent_id is not null
        and ((task.assignee_agent_id <> stopped.agent_id
          and not coalesce(task.status = 'in_review'
            and task.execution_state->>'status' = 'pending'
            and task.execution_state->'currentParticipant'->>'type' = 'agent'
            and task.execution_state->'currentParticipant'->>'agentId' = stopped.agent_id::text, false))
          or ${stoppedBeforeProviderTurnCondition()} or ${interruptedPreparationBeforeProviderWorkCondition()}))`,
    completedWorkspaceRecoveryCondition(sourceRunId),
    // Copyback put the files back into the task workspace that the new owner
    // reuses. A snapshot-only save needs an explicit fresh-workspace request
    // to attach it, so that hold stays until such a request or a repair.
    sql`not exists (select 1 from jsonb_array_elements_text(${operationIds}) saved(id)
      join ${workspaceOperations} op on op.id::text = saved.id
      where op.company_id = ${issueRecoveryActions.companyId} and op.phase <> 'workspace_recovery')`,
  )}), false)`;
}

/**
 * The coordinator's own scheduled resume of one native run: the active action
 * that its failure wrote for that run and whose wake policy resumes that same
 * run. It is the authority for that resume, not a hold against it. A saved
 * governed wait whose shutdown confirmation is still pending records a
 * reconciliation cause here, and its same-run resume is what settles it.
 * Strictly true or false, because callers negate it.
 */
function ownNativeResumePredicate(runId: string) {
  return sql`coalesce((${issueRecoveryActions.status} = 'active'
    and ${issueRecoveryActions.wakePolicy}->>'kind' = 'resume_native_run'
    and ${issueRecoveryActions.wakePolicy}->>'runId' = ${runId}
    and ${issueRecoveryActions.evidence}->>'runId' = ${runId}), false)`;
}

export async function getExecutionBlocker(db: Db, companyId: string, issueId: string, options?: {
  conversationResetCommentId?: string | null;
  /** The native run being dispatched; its own scheduled resume does not block it. */
  resumingNativeRunId?: string | null;
}): Promise<ExecutionBlocker | null> {
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
    not(restoreHoldReleasedForCurrentOwnerPredicate()),
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
    not(restoreHoldReleasedForCurrentOwnerPredicate()),
    boundary ? or(gt(issueRecoveryActions.createdAt, boundary.createdAt), nativeExecutionRecoveryActionPredicate()) : undefined,
    options?.resumingNativeRunId ? not(ownNativeResumePredicate(options.resumingNativeRunId)) : undefined,
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
    sql`not exists (select 1 from (
      select consumed.context_snapshot->>'wakeCommentId' as comment_id,
        consumed.context_snapshot->'wakeCommentIds' as comment_ids
      from ${heartbeatRuns} consumed where consumed.company_id = ${companyId}
        and consumed.context_snapshot->>'issueId' = ${issueId}
        and not (consumed.status = 'cancelled' and consumed.started_at is null)
      offset 0
    ) consumed where consumed.comment_id = ${issueComments.id}::text
      or consumed.comment_ids @> jsonb_build_array(${issueComments.id}::text))`,
  )) : [];
  const cancellation = run ? readRunCancellation(run.resultJson) : null;
  const eligibleContinuation = Boolean(!restoreHold && run && conversation?.assigneeAgentId === run.agentId &&
    !["done", "cancelled"].includes(conversation.status) && canContinueCancelledRun(run));
  // A failed run whose saved work is verifiably recovered no longer needs the
  // hold to protect its files. Offer the same Retry that admission accepts, so
  // an infrastructure failure (such as a restart) is not left to a new message.
  // An intentional Stop keeps "send a new message" as its only continuation.
  const recoveredFailure = Boolean(restoreHold && run?.status === "failed" && !workspaceRepairRequired &&
    workspaceRecovery?.status === "recovered");
  const canRetry = Boolean((!restoreHold || recoveredFailure) && run && conversation?.assigneeAgentId === run.agentId &&
    !["done", "cancelled"].includes(conversation.status) && await canRetryStoppedRun(db, run));
  const runError = run && canRetry && isPreDispatchReviewWait(run)
    ? "Waiting for review; this continuation never started."
    // Earlier releases saved operator-facing text for the cleanup gate. Show
    // the plain wording from the code instead of the stored message.
    : run?.errorCode === NATIVE_SESSION_CLEANUP_QUARANTINED ? NATIVE_CLEANUP_SETTLING_MESSAGE
    : cancellation?.reason ?? (run?.status === "cancelled"
      ? "Execution was cancelled; its source was not recorded."
      // Rows written before SQL text was kept out of run errors still carry it.
      : run?.error ? withoutSqlStatementText(run.error, readRunFailureCause(run.resultJson)) : run?.error);
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
  // Retry is a person's control on this task. Say so, so an agent reading this
  // record points the person to it instead of re-running the work itself.
  if (canRetry && !eligibleContinuation) nextAction += ` ${EXECUTION_BLOCKER_PERSON_RETRY_ACTION}`;
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
    nextAction: (workspaceRecovery?.status === "recovered" && canRetry && !chatBinding
      ? "Saved work recovered. Retry or send a message to continue." : workspaceRecovery?.message) ?? (reconstructionPending ? "Continuation from saved sources is queued and waiting for execution checks." : nextAction),
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
