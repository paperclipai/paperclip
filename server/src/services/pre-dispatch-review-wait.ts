import { and, eq } from "drizzle-orm";
import { heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { hasProviderDispatchEvidence, leaseRetainsResources, readRunEnvironmentLeases } from "./run-dispatch-evidence.js";

type Run = typeof heartbeatRuns.$inferSelect;
type DispatchFields = "startedAt" | "runtimeModeResolvedAt" | "processPid" | "processGroupId" |
  "processStartedAt" | "nativeIssueId" | "nativeSessionId" | "sessionIdAfter" |
  "controllerBootId" | "controllerLeaseExpiresAt" | "executionStage" | "contextSnapshot";

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
  if (!isPreDispatchReviewWait(run)) return false;
  const [coordinator] = await db.select({ id: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, run.companyId), eq(nativeRunFinalizations.runId, run.id),
  )).limit(1);
  if (coordinator) return false;
  if ((await readRunEnvironmentLeases(db, run)).some(leaseRetainsResources)) return false;
  return !await hasProviderDispatchEvidence(db, run);
}
