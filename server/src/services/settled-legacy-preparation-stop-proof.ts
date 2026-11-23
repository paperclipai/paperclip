import { and, eq } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { hasWorkspaceRestoreFailure } from "@paperclipai/shared";
import { executionStartedEventPredicate } from "./pre-dispatch-execution-evidence.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { readRunCancellation } from "./run-cancellation.js";
import { hasRequiredWorkspaceRecovery } from "./workspace-restore-recovery-state.js";

type Run = Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "status" | "finishedAt" | "runtimeMode" | "resultJson" | "runnerProfileJson" |
  "processPid" | "processGroupId" | "processStartedAt" | "sessionIdAfter" | "nativeIssueId" | "nativeSessionId" |
  "controllerLeaseExpiresAt">;
type Coordinator = typeof nativeRunFinalizations.$inferSelect;

const NATIVE_PROFILE_KEYS = ["nativeExecutionInput", "nativeWorkspaceSync", "remoteWorkspace",
  "nativeWorkspaceFinalizationOwner", "sessionCheckpoint"] as const;

export async function isSettledCancelledLegacyPreparation(db: Db, run: Run, coordinator: Coordinator | undefined): Promise<boolean> {
  if (run.runtimeMode !== "legacy" || run.status !== "cancelled" || !run.finishedAt || coordinator) return false;
  if (run.processPid || run.processGroupId || run.processStartedAt || run.sessionIdAfter ||
      run.nativeIssueId || run.nativeSessionId) return false;
  if (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date()) return false;
  const receipt = run.resultJson?.executionRecovery as Record<string, unknown> | undefined;
  if (receipt?.kind !== "bootstrap" || receipt.providerWorkStarted !== false ||
      typeof receipt.preparationSettledAt !== "string") return false;
  if (readRunCancellation(run.resultJson)?.expected !== true) return false;
  if (hasWorkspaceRestoreFailure(run.resultJson) || hasRequiredWorkspaceRecovery(run.resultJson)) return false;
  if (NATIVE_PROFILE_KEYS.some(key => run.runnerProfileJson?.[key] != null)) return false;
  const [execution] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id), executionStartedEventPredicate(),
  )).limit(1);
  if (execution) return false;
  const [finalization] = await db.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations)
    .where(and(eq(nativeRunFinalizations.companyId, run.companyId), eq(nativeRunFinalizations.runId, run.id))).limit(1);
  if (finalization) return false;
  const leases = await db.select().from(environmentLeases)
    .where(and(eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id)));
  return leases.every(lease => lease.metadata?.pendingCleanupInFlight !== true && (lease.provider === "local"
    ? Boolean(lease.releasedAt) && lease.status !== "pending_cleanup" && lease.cleanupStatus !== "failed"
    : hasRemoteTerminationReceipt(lease)));
}
