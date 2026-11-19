import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations } from "@paperclipai/db";
import { PROCESS_IDENTITY_RECORDED, PROCESS_START_REQUESTED } from "./native-local-process-stop.js";
import { LEGACY_WORKSPACE_RECOVERY_SCHEMA } from "./workspace-restore-recovery-state.js";
import { readRunCancellation } from "./run-cancellation.js";

export function isPreDispatchResourceWait(run: Pick<typeof heartbeatRuns.$inferSelect,
  "runtimeMode" | "status" | "errorCode" | "resultJson">): boolean {
  const evidence = run.resultJson?.executionRecovery as Record<string, unknown> | undefined;
  return run.runtimeMode === "legacy" && run.status === "cancelled" && evidence?.providerWorkStarted === false &&
    (run.errorCode === "workspace_busy" && evidence.kind === "workspace_wait" ||
      run.errorCode === "agent_directory_busy" && evidence.kind === "agent_directory_wait" ||
      ["ai_connection_busy", "ai_connection_pool_exhausted", "provider_limit_wait"].includes(run.errorCode ?? "") &&
      evidence.kind === "ai_connection_wait");
}

export function isAgentDirectoryPreparationWait(run: Pick<typeof heartbeatRuns.$inferSelect,
  "runtimeMode" | "status" | "errorCode" | "resultJson">): boolean {
  const evidence = run.resultJson?.executionRecovery as Record<string, unknown> | undefined;
  const cancellation = run.resultJson?.cancellation as Record<string, unknown> | undefined;
  return run.runtimeMode === "legacy" && run.status === "cancelled" && run.errorCode === "agent_directory_busy"
    && evidence?.kind === "agent_directory_wait" && evidence.providerWorkStarted === false
    && cancellation?.source === "control_plane" && cancellation.expected === true;
}

export function agentDirectoryPreparationWaitPredicate() {
  return sql`(${heartbeatRuns.runtimeMode} = 'legacy' and ${heartbeatRuns.status} = 'cancelled'
    and ${heartbeatRuns.errorCode} = 'agent_directory_busy'
    and ${heartbeatRuns.resultJson}#>>'{executionRecovery,kind}' = 'agent_directory_wait'
    and ${heartbeatRuns.resultJson}#>'{executionRecovery,providerWorkStarted}' = 'false'::jsonb
    and ${heartbeatRuns.resultJson}#>>'{cancellation,source}' = 'control_plane'
    and ${heartbeatRuns.resultJson}#>'{cancellation,expected}' = 'true'::jsonb)`;
}

/** The control plane cancels a run that is still waiting, for example a
 * scheduled retry superseded by a task change. This row check only selects a
 * candidate; `unclaimedControlPlaneCancellationPredicate` is the proof. */
export function isUnclaimedControlPlaneCancellationCandidate(run: Pick<typeof heartbeatRuns.$inferSelect,
  "runtimeMode" | "status" | "errorCode" | "resultJson">): boolean {
  const cancellation = readRunCancellation(run.resultJson);
  return run.runtimeMode === "legacy" && run.status === "cancelled" && run.errorCode === "cancelled" &&
    cancellation?.source === "control_plane" && cancellation.expected && cancellation.initiator.type === "system";
}

/** A retry continues its chain, so its own missing execution evidence is not
 * enough: the run it retries must be settled too. The scheduler only retries a
 * run that needs no reconciliation; this records the two outcomes it can prove
 * from the row: the predecessor succeeded, or its setup failed before provider
 * work. Resource-wait chains keep their own proof (cancelled-native-startup). */
export function settledRetryPredecessorPredicate() {
  return sql`(${heartbeatRuns.retryOfRunId} is null or exists (select 1 from heartbeat_runs predecessor
    where predecessor.company_id = ${heartbeatRuns.companyId} and predecessor.id = ${heartbeatRuns.retryOfRunId}
      and predecessor.agent_id = ${heartbeatRuns.agentId} and predecessor.finished_at is not null
      and (predecessor.status = 'succeeded' or (predecessor.status in ('failed', 'cancelled', 'interrupted', 'timed_out')
        and predecessor.result_json #>> '{executionRecovery,kind}' = 'bootstrap'
        and predecessor.result_json #> '{executionRecovery,providerWorkStarted}' = 'false'::jsonb
        and coalesce(predecessor.result_json->>'workspaceRestoreFailure', '') = ''
        and predecessor.result_json->'workspaceRestoreRecovery' is null))))`;
}

/** SQL proof for `isUnclaimedControlPlaneCancellationCandidate`. Callers add
 * `noRetainedExecutionPredicate` for the run's own execution evidence. */
export function unclaimedControlPlaneCancellationPredicate() {
  return sql`(${heartbeatRuns.errorCode} = 'cancelled'
    and ${heartbeatRuns.resultJson}#>>'{cancellation,source}' = 'control_plane'
    and ${heartbeatRuns.resultJson}#>'{cancellation,expected}' = 'true'::jsonb
    and ${heartbeatRuns.resultJson}#>>'{cancellation,initiator,type}' = 'system'
    and ${settledRetryPredecessorPredicate()})`;
}

export function executionStartedEventPredicate() {
  return or(isNotNull(heartbeatRunEvents.sourceEventId), inArray(heartbeatRunEvents.eventType,
    ["adapter.invoke", PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED, "harness.ready", "session.started",
      "session.resumed", "session.updated", "turn.started", "provider.event", "provider.rpc_result", "tool.execution.started"]));
}

/** Both dispatch cancellation policies require this same retained-evidence
 * proof. Each caller still owns its terminal status and admission receipt. */
export function noRetainedExecutionPredicate() {
  return and(
    isNull(heartbeatRuns.startedAt), isNull(heartbeatRuns.runtimeModeResolvedAt),
    isNull(heartbeatRuns.processPid), isNull(heartbeatRuns.processGroupId), isNull(heartbeatRuns.processStartedAt),
    isNull(heartbeatRuns.nativeIssueId), isNull(heartbeatRuns.nativeSessionId), isNull(heartbeatRuns.sessionIdAfter),
    isNull(heartbeatRuns.controllerBootId), isNull(heartbeatRuns.controllerLeaseExpiresAt), isNull(heartbeatRuns.executionStage),
    sql`coalesce(${heartbeatRuns.resultJson}->>'workspaceRestoreFailure', '') <> 'restore_unsafe_archive'`,
    sql`coalesce(${heartbeatRuns.resultJson}->'workspaceRestoreRecovery'->>'schema', '') <> ${LEGACY_WORKSPACE_RECOVERY_SCHEMA}`,
    sql`not (coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb) ?| array[
      'nativeExecutionInput', 'nativeWorkspaceSync', 'remoteWorkspace', 'nativeWorkspaceFinalizationOwner', 'sessionCheckpoint'])`,
    sql`not exists (select 1 from ${nativeRunFinalizations}
      where ${nativeRunFinalizations.companyId} = ${heartbeatRuns.companyId} and ${nativeRunFinalizations.runId} = ${heartbeatRuns.id})`,
    sql`not exists (select 1 from ${environmentLeases}
      where ${environmentLeases.companyId} = ${heartbeatRuns.companyId} and ${environmentLeases.heartbeatRunId} = ${heartbeatRuns.id})`,
    sql`not exists (select 1 from ${heartbeatRunEvents}
      where ${and(eq(heartbeatRunEvents.companyId, heartbeatRuns.companyId),
        eq(heartbeatRunEvents.runId, heartbeatRuns.id), executionStartedEventPredicate())})`,
  );
}
