import { isComputerAdmissionWait } from "./execution-recovery-attempt.js";
import { adapterExecutionControls } from "./adapter-execution-control.js";
import { isPreDispatchReviewWait } from "./pre-dispatch-review-wait.js";
import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { computers, environmentLeases, heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { claimedAdapterType } from "./conversation-continuation.js";
import { PROCESS_IDENTITY_RECORDED, PROCESS_START_REQUESTED } from "./native-local-process-stop.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { canContinueCancelledRun } from "./run-cancellation.js";
import { legacyControllerBootId } from "./legacy-controller-lease.js";

type Run = typeof heartbeatRuns.$inferSelect;
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
  const leases = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
  ));
  if ((!settled && leases.length === 0 && !historicalBeforeSelection) || leases.some(lease =>
    lease.provider === "local"
      ? !lease.releasedAt || lease.status === "pending_cleanup" || lease.cleanupStatus === "failed"
      : !hasRemoteTerminationReceipt(lease))) return false;
  // Reject contradictory retained evidence, including a crash after a launch
  // request but before the PID callback. Provider events never certify a stop.
  const [execution] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    or(isNotNull(heartbeatRunEvents.sourceEventId),
      inArray(heartbeatRunEvents.eventType, ["adapter.invoke", PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED,
        "harness.ready", "session.started", "session.resumed", "session.updated", "turn.started",
        "provider.event", "provider.rpc_result", "tool.execution.started"])),
  )).limit(1);
  return !execution;
}

/** Retain task ownership for a typed wait that never admitted provider work.
 * This proves no provider effects, not that the preparing controller is gone. */
export async function isComputerAdmissionWaitBeforeProvider(db: Db, run: Run): Promise<boolean> {
  if (!isComputerAdmissionWait(run) || !run.finishedAt || run.runtimeModeResolvedAt ||
      run.nativeIssueId || run.nativeSessionId || run.processPid || run.processGroupId ||
      run.processStartedAt || run.sessionIdAfter) return false;
  const admission = run.resultJson!.computerAdmission as Record<string, string>;
  const [computer] = await db.select({ id: computers.id }).from(computers).where(and(
    eq(computers.id, admission.computerId), eq(computers.companyId, run.companyId),
    eq(computers.environmentId, admission.environmentId), eq(computers.provider, "boat"),
  )).limit(1);
  if (!computer) return false;
  const [lease] = await db.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
    eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
  )).limit(1);
  const [coordinator] = await db.select({ id: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, run.companyId), eq(nativeRunFinalizations.runId, run.id),
  )).limit(1);
  if (lease || coordinator) return false;
  const [execution] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    or(isNotNull(heartbeatRunEvents.sourceEventId),
      inArray(heartbeatRunEvents.eventType, ["adapter.invoke", PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED,
        "harness.ready", "session.started", "session.resumed", "session.updated", "turn.started",
        "provider.event", "provider.rpc_result", "tool.execution.started"])),
  )).limit(1);
  return !execution;
}

/** Shared cleanup fence for retry admission and acknowledgement of a later Stop. */
export function hasSettledComputerAdmissionPreparation(run: Run): boolean {
  if (adapterExecutionControls.has(run.id)) return false;
  const settledAt = run.resultJson?.computerAdmissionPreparationSettledAt;
  const settled = typeof settledAt === "string" && Number.isFinite(Date.parse(settledAt));
  if (!settled && !(run.executionStage === "preparing" && run.controllerBootId &&
      run.controllerBootId !== legacyControllerBootId && run.controllerLeaseExpiresAt &&
      run.controllerLeaseExpiresAt <= new Date())) return false;
  return true;
}

/** A paused scheduled computer retry never reached a preparing controller.
 * This is evidence for new user input, never automatic replay of the old wake. */
export async function isPausedComputerAdmissionRetryBeforeProvider(db: Db, run: Run): Promise<boolean> {
  const issueId = run.contextSnapshot?.issueId;
  if (run.status !== "cancelled" || run.errorCode !== "issue_paused" ||
      run.scheduledRetryReason !== "computer_admission_wait" || !run.retryOfRunId ||
      !run.scheduledRetryAt || !run.finishedAt || typeof issueId !== "string" ||
      run.startedAt || run.runtimeMode !== "legacy" || run.runtimeModeResolvedAt || run.executionStage ||
      run.controllerBootId || run.controllerLeaseExpiresAt || run.nativeIssueId || run.nativeSessionId ||
      run.runnerInstanceId || run.processPid || run.processGroupId || run.processStartedAt || run.sessionIdAfter ||
      adapterExecutionControls.has(run.id)) return false;
  const [parent] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.retryOfRunId),
    eq(heartbeatRuns.agentId, run.agentId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`,
  )).limit(1);
  if (!parent || !await canRetryComputerAdmissionWait(db, parent)) return false;
  const [receipt] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    eq(heartbeatRunEvents.agentId, run.agentId), eq(heartbeatRunEvents.eventType, "lifecycle"),
    eq(heartbeatRunEvents.stream, "system"),
    eq(heartbeatRunEvents.message, "Scheduled retry suppressed because the issue is held by an active subtree pause hold"),
    sql`${heartbeatRunEvents.payload}->>'issueId' = ${issueId}`,
    sql`${heartbeatRunEvents.payload}->>'scheduledRetryReason' = 'computer_admission_wait'`,
    sql`${heartbeatRunEvents.payload}->>'scheduledRetryAt' = ${run.scheduledRetryAt.toISOString()}`,
    sql`${heartbeatRunEvents.payload}->>'holdId' is not null`,
  )).limit(1);
  if (!receipt) return false;
  const [lease] = await db.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
    eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
  )).limit(1);
  const [coordinator] = await db.select({ id: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, run.companyId), eq(nativeRunFinalizations.runId, run.id),
  )).limit(1);
  const [execution] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    or(isNotNull(heartbeatRunEvents.sourceEventId),
      inArray(heartbeatRunEvents.eventType, ["adapter.invoke", PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED,
        "harness.ready", "session.started", "session.resumed", "session.updated", "turn.started",
        "provider.event", "provider.rpc_result", "tool.execution.started"])),
  )).limit(1);
  return !lease && !coordinator && !execution;
}

/** Scheduling additionally requires cleanup or an expired prior controller. */
export async function canRetryComputerAdmissionWait(db: Db, run: Run): Promise<boolean> {
  return hasSettledComputerAdmissionPreparation(run) && isComputerAdmissionWaitBeforeProvider(db, run);
}
