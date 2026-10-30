import { and, desc, eq, gt, isNotNull, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { notifyExecutionRunWork } from "../execution-control-notifications.js";
import { hasRequiredWorkspaceRecovery, nativeRunHasNoWorkspaceAccess } from "../workspace-restore-recovery-state.js";
import { preserveNativeFailedWorkspace } from "./native-failed-workspace-recovery.js";
import { readNativeWorkspaceSyncReference } from "./native-workspace-sync.js";

export async function retireSupersededNativeRetry(db: Db, input: {
  run: typeof heartbeatRuns.$inferSelect;
  coordinator: typeof nativeRunFinalizations.$inferSelect;
  issueExecutionRunId: string | null;
  now: Date;
}): Promise<boolean> {
  const { run, coordinator, now } = input;
  if (run.runtimeMode !== "native" || run.status !== "failed" || !run.startedAt || !run.finishedAt
    || run.processPid !== null || run.processGroupId !== null
    || coordinator.phase !== "retryable_failure" || coordinator.resultId || coordinator.leaseOwner
    || coordinator.companyId !== run.companyId || coordinator.issueId !== run.nativeIssueId
    || coordinator.runId !== run.id || input.issueExecutionRunId === run.id
    || run.runnerProfileJson?.nativeWorkspaceFinalizationOwner || nativeRunHasNoWorkspaceAccess(run)) return false;
  const reference = readNativeWorkspaceSyncReference(run.runnerProfileJson?.nativeWorkspaceSync);
  if (reference?.state !== "prepared") return false;

  const [successor] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.nativeIssueId, coordinator.issueId),
    eq(heartbeatRuns.agentId, run.agentId), eq(heartbeatRuns.runtimeMode, "native"),
    eq(heartbeatRuns.status, "succeeded"), eq(heartbeatRuns.nativePhase, "committed"),
    gt(heartbeatRuns.startedAt, run.finishedAt), isNotNull(heartbeatRuns.finishedAt),
    sql`${heartbeatRuns.contextSnapshot}->>'previousRunId' = ${run.id}`,
    sql`nullif(${heartbeatRuns.contextSnapshot}->>'taskRetryRequestId', '') is not null`,
  )).orderBy(desc(heartbeatRuns.startedAt)).limit(1);
  if (!successor) return false;
  const [source] = await db.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
    eq(environmentLeases.id, reference.leaseId), eq(environmentLeases.companyId, run.companyId),
    eq(environmentLeases.heartbeatRunId, run.id), eq(environmentLeases.issueId, coordinator.issueId),
    eq(environmentLeases.providerLeaseId, reference.providerLeaseId),
    sql`${environmentLeases.metadata}->>'remoteCwd' = ${reference.remoteCwd}`,
    sql`(${environmentLeases.executionWorkspaceId} is null or ${environmentLeases.executionWorkspaceId}::text = ${reference.workspaceId})`,
  )).limit(1);
  if (!source) return false;

  await notifyExecutionRunWork(db);
  await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", nextAttemptAt: null,
    leaseExpiresAt: null, controlDeadlineAt: null, recoveryState: "blocked",
    failureCode: "native_retry_superseded", failureDetail: { ...coordinator.failureDetail,
      reason: "completed_explicit_retry", successorRunId: successor.id }, updatedAt: now,
  }).where(eq(nativeRunFinalizations.runId, run.id));
  const [retired] = await db.update(heartbeatRuns).set({ nativePhase: "terminal_failure",
    nativePhaseUpdatedAt: now, updatedAt: now,
  }).where(eq(heartbeatRuns.id, run.id)).returning();
  const preserved = await preserveNativeFailedWorkspace(db, retired!);
  if (!preserved || !hasRequiredWorkspaceRecovery(preserved.resultJson)) {
    throw new Error("superseded_native_retry_preservation_not_recorded");
  }
  return true;
}
