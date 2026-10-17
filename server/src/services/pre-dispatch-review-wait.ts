import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { QUEUED_RUN_STALENESS_ERROR_CODES } from "../modules/run-dispatch/index.js";
import { PROCESS_IDENTITY_RECORDED, PROCESS_START_REQUESTED } from "./native-local-process-stop.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";

type Run = typeof heartbeatRuns.$inferSelect;
type DispatchFields = "startedAt" | "runtimeModeResolvedAt" | "processPid" | "processGroupId" |
  "processStartedAt" | "nativeIssueId" | "nativeSessionId" | "sessionIdAfter" |
  "controllerBootId" | "controllerLeaseExpiresAt" | "executionStage" | "contextSnapshot";

/** Every queued-run staleness code is a pre-dispatch cancel except
 * `execution_reconciliation_required`, which reports an existing hold rather
 * than a run that merely lost its target, and `issue_waiting_for_response`,
 * which also needs its connection-intent snapshot (see below). Derived from
 * the staleness code list, so a new code is accepted unless it is excluded
 * here. Read at call time: the run-dispatch index can be mid-evaluation when
 * this module loads through an import cycle. */
function isPreDispatchCancelCode(code: string): boolean {
  return code !== "execution_reconciliation_required" && code !== "issue_waiting_for_response" &&
    (QUEUED_RUN_STALENESS_ERROR_CODES as readonly string[]).includes(code);
}

/** The dispatcher gate and the claim-time dependency gate both cancel a queued
 * run before any execution authority is claimed; each stamps its own source. */
function hasPreDispatchCancelSource(run: Pick<Run, "errorCode" | "resultJson">): boolean {
  const source = run.resultJson?.timeoutSource;
  return source === "stale_queued_run_gate" ||
    (source === "dependency_gate" && run.errorCode === "issue_dependencies_blocked");
}

/** A connection response wait is a pre-dispatch cancel only with the resolved
 * connection-intent snapshot; the error code alone does not qualify. */
function isConnectionResponseWait(run: Partial<Pick<Run, "errorCode" | "contextSnapshot">>): boolean {
  return run.errorCode === "issue_waiting_for_response" &&
    run.contextSnapshot?.connectionIntentResolution === "existing_connection" &&
    run.contextSnapshot?.source === "connection_intent.resolved" &&
    run.contextSnapshot?.interactionKind === "connection_intent" &&
    run.contextSnapshot?.interactionStatus === "expired" &&
    run.contextSnapshot?.mutation === "interaction" &&
    typeof run.contextSnapshot?.interactionId === "string";
}

/** The queued-run gate owns this receipt before execution authority is claimed.
 * A run it cancelled has no provider actions to reconcile. The error code alone
 * is not proof; missing or conflicting dispatch evidence retains the hold. */
export function isPreDispatchCancel(
  run: Pick<Run, "runtimeMode" | "status" | "errorCode" | "resultJson"> & Partial<Pick<Run, DispatchFields>>,
): boolean {
  const finalResponseWait = run.errorCode === "issue_waiting_for_response" &&
    (run.resultJson?.preDispatchResponseWait as { version?: number; providerWorkStarted?: boolean } | undefined)?.version === 1 &&
    (run.resultJson?.preDispatchResponseWait as { providerWorkStarted?: boolean } | undefined)?.providerWorkStarted === false;
  return run.runtimeMode === "legacy" && run.status === "cancelled" &&
    (isConnectionResponseWait(run) || (run.errorCode != null && isPreDispatchCancelCode(run.errorCode))) &&
    run.resultJson?.stopReason === run.errorCode &&
    hasPreDispatchCancelSource(run) &&
    run.resultJson?.workspaceRestoreFailure !== "restore_unsafe_archive" &&
    (finalResponseWait || (run.startedAt === null && run.runtimeModeResolvedAt === null)) &&
    run.processPid === null && run.processGroupId === null && run.processStartedAt === null &&
    run.nativeIssueId === null && run.nativeSessionId === null && run.sessionIdAfter === null &&
    (finalResponseWait || (run.controllerBootId === null && run.controllerLeaseExpiresAt === null && run.executionStage === null));
}

/** A deliberate review or connection response wait is the pre-dispatch cancel
 * that also changes operator-facing copy and native startup admission. */
export function isPreDispatchReviewWait(
  run: Pick<Run, "runtimeMode" | "status" | "errorCode" | "resultJson"> & Partial<Pick<Run, DispatchFields>>,
): boolean {
  return (run.errorCode === "issue_continuation_waiting_on_review" || run.errorCode === "issue_waiting_for_response") &&
    isPreDispatchCancel(run);
}

/** The row receipt is a candidate, not permission to discard conflicting
 * retained execution or cleanup evidence. Historical false holds must be
 * checked against the same evidence that gates explicit user admission. */
export async function isPreDispatchCancelVerified(db: Db, run: Run): Promise<boolean> {
  if (!isPreDispatchCancel(run)) return false;
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
    or(isNotNull(heartbeatRunEvents.sourceEventId),
      inArray(heartbeatRunEvents.eventType, ["adapter.invoke", PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED,
        "harness.ready", "session.started", "session.resumed", "session.updated", "turn.started",
        "provider.event", "provider.rpc_result", "tool.execution.started"])),
  )).limit(1);
  return !execution;
}
