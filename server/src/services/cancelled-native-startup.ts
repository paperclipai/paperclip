import { isPreDispatchReviewWait } from "./pre-dispatch-review-wait.js";
import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations, nativeRunResults, type Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { claimedAdapterType } from "./conversation-continuation.js";
import { PROCESS_IDENTITY_RECORDED, PROCESS_START_REQUESTED } from "./native-local-process-stop.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { canContinueCancelledRun, readRunCancellation } from "./run-cancellation.js";
import { legacyControllerBootId } from "./legacy-controller-lease.js";
import { hasRequiredWorkspaceRecovery } from "./workspace-restore-recovery-state.js";
import { hasVerifiedWorkspaceRepair } from "./workspace-recovery-receipt.js";
import { readFailedPreparationSettlement } from "./failed-preparation-settlement.js";

type Run = Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "status" | "startedAt" | "finishedAt" | "runtimeMode" |
  "runtimeModeResolvedAt" | "errorCode" | "error" | "resultJson" | "runnerProfileJson" |
  "contextSnapshot" | "processPid" | "processGroupId" | "processStartedAt" |
  "sessionIdAfter" | "issueId" | "nativeIssueId" | "nativeSessionId" | "executionStage" |
  "controllerBootId" | "controllerLeaseExpiresAt">;
type Coordinator = typeof nativeRunFinalizations.$inferSelect;

export async function isFailedNativePreparation(db: Db, run: Run, coordinator: Coordinator | undefined) {
  return failedNativePreparation(db, run, coordinator, false);
}

export async function isFailedNativePreparationRetryAncestor(db: Db, run: Run, coordinator: Coordinator | undefined) {
  return failedNativePreparation(db, run, coordinator, true);
}

async function failedNativePreparation(db: Db, run: Run, coordinator: Coordinator | undefined, historicalRetryAncestor: boolean) {
  if (run.status === "interrupted") return !historicalRetryAncestor && !coordinator && isInterruptedNativePreparation(db, run);
  const recovery = run.resultJson?.executionRecovery as Record<string, unknown> | undefined;
  const preparationFailure = run.errorCode === "setup_failed" || historicalRetryAncestor && run.errorCode === "adapter_failed";
  if (run.status !== "failed" || !run.finishedAt || run.runtimeMode !== "legacy" || run.runtimeModeResolvedAt
    || !preparationFailure || run.executionStage !== "preparing"
    || claimedAdapterType(run) !== "paperclip_runner" || coordinator
    || recovery?.kind !== "bootstrap" || recovery.providerWorkStarted !== false
    || run.processPid || run.processGroupId || run.processStartedAt || run.sessionIdAfter
    || run.nativeIssueId || run.nativeSessionId || run.runnerProfileJson?.nativeExecutionInput != null
    || run.runnerProfileJson?.nativeWorkspaceSync != null
    || run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date()) return false;
  const leases = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
  ));
  const [result] = await db.select({ id: nativeRunResults.id }).from(nativeRunResults).where(and(
    eq(nativeRunResults.companyId, run.companyId), eq(nativeRunResults.runId, run.id),
  )).limit(1);
  if (result || await nativeStartupHasExecutionEvidence(db, run)) return false;
  if (!leases.length && run.runnerProfileJson?.remoteWorkspace == null) return !historicalRetryAncestor;
  const issueId = run.nativeIssueId ?? run.issueId ?? run.contextSnapshot?.issueId;
  return typeof issueId === "string" && leases.length > 0 && leases.every(lease => lease.issueId === issueId
    && lease.metadata?.pendingCleanupInFlight !== true && hasRemoteTerminationReceipt(lease))
    && await hasSettledFailedPreparationEvidence(db, run, historicalRetryAncestor)
    && await hasVerifiedWorkspaceRepair(db, run);
}

async function hasSettledFailedPreparationEvidence(db: Db, run: Run, historicalRetryAncestor = false): Promise<boolean> {
  const [source] = await db.select({ agentId: heartbeatRuns.agentId,
    runtimeModeResolverVersion: heartbeatRuns.runtimeModeResolverVersion, runtimeModeReason: heartbeatRuns.runtimeModeReason,
    runnerInstanceId: heartbeatRuns.runnerInstanceId, nativePhase: heartbeatRuns.nativePhase,
    driverKind: heartbeatRuns.driverKind, driverVersion: heartbeatRuns.driverVersion,
    completionContractId: heartbeatRuns.completionContractId, completionContractSha256: heartbeatRuns.completionContractSha256,
    externalRunId: heartbeatRuns.externalRunId,
    logStore: heartbeatRuns.logStore, logRef: heartbeatRuns.logRef, logBytes: heartbeatRuns.logBytes,
    logSha256: heartbeatRuns.logSha256, logCompressed: heartbeatRuns.logCompressed,
    stdoutExcerpt: heartbeatRuns.stdoutExcerpt, stderrExcerpt: heartbeatRuns.stderrExcerpt,
    lastOutputAt: heartbeatRuns.lastOutputAt, lastOutputSeq: heartbeatRuns.lastOutputSeq,
    lastOutputStream: heartbeatRuns.lastOutputStream, lastOutputBytes: heartbeatRuns.lastOutputBytes,
    usageJson: heartbeatRuns.usageJson, exitCode: heartbeatRuns.exitCode, signal: heartbeatRuns.signal,
  }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id)));
  if (!source || source.logCompressed || source.lastOutputSeq !== 0 || Object.entries(source).some(([key, value]) =>
    !["agentId", "logCompressed", "lastOutputSeq", "usageJson"].includes(key) &&
    !(historicalRetryAncestor && key === "sessionIdBefore") && value !== null)
    || !hasOnlyPreparationAccountingContext(source.usageJson, run.issueId ?? run.contextSnapshot?.issueId)
    || Object.keys(run.runnerProfileJson ?? {}).some(key => !["adapterDispatch", "remoteWorkspace",
      "chatControlRecoveryAdmission"].includes(key))
    || run.resultJson?.stopReason !== "adapter_failed"
    || Object.keys(run.resultJson).some(key => !["stopReason", "timeoutFired", "timeoutSource", "executionRecovery",
      "timeoutConfigured", "effectiveTimeoutSec", "systemRecoveryAdoption", "workspaceRestoreFailure",
      "workspaceRestoreRecovery"].includes(key))) return false;
  return Boolean(await readFailedPreparationSettlement(db, { ...run, agentId: source.agentId }, historicalRetryAncestor));
}

function hasOnlyPreparationAccountingContext(usage: unknown, issueId: unknown): boolean {
  if (usage === null) return true;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)
    || Object.keys(usage).length !== 1 || !Object.hasOwn(usage, "ledgerScope")) return false;
  const scope = (usage as Record<string, unknown>).ledgerScope as Record<string, unknown> | null;
  return Boolean(scope && typeof scope === "object" && !Array.isArray(scope) && Object.keys(scope).length === 3
    && scope.issueId === issueId && (scope.projectId === null || typeof scope.projectId === "string" && isUuidLike(scope.projectId))
    && (scope.billingCode === null || typeof scope.billingCode === "string"));
}

/** Candidate state only. Admission must also verify ownership, execution records,
 * stopped leases, and any saved-file obligation below. */
export function isInterruptedNativePreparationCandidate(run: Run): boolean {
  const cancellation = readRunCancellation(run.resultJson);
  // Older shutdown records predate structured cancellation. Current records
  // identify unexpected system interruption without relying on an error label.
  const systemInterruption = cancellation
    ? cancellation.initiator.type === "system" && cancellation.source !== "operator" &&
      (cancellation.source === "shutdown" || cancellation.expected === false)
    : run.errorCode === "server_shutdown_interrupted";
  const recovery = run.resultJson?.executionRecovery as Record<string, unknown> | undefined;
  return Boolean(systemInterruption && run.status === "interrupted" && run.finishedAt
    && run.runtimeMode === "legacy" && !run.runtimeModeResolvedAt && run.executionStage === "preparing"
    && claimedAdapterType(run) === "paperclip_runner" && !run.processPid && !run.processGroupId
    && !run.processStartedAt && !run.sessionIdAfter && !run.nativeIssueId && !run.nativeSessionId
    && run.runnerProfileJson?.nativeExecutionInput == null && recovery?.providerWorkStarted !== true);
}

export async function isInterruptedNativePreparation(db: Db, run: Run): Promise<boolean> {
  const recovery = run.resultJson?.executionRecovery as Record<string, unknown> | undefined;
  const settled = recovery?.kind === "bootstrap" && recovery.providerWorkStarted === false;
  if (!isInterruptedNativePreparationCandidate(run)
    || run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date()
    || !settled && (!run.controllerBootId || run.controllerBootId === legacyControllerBootId)) return false;
  const [coordinator] = await db.select({ id: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, run.companyId), eq(nativeRunFinalizations.runId, run.id),
  )).limit(1);
  const [result] = await db.select({ id: nativeRunResults.id }).from(nativeRunResults).where(and(
    eq(nativeRunResults.companyId, run.companyId), eq(nativeRunResults.runId, run.id),
  )).limit(1);
  if (coordinator || result || await nativeStartupHasExecutionEvidence(db, run)) return false;
  const leases = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
  ));
  if (leases.some(lease => !lease.releasedAt || lease.status === "pending_cleanup" || lease.cleanupStatus === "failed"
    || lease.metadata?.pendingCleanupInFlight === true
    || lease.provider !== "local" && !hasRemoteTerminationReceipt(lease))) return false;
  if (hasRequiredWorkspaceRecovery(run.resultJson) || run.runnerProfileJson?.remoteWorkspace != null
    || run.runnerProfileJson?.nativeWorkspaceSync != null) return hasVerifiedWorkspaceRepair(db, run);
  return run.resultJson?.workspaceRestoreFailure == null;
}

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
  const leases = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
  ));
  if ((!settled && leases.length === 0 && !historicalBeforeSelection) || leases.some(lease =>
    lease.provider === "local"
      ? !lease.releasedAt || lease.status === "pending_cleanup" || lease.cleanupStatus === "failed"
      : !hasRemoteTerminationReceipt(lease))) return false;
  // Reject contradictory retained evidence, including a crash after a launch
  // request but before the PID callback. Provider events never certify a stop.
  return !await nativeStartupHasExecutionEvidence(db, run);
}

async function nativeStartupHasExecutionEvidence(db: Db, run: Run) {
  const [execution] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    or(isNotNull(heartbeatRunEvents.sourceEventId),
      inArray(heartbeatRunEvents.eventType, ["adapter.invoke", PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED,
        "harness.ready", "session.started", "session.resumed", "session.updated", "turn.started",
        "provider.event", "provider.rpc_result", "tool.execution.started"])),
  )).limit(1);
  return Boolean(execution);
}
