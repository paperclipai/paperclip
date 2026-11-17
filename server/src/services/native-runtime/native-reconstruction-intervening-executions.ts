import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, issueRecoveryActions, nativeRunFinalizations, nativeRunResults, type Db } from "@paperclipai/db";
import type { ExecutionReconciliation } from "@paperclipai/shared";
import { hasAcknowledgedNativeStopIntent } from "../acknowledged-native-stop.js";
import { hasRemoteTerminationReceipt } from "../remote-execution-termination.js";
import { hasRequiredWorkspaceRecovery } from "../workspace-restore-recovery-state.js";
import { nativeSha256 } from "./canonical.js";
import { readNativeWorkspaceSyncReference } from "./native-workspace-sync.js";

type RecordedExecution = NonNullable<NonNullable<ExecutionReconciliation["workspaceReconstruction"]>["interveningExecutions"]>;
type InterveningRun = Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "agentId" | "nativeIssueId" | "runtimeMode" | "status" | "finishedAt" | "runnerProfileJson" | "resultJson">;

/** A later run is not made harmless by its terminal status. Only an audited
 * run-only cancellation with independently recorded file repair can be kept
 * alongside the older loss decision. Preserve its exact proof through dispatch. */
export async function reconciledInterveningExecutions(db: Db, source: typeof heartbeatRuns.$inferSelect,
  runs: InterveningRun[]): Promise<RecordedExecution | null> {
  const recorded: RecordedExecution = [];
  for (const run of runs) {
    if (run.companyId !== source.companyId || run.agentId !== source.agentId || run.nativeIssueId !== source.nativeIssueId
      || run.runtimeMode !== "native" || run.status !== "cancelled" || !run.finishedAt
      || !hasAcknowledgedNativeStopIntent(run) || !hasRequiredWorkspaceRecovery(run.resultJson)
      || run.runnerProfileJson?.nativeWorkspaceFinalizationOwner) return null;
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.companyId, run.companyId), eq(nativeRunFinalizations.runId, run.id),
      eq(nativeRunFinalizations.issueId, run.nativeIssueId!),
    )).for("share");
    if (!coordinator || coordinator.phase !== "terminal_failure" || coordinator.failureCode !== "native_retry_cancelled"
      || coordinator.leaseOwner || coordinator.resultId || coordinator.nextAttemptAt || coordinator.failureDetail?.successorRunId) return null;
    const [result] = await db.select({ id: nativeRunResults.id }).from(nativeRunResults).where(and(
      eq(nativeRunResults.companyId, run.companyId), eq(nativeRunResults.runId, run.id),
    )).limit(1);
    if (result) return null;
    const reference = readNativeWorkspaceSyncReference(run.runnerProfileJson?.nativeWorkspaceSync);
    const leases = await db.select().from(environmentLeases).where(and(
      eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
    )).for("share");
    if (!reference || !leases.some(lease => lease.id === reference.leaseId && lease.providerLeaseId === reference.providerLeaseId)
      || leases.some(lease => lease.issueId !== run.nativeIssueId || !hasRemoteTerminationReceipt(lease)
        || lease.metadata?.pendingCleanupInFlight === true
        || (lease.metadata?.remoteExecutionTermination as { state?: string } | undefined)?.state !== "stopped")) return null;
    for (const lease of leases) {
      const [other] = await db.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
        ne(environmentLeases.id, lease.id), eq(environmentLeases.provider, lease.provider!),
        eq(environmentLeases.providerLeaseId, lease.providerLeaseId!), inArray(environmentLeases.status, ["active", "retained", "pending_cleanup"]),
      )).limit(1);
      if (other) return null;
    }
    const actions = await db.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, run.companyId), eq(issueRecoveryActions.sourceIssueId, run.nativeIssueId!),
      eq(issueRecoveryActions.status, "resolved"), eq(issueRecoveryActions.outcome, "restored"),
      sql`${issueRecoveryActions.evidence}->>'runId' = ${run.id}`,
    )).for("share");
    const repairs = actions.filter(action => {
      const decision = action.evidence.executionReconciliation as ExecutionReconciliation | undefined;
      return action.evidence.runId === run.id && action.kind === "active_run_watchdog" && action.ownerType === "board"
        && action.returnOwnerAgentId === null && hasRequiredWorkspaceRecovery(action.evidence)
        && action.evidence.continuationDelivery === "not_requested" && decision?.runId === run.id
        && decision.providerStopped === true && decision.actionOutcome === "not_performed"
        && typeof decision.workspaceRepairEvidence === "string" && decision.workspaceRepairEvidence.trim().length >= 20;
    });
    if (repairs.length !== 1) return null;
    const repair = repairs[0];
    recorded.push({ runId: run.id, recoveryActionId: repair.id, evidenceSha256: nativeSha256({
      runId: run.id, finishedAt: run.finishedAt.toISOString(), reference, recovery: run.resultJson?.workspaceRestoreRecovery,
      reconciliation: repair.evidence.executionReconciliation,
      leases: leases.map(lease => ({ id: lease.id, receipt: lease.metadata?.remoteExecutionTermination })).sort((a, b) => a.id.localeCompare(b.id)),
    }) });
  }
  return recorded.sort((a, b) => a.runId.localeCompare(b.runId));
}
