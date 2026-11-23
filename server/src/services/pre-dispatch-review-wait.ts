import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { hasRequiredWorkspaceRecovery } from "./workspace-restore-recovery-state.js";
import { executionStartedEventPredicate, noRetainedExecutionPredicate } from "./pre-dispatch-execution-evidence.js";
import type { QueuedRunStalenessErrorCode } from "../modules/run-dispatch/index.js";

type Run = typeof heartbeatRuns.$inferSelect;
type DispatchFields = "startedAt" | "runtimeModeResolvedAt" | "processPid" | "processGroupId" |
  "processStartedAt" | "nativeIssueId" | "nativeSessionId" | "sessionIdAfter" |
  "controllerBootId" | "controllerLeaseExpiresAt" | "executionStage" | "contextSnapshot";

const staleDispatchReconciliationExemptions = {
  issue_not_found: true,
  issue_not_in_progress: true,
  issue_assignee_changed: true,
  issue_waiting_for_response: true,
  issue_continuation_waiting_on_review: true,
  issue_dependencies_blocked: true,
  issue_blocked: true,
  issue_execution_lock_changed: true,
  issue_terminal_status: true,
  issue_review_participant_changed: true,
  issue_in_backlog: true,
  // This code requires its own executionWait receipt in pre-dispatch-execution-wait.ts.
  execution_reconciliation_required: false,
} satisfies Record<QueuedRunStalenessErrorCode, boolean>;
const staleDispatchErrorCodes = Object.entries(staleDispatchReconciliationExemptions)
  .filter(([, exempt]) => exempt).map(([errorCode]) => errorCode);

/** A dispatch cancellation is not an interrupted provider attempt. Historical
 * rows need no new receipt, but every retained execution reference must agree. */
export function neverStartedDispatchCancellationPredicate() {
  return and(
    eq(heartbeatRuns.runtimeMode, "legacy"), eq(heartbeatRuns.status, "cancelled"),
    inArray(heartbeatRuns.errorCode, staleDispatchErrorCodes),
    isNotNull(heartbeatRuns.finishedAt),
    noRetainedExecutionPredicate(),
  );
}

/** The queued-run gate owns this receipt before execution authority is claimed.
 * A deliberate review or connection response wait has no provider actions to reconcile. The error code
 * alone is not proof; missing or conflicting dispatch evidence retains the hold. */
export function isPreDispatchReviewWait(
  run: Pick<Run, "runtimeMode" | "status" | "errorCode" | "resultJson"> & Partial<Pick<Run, DispatchFields>>,
): boolean {
  const finalResponseWait = run.errorCode === "issue_waiting_for_response" &&
    (run.resultJson?.preDispatchResponseWait as { version?: number; providerWorkStarted?: boolean } | undefined)?.version === 1 &&
    (run.resultJson?.preDispatchResponseWait as { providerWorkStarted?: boolean } | undefined)?.providerWorkStarted === false;
  return run.runtimeMode === "legacy" && run.status === "cancelled" &&
    (run.errorCode === "issue_continuation_waiting_on_review" ||
      (run.errorCode === "issue_waiting_for_response" &&
        run.contextSnapshot?.connectionIntentResolution === "existing_connection" &&
        run.contextSnapshot?.source === "connection_intent.resolved" &&
        run.contextSnapshot?.interactionKind === "connection_intent" &&
        run.contextSnapshot?.interactionStatus === "expired" &&
        run.contextSnapshot?.mutation === "interaction" &&
        typeof run.contextSnapshot?.interactionId === "string")) &&
    run.resultJson?.stopReason === run.errorCode &&
    run.resultJson?.timeoutSource === "stale_queued_run_gate" &&
    run.resultJson?.workspaceRestoreFailure !== "restore_unsafe_archive" &&
    (finalResponseWait || (run.startedAt === null && run.runtimeModeResolvedAt === null)) &&
    run.processPid === null && run.processGroupId === null && run.processStartedAt === null &&
    run.nativeIssueId === null && run.nativeSessionId === null && run.sessionIdAfter === null &&
    (finalResponseWait || (run.controllerBootId === null && run.controllerLeaseExpiresAt === null && run.executionStage === null));
}

/** The row receipt is a candidate, not permission to discard conflicting
 * retained execution or cleanup evidence. Historical false holds must be
 * checked against the same evidence that gates explicit user admission. */
export async function isPreDispatchReviewWaitVerified(db: Db, run: Run): Promise<boolean> {
  if (run.runtimeMode === "legacy" && run.status === "cancelled" && run.finishedAt !== null &&
      staleDispatchErrorCodes.some(errorCode => errorCode === run.errorCode) &&
      [run.startedAt, run.runtimeModeResolvedAt, run.processPid, run.processGroupId, run.processStartedAt,
        run.nativeIssueId, run.nativeSessionId, run.sessionIdAfter, run.controllerBootId,
        run.controllerLeaseExpiresAt, run.executionStage].every(value => value === null) &&
      run.resultJson?.workspaceRestoreFailure !== "restore_unsafe_archive" && !hasRequiredWorkspaceRecovery(run.resultJson)) {
    const [unstarted] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id), neverStartedDispatchCancellationPredicate(),
    )).limit(1);
    if (unstarted) return true;
  }
  if (!isPreDispatchReviewWait(run)) return false;
  const [coordinator] = await db.select({ id: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, run.companyId), eq(nativeRunFinalizations.runId, run.id),
  )).limit(1);
  if (coordinator) return false;
  const leases = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
  ));
  if (leases.some(lease => lease.provider === "local"
    ? !lease.releasedAt || lease.status === "pending_cleanup" || lease.cleanupStatus === "failed"
    : !hasRemoteTerminationReceipt(lease))) return false;
  const [execution] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    executionStartedEventPredicate(),
  )).limit(1);
  return !execution;
}
