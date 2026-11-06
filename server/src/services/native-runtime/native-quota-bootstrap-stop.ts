import { and, eq, inArray, isNull } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { readProviderFailure } from "@paperclipai/shared";
import { recordNativeLocalProcessStop, recordedLocalExecutionStopped } from "../native-local-process-stop.js";
import { notifyLiveRunRecovery } from "../live-run-recovery-notifications.js";
import { NATIVE_PROVIDER_DURABLE_EVENT_TYPES } from "./native-retired-backup-source.js";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Record and fence only the local runner's stop. It is not provider-stop,
 * action-settlement, cleanup, or authority evidence and cannot admit a successor. */
export async function fenceStoppedQuotaBootstrapRunner(db: Db, input: { companyId: string; issueId: string; runId: string }, options?: { failpoint?: () => void }) {
  if (process.platform === "win32") return false;
  return db.transaction(tx => fenceStoppedQuotaBootstrapRunnerInTransaction(tx, input, options));
}

export async function fenceStoppedQuotaBootstrapRunnerInTransaction(tx: Parameters<Parameters<Db["transaction"]>[0]>[0], input: { companyId: string; issueId: string; runId: string }, options?: { failpoint?: () => void }) {
    if (process.platform === "win32") return false;
    const [issue] = await tx.select().from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))).for("update");
    const [coordinator] = await tx.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId, input.companyId), eq(nativeRunFinalizations.issueId, input.issueId), eq(nativeRunFinalizations.runId, input.runId))).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.nativeIssueId, input.issueId))).for("update");
    if (!issue || !coordinator || !run || issue.assigneeAgentId !== run.agentId ||
        !["todo", "in_progress", "in_review"].includes(issue.status) ||
        (issue.executionRunId && issue.executionRunId !== run.id) || (issue.checkoutRunId && issue.checkoutRunId !== run.id) ||
        run.runtimeMode !== "native" || run.status !== "failed" || !run.finishedAt ||
        coordinator.phase !== "retryable_failure" || coordinator.leaseOwner !== null || coordinator.resultId !== null ||
        coordinator.failureDetail?.bootstrapRunnerStop != null || run.processPid === null || run.processGroupId === null ||
        run.processPid !== run.processGroupId || run.processStartedAt === null) return false;
    const details = object(coordinator.failureDetail), result = object(run.resultJson);
    const execution = object(object(run.runnerProfileJson).nativeExecutionInput), capability = object(execution.builtinQuotaPoolCapability);
    const binding = object(execution.binding), selection = object(run.contextSnapshot?.aiRouterSelection);
    const failure = readProviderFailure(result.providerFailure);
    if (details.recoveryMode !== "bootstrap_retry" || details.providerSessionEstablished !== false ||
        details.providerEventsExist !== false || details.checkpointExists !== false ||
        failure?.category !== "quota_exhausted" || failure.phase !== "startup" ||
        execution.schema !== "paperclip.native-execution-input.v11" || object(execution.provider).kind !== "acpx" ||
        capability.schema !== "paperclip.native-quota-failover.v1" ||
        capability.companyId !== input.companyId || capability.issueId !== input.issueId || capability.agentId !== run.agentId || capability.runId !== run.id ||
        binding.companyId !== input.companyId || binding.issueId !== input.issueId || binding.agentId !== run.agentId || binding.runId !== run.id ||
        capability.poolId !== selection.poolId || capability.memberId !== selection.memberId || capability.taskKey !== run.contextSnapshot?.aiRouterTaskKey ||
        result.nativeCancellation != null || result.startupCancellation != null || result.executionCancellation != null ||
        object(run.runnerProfileJson).sessionCheckpoint != null) return false;
    const leases = await tx.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.heartbeatRunId, run.id))).for("update");
    if (leases.some(lease => lease.provider !== "local" || !lease.releasedAt || lease.cleanupStatus === "failed" || lease.status === "pending_cleanup")) return false;
    const [event] = await tx.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.companyId, input.companyId), eq(heartbeatRunEvents.runId, run.id), inArray(heartbeatRunEvents.eventType, [...NATIVE_PROVIDER_DURABLE_EVENT_TYPES]))).limit(1);
    if (event || !(await recordedLocalExecutionStopped(tx as unknown as Db, run)) || !(await recordNativeLocalProcessStop(tx as unknown as Db, run))) return false;
    await notifyLiveRunRecovery(tx, { companyId: input.companyId, runId: run.id, agentId: run.agentId });
    await tx.update(heartbeatRuns).set({ processPid: null, processGroupId: null, processStartedAt: null, updatedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
    await tx.update(nativeRunFinalizations).set({ failureDetail: { ...coordinator.failureDetail, bootstrapRunnerStop: { schema: "paperclip.native-quota-bootstrap-runner-stop.v1", runId: run.id, processPid: run.processPid, processGroupId: run.processGroupId, processStartedAt: run.processStartedAt.toISOString() } }, updatedAt: new Date() }).where(and(eq(nativeRunFinalizations.runId, run.id), isNull(nativeRunFinalizations.leaseOwner)));
    options?.failpoint?.();
    return true;
}
