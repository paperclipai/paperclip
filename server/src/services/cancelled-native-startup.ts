import { isPreDispatchReviewWait } from "./pre-dispatch-review-wait.js";
import { createHash } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
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
import { hasVerifiedPreparationLog } from "./verified-preparation-log.js";
import { executionStartedEventPredicate, noRetainedExecutionPredicate } from "./pre-dispatch-execution-evidence.js";

type Run = Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "status" | "startedAt" | "finishedAt" | "runtimeMode" |
  "runtimeModeResolvedAt" | "errorCode" | "error" | "resultJson" | "runnerProfileJson" |
  "contextSnapshot" | "processPid" | "processGroupId" | "processStartedAt" |
  "sessionIdAfter" | "issueId" | "nativeIssueId" | "nativeSessionId" | "executionStage" |
  "controllerBootId" | "controllerLeaseExpiresAt">;
type Coordinator = typeof nativeRunFinalizations.$inferSelect;
const EMPTY_LOG_SHA256 = createHash("sha256").digest("hex");

export async function isFailedNativePreparation(db: Db, run: Run, coordinator: Coordinator | undefined) {
  return failedNativePreparation(db, run, coordinator, false);
}

export async function isFailedNativePreparationRetryAncestor(db: Db, run: Run, coordinator: Coordinator | undefined) {
  return failedNativePreparation(db, run, coordinator, true);
}

async function failedNativePreparation(db: Db, run: Run, coordinator: Coordinator | undefined, historicalRetryAncestor: boolean) {
  if (!historicalRetryAncestor && !coordinator && await isInterruptedNativePreparation(db, run)) return true;
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
    contextSnapshot: sql<Record<string, unknown>>`jsonb_build_object(
      'skillSelectionSnapshot', ${heartbeatRuns.contextSnapshot}->'skillSelectionSnapshot',
      'skillVersions', ${heartbeatRuns.contextSnapshot}->'skillVersions')`,
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
  const emptyLog = source && source.logStore === "s3_segments"
    && source.logRef === `${run.companyId}/${source.agentId}/${run.id}`
    && source.logBytes === 0 && source.logSha256 === EMPTY_LOG_SHA256
    && [source.stdoutExcerpt, source.stderrExcerpt].every(value => value === null || value === "");
  const preparationLog = historicalRetryAncestor && source &&
    await hasVerifiedPreparationLog({ ...source, id: run.id, companyId: run.companyId });
  if (!source || source.logCompressed || !preparationLog && source.lastOutputSeq !== 0 || Object.entries(source).some(([key, value]) =>
    !["agentId", "contextSnapshot", "logCompressed", "lastOutputSeq", "usageJson"].includes(key) &&
    !(historicalRetryAncestor && key === "sessionIdBefore") &&
    !(preparationLog && ["logStore", "logRef", "logBytes", "logSha256", "stdoutExcerpt", "stderrExcerpt",
      "lastOutputAt", "lastOutputStream", "lastOutputBytes"].includes(key)) &&
    !(emptyLog && ["logStore", "logRef", "logBytes", "logSha256", "stdoutExcerpt", "stderrExcerpt"].includes(key)) && value !== null)
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
  const recovery = run.resultJson?.executionRecovery as Record<string, unknown> | undefined;
  // Restart recovery records this certificate only after revoking a preparing
  // controller. A generic process-lost error cannot establish safe replay.
  const lostPreparation = run.status === "failed" && run.errorCode === "process_lost"
    && recovery?.kind === "bootstrap" && recovery.providerWorkStarted === false;
  // Older shutdown records predate structured cancellation. Current records
  // identify unexpected system interruption without relying on an error label.
  const systemInterruption = cancellation
    ? cancellation.initiator.type === "system" && cancellation.source !== "operator" &&
      (cancellation.source === "shutdown" || cancellation.expected === false)
    : run.errorCode === "server_shutdown_interrupted" || lostPreparation;
  return Boolean(systemInterruption && (run.status === "interrupted" || lostPreparation) && run.finishedAt
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

function noProviderOutputPredicate() {
  return and(...[
    heartbeatRuns.runtimeModeResolverVersion, heartbeatRuns.runtimeModeReason, heartbeatRuns.runnerInstanceId,
    heartbeatRuns.nativePhase, heartbeatRuns.driverKind, heartbeatRuns.driverVersion,
    heartbeatRuns.completionContractId, heartbeatRuns.completionContractSha256, heartbeatRuns.externalRunId,
    heartbeatRuns.logStore, heartbeatRuns.logRef, heartbeatRuns.logBytes, heartbeatRuns.logSha256,
    heartbeatRuns.stdoutExcerpt, heartbeatRuns.stderrExcerpt, heartbeatRuns.lastOutputAt,
    heartbeatRuns.lastOutputStream, heartbeatRuns.lastOutputBytes, heartbeatRuns.exitCode, heartbeatRuns.signal,
  ].map(column => isNull(column)), eq(heartbeatRuns.lastOutputSeq, 0), eq(heartbeatRuns.logCompressed, false));
}

async function isCancelledUnclaimedWorkspaceWaitRetry(db: Db, run: Run): Promise<boolean> {
  const cancellation = readRunCancellation(run.resultJson);
  const issueId = run.issueId ?? run.contextSnapshot?.issueId;
  if (run.runtimeMode !== "legacy" || run.startedAt !== null || run.executionStage !== null
    || run.runnerProfileJson !== null || typeof issueId !== "string" || !isUuidLike(issueId)
    || run.errorCode !== "cancelled" || run.resultJson?.stopReason !== "cancelled"
    || cancellation?.source !== "control_plane" || cancellation.expected !== true || cancellation.initiator.type !== "system") return false;
  const [source] = await db.select({ agentId: heartbeatRuns.agentId, createdAt: heartbeatRuns.createdAt,
    retryOfRunId: heartbeatRuns.retryOfRunId,
  }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id),
    eq(heartbeatRuns.scheduledRetryReason, "workspace_busy"),
    sql`${heartbeatRuns.contextSnapshot}->>'retryReason' = 'workspace_busy'`,
    sql`${heartbeatRuns.contextSnapshot}->>'retryOfRunId' = ${heartbeatRuns.retryOfRunId}::text`,
    sql`(${heartbeatRuns.resultJson} - array['stopReason', 'cancellation', 'startupCancellation',
      'timeoutFired', 'timeoutSource', 'timeoutConfigured', 'effectiveTimeoutSec']) = '{}'::jsonb`,
    noRetainedExecutionPredicate(), noProviderOutputPredicate(), isNull(heartbeatRuns.runnerProfileJson),
    isNull(heartbeatRuns.usageJson)));
  if (!source?.retryOfRunId) return false;
  const [parent] = await db.select({ id: heartbeatRuns.id, usageJson: heartbeatRuns.usageJson }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.agentId, source.agentId), eq(heartbeatRuns.id, source.retryOfRunId),
    sql`coalesce(${heartbeatRuns.issueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${issueId}`,
    eq(heartbeatRuns.runtimeMode, "legacy"), eq(heartbeatRuns.status, "cancelled"), eq(heartbeatRuns.errorCode, "workspace_busy"),
    eq(heartbeatRuns.executionStage, "settled"), isNotNull(heartbeatRuns.finishedAt), lte(heartbeatRuns.finishedAt, source.createdAt),
    isNull(heartbeatRuns.runtimeModeResolvedAt), isNull(heartbeatRuns.controllerLeaseExpiresAt),
    ...[heartbeatRuns.processPid, heartbeatRuns.processGroupId, heartbeatRuns.processStartedAt,
      heartbeatRuns.nativeIssueId, heartbeatRuns.nativeSessionId, heartbeatRuns.sessionIdAfter].map(column => isNull(column)),
    noProviderOutputPredicate(),
    sql`${heartbeatRuns.runnerProfileJson} #>> '{adapterDispatch,adapterType}' = 'paperclip_runner'`,
    sql`(${heartbeatRuns.runnerProfileJson} - 'adapterDispatch' - 'chatControlRecoveryAdmission') = '{}'::jsonb`,
    sql`${heartbeatRuns.resultJson}->'executionRecovery'->>'kind' = 'workspace_wait'`,
    sql`${heartbeatRuns.resultJson}->'executionRecovery'->'providerWorkStarted' = 'false'::jsonb`,
    sql`(${heartbeatRuns.resultJson} - 'cancellation' - 'workspaceBusy' - 'executionRecovery') = '{}'::jsonb`,
    sql`not exists (select 1 from ${environmentLeases} where ${environmentLeases.companyId} = ${heartbeatRuns.companyId}
      and ${environmentLeases.heartbeatRunId} = ${heartbeatRuns.id})`,
    sql`not exists (select 1 from ${nativeRunFinalizations} where ${nativeRunFinalizations.companyId} = ${heartbeatRuns.companyId}
      and ${nativeRunFinalizations.runId} = ${heartbeatRuns.id})`,
    sql`not exists (select 1 from ${heartbeatRunEvents} where ${and(eq(heartbeatRunEvents.companyId, heartbeatRuns.companyId),
      eq(heartbeatRunEvents.runId, heartbeatRuns.id), executionStartedEventPredicate())})`,
  ));
  if (!parent || !hasOnlyPreparationAccountingContext(parent.usageJson, issueId)) return false;
  const [result] = await db.select({ id: nativeRunResults.id }).from(nativeRunResults).where(and(
    eq(nativeRunResults.companyId, run.companyId), inArray(nativeRunResults.runId, [run.id, parent.id]),
  )).limit(1);
  return !result;
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
  const unclaimedWorkspaceRetry = !coordinator && await isCancelledUnclaimedWorkspaceWaitRetry(db, run);
  const beforeSelection = beforeReviewDispatch || unclaimedWorkspaceRetry || historicalBeforeSelection || run.runtimeMode === "legacy" && !run.runtimeModeResolvedAt &&
    !run.nativeSessionId && !coordinator && claimedAdapterType(run) === "paperclip_runner" &&
    cancellation?.beforeNativeSelection === true;
  const neverClaimed = run.runtimeMode === "native" && coordinator &&
    ["observed", "terminal_failure"].includes(coordinator.phase) && coordinator.attempt === 0 &&
    coordinator.controllerGeneration === 0 && !coordinator.controllerBootId &&
    !coordinator.controllerPid && !coordinator.leaseOwner && !coordinator.leaseExpiresAt &&
    !coordinator.resultId && !coordinator.failureDetail?.successorRunId;
  if (!beforeSelection && !neverClaimed) return false;
  const settled = beforeReviewDispatch || unclaimedWorkspaceRetry || typeof run.resultJson?.startupPreparationSettledAt === "string";
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
