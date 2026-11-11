import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { PROCESS_IDENTITY_RECORDED, PROCESS_START_REQUESTED } from "./native-local-process-stop.js";
import { LEGACY_WORKSPACE_RECOVERY_SCHEMA } from "./workspace-restore-recovery-state.js";

export function isPreDispatchResourceWait(run: Pick<typeof heartbeatRuns.$inferSelect,
  "runtimeMode" | "status" | "errorCode" | "resultJson">): boolean {
  const evidence = run.resultJson?.executionRecovery as Record<string, unknown> | undefined;
  return run.runtimeMode === "legacy" && run.status === "cancelled" && evidence?.providerWorkStarted === false &&
    (run.errorCode === "workspace_busy" && evidence.kind === "workspace_wait" ||
      ["ai_connection_busy", "ai_connection_pool_exhausted", "provider_limit_wait"].includes(run.errorCode ?? "") &&
      evidence.kind === "ai_connection_wait");
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

/**
 * A legacy run that the startup fence cancelled after its claim but before
 * adapter dispatch. The cancellation recorded `startupCancellation` under the
 * run lock, and the run has no trace of execution: no process identity, no
 * environment lease (every dispatch acquires one first), no native state, and
 * no execution event (adapters record `adapter.invoke` before they spawn).
 * Such a run has nothing to stop, although no process acknowledged a Stop.
 */
export async function isLegacyRunCancelledBeforeDispatch(db: Db, run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId">) {
  const [row] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
    eq(heartbeatRuns.status, "cancelled"), eq(heartbeatRuns.runtimeMode, "legacy"),
    isNotNull(heartbeatRuns.finishedAt), inArray(heartbeatRuns.executionStage, ["preparing", "settled"]),
    sql`jsonb_typeof(${heartbeatRuns.resultJson}->'startupCancellation'->'requestedAt') = 'string'`,
    sql`coalesce(${heartbeatRuns.resultJson}->'executionCancellation'->>'state', '') <> 'requested'`,
    isNull(heartbeatRuns.runtimeModeResolvedAt),
    isNull(heartbeatRuns.processPid), isNull(heartbeatRuns.processGroupId), isNull(heartbeatRuns.processStartedAt),
    isNull(heartbeatRuns.nativeIssueId), isNull(heartbeatRuns.nativeSessionId), isNull(heartbeatRuns.sessionIdAfter),
    or(isNull(heartbeatRuns.controllerLeaseExpiresAt), sql`${heartbeatRuns.controllerLeaseExpiresAt} <= now()`),
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
  )).limit(1);
  return Boolean(row);
}
