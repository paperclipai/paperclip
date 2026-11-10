import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { executionStartedEventPredicate } from "./pre-dispatch-execution-evidence.js";

type Run = typeof heartbeatRuns.$inferSelect;

export const SERVER_SHUTDOWN_INTERRUPTED_CODE = "server_shutdown_interrupted";

/**
 * A graceful shutdown stopped a legacy run while it was still preparing.
 *
 * The proof is every clause together; none is redundant:
 * - `budgetDispatch.handedOffAt`: the dispatch gate
 *   (`dispatchResolvedInteractionIfCurrent`) writes it under the run lock
 *   before it calls the adapter. It is the dispatch linearization point.
 * - `executionStage`: every legacy dispatch first renews its controller lease
 *   with stage `dispatching` (`authorizeFailedChatRetryExecution("dispatching")`
 *   in `dispatchResolvedInteractionContinuationAfterAdmission`).
 * - No process identity and no execution-start event (`adapter.invoke`,
 *   process start/identity, session or provider events).
 * The gate and the renewal both require `status = 'running'`, so once the
 * shutdown commits the interruption these records can no longer change.
 *
 * Rows from a controller without a lease (no boot ID) or with any native,
 * remote-workspace or file-recovery obligation stay with their own recovery.
 */
export function legacyShutdownBeforeDispatchCondition() {
  return and(
    eq(heartbeatRuns.runtimeMode, "legacy"),
    eq(heartbeatRuns.status, "interrupted"),
    eq(heartbeatRuns.errorCode, SERVER_SHUTDOWN_INTERRUPTED_CODE),
    isNotNull(heartbeatRuns.finishedAt),
    isNotNull(heartbeatRuns.controllerBootId),
    eq(heartbeatRuns.executionStage, "preparing"),
    isNull(heartbeatRuns.processPid), isNull(heartbeatRuns.processGroupId), isNull(heartbeatRuns.processStartedAt),
    isNull(heartbeatRuns.nativeIssueId), isNull(heartbeatRuns.nativeSessionId), isNull(heartbeatRuns.sessionIdAfter),
    sql`${heartbeatRuns.usageJson}#>'{budgetDispatch,handedOffAt}' is null`,
    sql`coalesce(${heartbeatRuns.resultJson}#>'{executionRecovery,providerWorkStarted}', 'false'::jsonb) = 'false'::jsonb`,
    sql`${heartbeatRuns.resultJson}->'workspaceRestoreFailure' is null`,
    sql`${heartbeatRuns.resultJson}->'workspaceRestoreRecovery' is null`,
    sql`not (coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb) ?| array[
      'nativeExecutionInput', 'nativeWorkspaceSync', 'remoteWorkspace', 'nativeWorkspaceFinalizationOwner', 'sessionCheckpoint'])`,
    sql`coalesce(${heartbeatRuns.runnerProfileJson}#>>'{adapterDispatch,adapterType}', '') <> 'paperclip_runner'`,
    sql`not exists (select 1 from ${nativeRunFinalizations}
      where ${nativeRunFinalizations.companyId} = ${heartbeatRuns.companyId} and ${nativeRunFinalizations.runId} = ${heartbeatRuns.id})`,
    sql`not exists (select 1 from ${heartbeatRunEvents}
      where ${and(eq(heartbeatRunEvents.companyId, heartbeatRuns.companyId),
        eq(heartbeatRunEvents.runId, heartbeatRuns.id), executionStartedEventPredicate())})`,
  )!;
}

/**
 * Record the bootstrap certificate on a run the shutdown just interrupted
 * before dispatch. Call it in the transaction that committed the interruption,
 * so the row lock fences a concurrent stage or handoff write. Returns the
 * stamped row, or null when the run does not carry that proof.
 */
export async function recordLegacyShutdownBeforeDispatch(tx: Db, run: Pick<Run, "id" | "companyId">): Promise<Run | null> {
  const [stamped] = await tx.update(heartbeatRuns).set({
    resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb)
      || jsonb_build_object('executionRecovery', jsonb_build_object('kind', 'bootstrap', 'providerWorkStarted', false))`,
    executionStatusDeliveryId: randomUUID(),
    updatedAt: new Date(),
  }).where(and(
    eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
    sql`${heartbeatRuns.resultJson}->'executionRecovery' is null`,
    legacyShutdownBeforeDispatchCondition(),
  )).returning();
  return stamped ?? null;
}
