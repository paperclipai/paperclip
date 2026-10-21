import { and, eq, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, issueRecoveryActions, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { canonicalExecutionUuid } from "./execution-identity.js";
import { PROCESS_IDENTITY_RECORDED, PROCESS_START_REQUESTED } from "./native-local-process-stop.js";
import { LEGACY_WORKSPACE_RECOVERY_SCHEMA } from "./workspace-restore-recovery-state.js";

/** Admission denied by an existing hold is not a provider attempt. Require the
 * dispatcher's receipt and absence of execution authority, resources and events. */
function preDispatchExecutionWaitPredicate() {
  return sql`coalesce(
    ${heartbeatRuns.runtimeMode} = 'legacy' AND ${heartbeatRuns.status} = 'cancelled'
    AND ${heartbeatRuns.finishedAt} IS NOT NULL
    AND ${heartbeatRuns.errorCode} = 'execution_reconciliation_required'
    AND ${heartbeatRuns.resultJson}->>'stopReason' = 'execution_reconciliation_required'
    AND ${heartbeatRuns.resultJson}->>'timeoutSource' = 'stale_queued_run_gate'
    AND ${canonicalExecutionUuid(sql`${heartbeatRuns.resultJson}->'executionWait'->>'issueId'`)}
      = ${canonicalExecutionUuid(sql`${heartbeatRuns.contextSnapshot}->>'issueId'`)}
    AND (${heartbeatRuns.issueId} IS NULL OR ${heartbeatRuns.issueId}
      = ${canonicalExecutionUuid(sql`${heartbeatRuns.contextSnapshot}->>'issueId'`)})
    AND ${canonicalExecutionUuid(sql`${heartbeatRuns.resultJson}->'executionWait'->>'recoveryActionId'`)} IS NOT NULL
    AND ${heartbeatRuns.startedAt} IS NULL AND ${heartbeatRuns.runtimeModeResolvedAt} IS NULL
    AND ${heartbeatRuns.processPid} IS NULL AND ${heartbeatRuns.processGroupId} IS NULL
    AND ${heartbeatRuns.processStartedAt} IS NULL AND ${heartbeatRuns.nativeIssueId} IS NULL
    AND ${heartbeatRuns.nativeSessionId} IS NULL AND ${heartbeatRuns.sessionIdAfter} IS NULL
    AND ${heartbeatRuns.controllerBootId} IS NULL AND ${heartbeatRuns.controllerLeaseExpiresAt} IS NULL
    AND ${heartbeatRuns.executionStage} IS NULL
    AND coalesce(${heartbeatRuns.resultJson}->>'workspaceRestoreFailure', '') <> 'restore_unsafe_archive'
    AND coalesce(${heartbeatRuns.resultJson}->'workspaceRestoreRecovery'->>'schema', '') <> ${LEGACY_WORKSPACE_RECOVERY_SCHEMA}
    AND NOT EXISTS (SELECT 1 FROM ${environmentLeases}
      WHERE ${environmentLeases.companyId} = ${heartbeatRuns.companyId}
        AND ${environmentLeases.heartbeatRunId} = ${heartbeatRuns.id})
    AND NOT EXISTS (SELECT 1 FROM ${nativeRunFinalizations}
      WHERE ${nativeRunFinalizations.companyId} = ${heartbeatRuns.companyId}
        AND ${nativeRunFinalizations.runId} = ${heartbeatRuns.id})
    AND NOT EXISTS (SELECT 1 FROM ${heartbeatRunEvents}
      WHERE ${heartbeatRunEvents.companyId} = ${heartbeatRuns.companyId}
        AND ${heartbeatRunEvents.runId} = ${heartbeatRuns.id}
        AND (${heartbeatRunEvents.sourceEventId} IS NOT NULL OR ${heartbeatRunEvents.eventType} IN
          ('adapter.invoke', ${PROCESS_START_REQUESTED}, ${PROCESS_IDENTITY_RECORDED}, 'harness.ready',
           'session.started', 'session.resumed', 'session.updated', 'turn.started',
           'provider.event', 'provider.rpc_result', 'tool.execution.started'))), false)`;
}

export async function isPreDispatchExecutionWaitVerified(db: Db, run: typeof heartbeatRuns.$inferSelect): Promise<boolean> {
  if (run.errorCode !== "execution_reconciliation_required" || run.runtimeMode !== "legacy") return false;
  const [verified] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id), preDispatchExecutionWaitPredicate(),
  )).limit(1);
  return Boolean(verified);
}

/** Re-evaluate old false incidents with the same proof; retain their audit rows
 * and leave the original execution/workspace hold to its own recovery policy. */
export function preDispatchExecutionWaitRecoveryActionPredicate() {
  return sql`(${issueRecoveryActions.cause} = 'legacy_execution_requires_reconciliation'
    AND coalesce(${issueRecoveryActions.evidence}->>'workspaceRestoreFailure', '') <> 'restore_unsafe_archive'
    AND coalesce(${issueRecoveryActions.evidence}->'workspaceRestoreRecovery'->>'schema', '') <> ${LEGACY_WORKSPACE_RECOVERY_SCHEMA}
    AND EXISTS (SELECT 1 FROM ${heartbeatRuns}
      WHERE ${heartbeatRuns.companyId} = ${issueRecoveryActions.companyId}
        AND ${heartbeatRuns.id} = ${canonicalExecutionUuid(sql`coalesce(${issueRecoveryActions.evidence}->>'runId', ${issueRecoveryActions.evidence}->>'sourceRunId')`)}
        AND ${issueRecoveryActions.sourceIssueId} = ${canonicalExecutionUuid(sql`${heartbeatRuns.contextSnapshot}->>'issueId'`)}
        AND ${preDispatchExecutionWaitPredicate()}))`;
}
