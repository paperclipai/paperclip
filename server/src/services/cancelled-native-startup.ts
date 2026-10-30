import { isPreDispatchReviewWait } from "./pre-dispatch-review-wait.js";
import { and, eq } from "drizzle-orm";
import { heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { claimedAdapterType } from "./conversation-continuation.js";
import { hasProviderDispatchEvidence, leaseRetainsResources, readRunEnvironmentLeases } from "./run-dispatch-evidence.js";
import { canContinueCancelledRun } from "./run-cancellation.js";
import { legacyControllerBootId } from "./legacy-controller-lease.js";

type Run = Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "status" | "startedAt" | "finishedAt" | "runtimeMode" |
  "runtimeModeResolvedAt" | "errorCode" | "error" | "resultJson" | "runnerProfileJson" |
  "contextSnapshot" | "processPid" | "processGroupId" | "processStartedAt" |
  "sessionIdAfter" | "nativeIssueId" | "nativeSessionId" | "executionStage" |
  "controllerBootId" | "controllerLeaseExpiresAt">;
type Coordinator = typeof nativeRunFinalizations.$inferSelect;

/** Candidate for explicit user Retry only, never automatic replay after Stop. */
export async function canRetryStoppedRun(db: Db, run: Run): Promise<boolean> {
  if (run.errorCode === "native_session_cleanup_quarantined") return false;
  if (["failed", "timed_out"].includes(run.status) || canContinueCancelledRun(run)) return true;
  if (run.status !== "cancelled" || !run.finishedAt || run.processPid || run.processGroupId ||
      run.processStartedAt || run.sessionIdAfter) return false;
  const [coordinator] = await db.select().from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, run.companyId), eq(nativeRunFinalizations.runId, run.id),
  ));
  return isCancelledNativeStartup(db, run, coordinator);
}

/** Caller holds the coordinator and run locks when using this proof to admit
 * work. Attempt zero is a durable never-claimed receipt: every native executor
 * commits its first claim before it can start or attach a provider. */
export async function isCancelledNativeStartup(db: Db, run: Run, coordinator: Coordinator | undefined) {
  if (run.status !== "cancelled" || !run.finishedAt || run.processPid || run.processGroupId ||
      run.processStartedAt || run.sessionIdAfter) return false;
  const cancellation = run.resultJson?.startupCancellation as Record<string, unknown> | undefined;
  // Older builds could omit the cancellation fence or its unwind marker. Their immutable
  // native-adapter claim and unresolved preparation stage still prove that
  // provider dispatch did not begin. Require an expired owner from another
  // server boot; neither a missing PID nor mutable agent settings is proof.
  const historicalBeforeSelection = run.runtimeMode === "legacy" && !run.runtimeModeResolvedAt &&
    run.executionStage === "preparing" && !run.nativeIssueId && !run.nativeSessionId && !coordinator &&
    claimedAdapterType(run) === "paperclip_runner" && run.errorCode === "operator_interrupted" &&
    (run.resultJson === null || cancellation?.beforeNativeSelection === true) &&
    Boolean(run.controllerBootId && run.controllerBootId !== legacyControllerBootId &&
      run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt <= new Date());
  const beforeReviewDispatch = isPreDispatchReviewWait(run) && !coordinator;
  const beforeSelection = beforeReviewDispatch || historicalBeforeSelection || run.runtimeMode === "legacy" && !run.runtimeModeResolvedAt &&
    !run.nativeSessionId && !coordinator && claimedAdapterType(run) === "paperclip_runner" &&
    cancellation?.beforeNativeSelection === true;
  const neverClaimed = run.runtimeMode === "native" && coordinator &&
    ["observed", "terminal_failure"].includes(coordinator.phase) && coordinator.attempt === 0 &&
    coordinator.controllerGeneration === 0 && !coordinator.controllerBootId &&
    !coordinator.controllerPid && !coordinator.leaseOwner && !coordinator.leaseExpiresAt &&
    !coordinator.resultId && !coordinator.failureDetail?.successorRunId;
  if (!beforeSelection && !neverClaimed) return false;
  const settled = beforeReviewDispatch || typeof run.resultJson?.startupPreparationSettledAt === "string";
  // The old preparer can still be unwinding even though the run is terminal.
  if (!settled && run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date()) return false;
  const leases = await readRunEnvironmentLeases(db, run);
  if ((!settled && leases.length === 0 && !historicalBeforeSelection) ||
    leases.some(leaseRetainsResources)) return false;
  return !await hasProviderDispatchEvidence(db, run);
}
