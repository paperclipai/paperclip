import { currentControllerProcess } from "../controller-process-identity.js";
import type { ExecutionReconciliation } from "@paperclipai/shared";
import { nativeControllerAuthorityDigest, isNativeRunnerOwnershipHeld } from "./native-runner-ownership.js";
import { preserveNativeFailedWorkspace } from "./native-failed-workspace-recovery.js";
import { settleNativeTerminalWake } from "./native-run-projection.js";
import { notifyNativeStatusReassessment } from "../native-status-reassessment-notifications.js";
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults, workspaceOperations, type Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { adapterExecutionControls } from "../adapter-execution-control.js";
import { logActivity, persistActivity, publishActivity, type ActivityPublication } from "../activity-log.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";
import { notifyExecutionRunWork } from "../execution-control-notifications.js";
import { readProcessStartedAt } from "../hot-restart.js";
import { notifyNativeFinalizationWork } from "../native-finalization-notifications.js";
import { LEGACY_WORKSPACE_RECOVERY_KEY } from "../workspace-restore-recovery-state.js";
import { activeNativeExecutionRunIds } from "./native-active-runs.js";
import { isCurrentNativeControllerProcess } from "./native-restart-recovery.js";

/**
 * A native run can fail outside the native session executor: environment lease
 * acquisition, runner state verification, or any other step before the
 * executor takes its own provider claim. The heartbeat failure path then marks
 * the run failed but never sees the finalization row, so the claim that
 * dispatched the run keeps `observed` ownership. That owner blocks agent stop
 * checks and keeps the task looking like it still has a live recovery path.
 *
 * This module settles those rows to `terminal_failure`, the state the executor
 * itself writes for a failure it observes. Run status alone is never enough:
 * each path below also proves that no provider work can still be running under
 * the owner it releases.
 */

const RELEASABLE_RUN_STATUSES = ["failed", "timed_out", "interrupted"];
const FALLBACK_FAILURE_CODE = "native_session_resume_failed";
const NEXT_ACTION = "The run ended before it could resume its native provider session. Inspect the run failure, then explicitly retry the task.";
const ACTOR_ID = "native-finalization-owner-release";

type Run = typeof heartbeatRuns.$inferSelect;
type Coordinator = typeof nativeRunFinalizations.$inferSelect;
type Release =
  /** The caller dispatched this claim and its execution has returned. */
  | { kind: "unstarted_resume"; runId: string; leaseOwner: string; attempt: number }
  /** A background pass found an expired owner and must prove it stopped. */
  | { kind: "expired_owner"; runId: string; leaseOwner: string; attempt: number; controllerGeneration: number }
  | { kind: "operator_containment"; runId: string; leaseOwner: string; attempt: number;
      companyId: string; issueId: string; actionId: string; authorityDigest: string; actorId: string; controllerGeneration: number;
      actionOutcome: ExecutionReconciliation["actionOutcome"]; outcomeEvidence: string };

/** Environment leases that `agentExecutionsHaveStopped` would still treat as live. */
const unsettledRunEnvironmentLease = sql`exists (
  select 1 from ${environmentLeases} lease
  where lease.company_id = ${heartbeatRuns.companyId}
    and lease.heartbeat_run_id = ${heartbeatRuns.id}
    and ((lease.released_at is null and not (lease.status = 'retained' and lease.cleanup_status = 'success'))
      or lease.status = 'pending_cleanup' or lease.cleanup_status = 'failed')
)`;

/** A pending Stop belongs to native restart recovery's stop cleanup. */
const pendingNativeStop = sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) #>> '{nativeCancellation,dispatchState}' = 'pending'`;

/**
 * Rows the background pass may release once their lease expires. A pinned
 * workspace restore belongs to observed-workspace preservation, which must stop
 * and retain the sandbox before it settles the same row.
 */
function abandonedOwnerCondition() {
  return and(
    eq(heartbeatRuns.runtimeMode, "native"),
    inArray(heartbeatRuns.status, RELEASABLE_RUN_STATUSES),
    eq(nativeRunFinalizations.phase, "observed"),
    isNull(nativeRunFinalizations.resultId),
    isNotNull(nativeRunFinalizations.leaseOwner),
    isNotNull(nativeRunFinalizations.leaseExpiresAt),
    sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) -> ${LEGACY_WORKSPACE_RECOVERY_KEY}::text is null`,
    sql`not coalesce(${pendingNativeStop}, false)`,
    sql`not ${unsettledRunEnvironmentLease}`,
  )!;
}

/**
 * The earliest lease expiry the background pass will need to inspect. Sandbox
 * cleanup is excluded, so an unreleased lease is never polled for here. An
 * expired row whose process or controller may still be live keeps the shared
 * finalization retry cadence until that process exits.
 */
export async function nextAbandonedNativeOwnerReleaseAt(db: Db): Promise<Date | null> {
  const [row] = await db.select({ at: nativeRunFinalizations.leaseExpiresAt }).from(nativeRunFinalizations)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, nativeRunFinalizations.runId),
      eq(heartbeatRuns.companyId, nativeRunFinalizations.companyId)))
    .where(abandonedOwnerCondition())
    .orderBy(asc(nativeRunFinalizations.leaseExpiresAt)).limit(1);
  return row?.at ?? null;
}

function processAbsent(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

/** True unless the recorded process is gone or provably a different process. */
async function recordedProcessMayBeLive(pid: number | null, startedAt: Date | null): Promise<boolean> {
  if (!pid || processAbsent(pid)) return false;
  if (!startedAt) return true;
  const observed = await readProcessStartedAt(pid).catch(() => null);
  return !observed || new Date(observed).getTime() === startedAt.getTime();
}

/**
 * The run-level process evidence `agentExecutionsHaveStopped` requires. This
 * process answers for itself from its in-memory execution registries.
 */
async function runProcessMayBeLive(run: Run, now: Date): Promise<boolean> {
  if (adapterExecutionControls.has(run.id) || activeNativeExecutionRunIds.has(run.id)) return true;
  if (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > now) return true;
  // Same process identity rule as `agentExecutionsHaveStopped`: a recorded PID
  // that now has another start time was recycled, and so was its own group.
  let processAlive = Boolean(run.processPid && !processAbsent(run.processPid));
  let groupAlive = Boolean(run.processGroupId && !processAbsent(-run.processGroupId));
  if (processAlive && run.processStartedAt) {
    const observed = await readProcessStartedAt(run.processPid!).catch(() => null);
    if (observed && new Date(observed).getTime() !== run.processStartedAt.getTime()) {
      processAlive = false;
      if (run.processGroupId === run.processPid) groupAlive = false;
    }
  }
  return processAlive || groupAlive;
}

/** An expired owner's recorded controller, unless this process is that controller. */
async function controllerMayBeLive(coordinator: Coordinator): Promise<boolean> {
  if (isCurrentNativeControllerProcess(coordinator)) return false;
  // A previous boot of this process can share its PID, but cannot be its controller.
  if (coordinator.controllerPid === process.pid) return false;
  return recordedProcessMayBeLive(coordinator.controllerPid, coordinator.controllerProcessStartedAt);
}

async function settleFailedRunOwner(db: Db, release: Release, now: Date): Promise<boolean> {
  const publications: ActivityPublication[] = [];
  const settled = await db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    await tx.execute(sql`select set_config('statement_timeout', '15000', true), set_config('lock_timeout', '1000', true)`);
    const [binding] = await tx.select({ companyId: nativeRunFinalizations.companyId, issueId: nativeRunFinalizations.issueId })
      .from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, release.runId));
    if (!binding) return false;
    // Same issue-before-coordinator-before-run order as admission and failure settlement.
    const [task] = await tx.select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId,
      status: issues.status, executionRunId: issues.executionRunId, checkoutRunId: issues.checkoutRunId }).from(issues).where(and(eq(issues.companyId, binding.companyId),
      eq(issues.id, binding.issueId))).for("update");
    const [coordinator] = await tx.select().from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.companyId, binding.companyId), eq(nativeRunFinalizations.runId, release.runId),
      eq(nativeRunFinalizations.issueId, binding.issueId))).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, binding.companyId), eq(heartbeatRuns.id, release.runId))).for("update");
    if (!coordinator || !run || run.runtimeMode !== "native"
      || !(RELEASABLE_RUN_STATUSES.includes(run.status) || (release.kind === "operator_containment" && run.status === "running"))
      || !(coordinator.phase === "observed" || (release.kind === "operator_containment" && coordinator.phase === "retryable_failure"))
      || coordinator.resultId !== null
      || coordinator.leaseOwner !== release.leaseOwner || coordinator.attempt !== release.attempt) return false;
    let containedExpiryEpoch: string | null = null;
    if (release.kind === "operator_containment") {
      const [action] = await tx.select().from(issueRecoveryActions).where(and(
        eq(issueRecoveryActions.companyId, release.companyId), eq(issueRecoveryActions.sourceIssueId, release.issueId),
        eq(issueRecoveryActions.id, release.actionId))).for("update");
      const [expiry] = await tx.select({ epoch: sql<string | null>`extract(epoch from ${nativeRunFinalizations.leaseExpiresAt})::numeric::text` })
        .from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, run.id));
      const authority = action?.evidence.controllerAuthority;
      const recordedDigest = authority && typeof authority === "object" && !Array.isArray(authority)
        && (authority as Record<string, unknown>).schema === "paperclip.native-controller-authority.v1"
        ? (authority as Record<string, unknown>).digest : null;
      if (!["completed", "not_performed", "mixed"].includes(release.actionOutcome)
        || release.outcomeEvidence.trim().length < 20 || release.outcomeEvidence.length > 12_000
        || !task || !action || action.kind !== "active_run_watchdog" || action.ownerType !== "board"
        || !["active", "escalated"].includes(action.status) || action.cause !== "native_restart_recovery_blocked"
        || action.fingerprint !== `native-controller-space:${run.id}:${release.authorityDigest}` || action.evidence.runId !== run.id
        || action.evidence.reason !== "controller_process_space_unverified"
        || recordedDigest !== release.authorityDigest || !expiry
        || nativeControllerAuthorityDigest(coordinator, expiry.epoch) !== release.authorityDigest
        || coordinator.companyId !== release.companyId || coordinator.issueId !== release.issueId
        || action.returnOwnerAgentId !== run.agentId || task.assigneeAgentId !== run.agentId
        || ["done", "cancelled"].includes(task.status) || task.executionRunId !== run.id
        || (task.checkoutRunId !== null && task.checkoutRunId !== run.id)
        || !coordinator.leaseExpiresAt || coordinator.leaseExpiresAt > now
        || coordinator.leaseOwner?.startsWith("native-finalizer:") || coordinator.leaseOwner?.startsWith("native-cleanup:")
        || coordinator.failureDetail?.successorRunId || isCurrentNativeControllerProcess(coordinator)
        || isNativeRunnerOwnershipHeld(run) || (run.controllerLeaseExpiresAt !== null && run.controllerLeaseExpiresAt > now)
        || run.runnerProfileJson?.nativeWorkspaceSync != null || run.runnerProfileJson?.remoteWorkspace != null
        || run.runnerProfileJson?.nativeControllerRecovery != null
        || run.resultJson?.[LEGACY_WORKSPACE_RECOVERY_KEY] != null
        || adapterExecutionControls.has(run.id) || activeNativeExecutionRunIds.has(run.id)) return false;
      const [heldElsewhere] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.id, run.id), or(unsettledRunEnvironmentLease, pendingNativeStop))).limit(1);
      const [work] = await tx.select({ id: workspaceOperations.id }).from(workspaceOperations).where(and(
        eq(workspaceOperations.companyId, run.companyId), eq(workspaceOperations.heartbeatRunId, run.id),
        inArray(workspaceOperations.status, ["queued", "running"]))).limit(1);
      if (heldElsewhere || work) return false;
      containedExpiryEpoch = expiry.epoch;
      // The explicit original-host controller+provider attestation replaces a
      // meaningless local PID observation only in this exact authority branch.
    } else if (release.kind === "expired_owner") {
      if (!coordinator.leaseExpiresAt || coordinator.leaseExpiresAt > now
        || coordinator.controllerGeneration !== release.controllerGeneration
        || run.resultJson?.[LEGACY_WORKSPACE_RECOVERY_KEY] != null) return false;
      // An expired lease does not make foreign PID numbers local evidence.
      // Keep this boot's exact owner semantics; every other owner needs the
      // same known kernel/PID space before either recorded-process probe.
      if (!isCurrentNativeControllerProcess(coordinator)) {
        const current = await currentControllerProcess();
        if (current.hostHash === "unknown" || coordinator.controllerHostHash !== current.hostHash) return false;
      }
      const [heldElsewhere] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.id, run.id), or(unsettledRunEnvironmentLease, pendingNativeStop))).limit(1);
      if (heldElsewhere || await runProcessMayBeLive(run, now) || await controllerMayBeLive(coordinator)) return false;
    } else if (await runProcessMayBeLive(run, now)) {
      // The claim never reached the executor, but the run may still own a local process.
      return false;
    }
    const [accepted] = await tx.select({ id: nativeRunResults.id }).from(nativeRunResults).where(and(
      eq(nativeRunResults.companyId, run.companyId), eq(nativeRunResults.runId, run.id),
      eq(nativeRunResults.schemaStatus, "accepted"))).limit(1);
    if (accepted) return false;

    const failureCode = release.kind === "operator_containment" ? "native_restart_recovery_blocked"
      : coordinator.failureCode ?? run.errorCode ?? FALLBACK_FAILURE_CODE;
    const scope = { companyId: run.companyId, agentId: run.agentId, runId: run.id, issueId: coordinator.issueId };
    await notifyExecutionRunWork(tx, scope);
    await notifyNativeFinalizationWork(tx, scope);
    // A result-less `observed` owner holds pending cost accounting; settlement releases it.
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.accounting, run.companyId);
    const [updated] = await tx.update(nativeRunFinalizations).set({
      phase: "terminal_failure",
      leaseOwner: null,
      leaseExpiresAt: null,
      controlDeadlineAt: null,
      nextAttemptAt: null,
      recoveryState: "blocked",
      failureCode,
      failureDetail: {
        ...coordinator.failureDetail,
        ...(run.error ? { message: run.error.slice(0, 2_000) } : {}),
        originalFailureCode: run.errorCode ?? failureCode,
        releasedOwner: release.kind === "operator_containment"
          ? { reason: release.kind, authorityDigest: release.authorityDigest, attempt: release.attempt,
              actorId: release.actorId, recordedAt: now.toISOString(), controllerStopped: true, providerStopped: true,
              actionOutcome: release.actionOutcome, outcomeEvidence: release.outcomeEvidence,
              priorProcess: { pid: run.processPid, groupId: run.processGroupId, startedAt: run.processStartedAt?.toISOString() ?? null } }
          : { reason: release.kind, leaseOwner: release.leaseOwner, attempt: release.attempt },
        recoveryOwner: { kind: "board" },
        nextAction: NEXT_ACTION,
      },
      updatedAt: now,
    }).where(and(
      eq(nativeRunFinalizations.runId, run.id),
      eq(nativeRunFinalizations.phase, release.kind === "operator_containment" ? coordinator.phase : "observed"),
      isNull(nativeRunFinalizations.resultId),
      eq(nativeRunFinalizations.leaseOwner, release.leaseOwner),
      eq(nativeRunFinalizations.attempt, release.attempt),
      release.kind === "operator_containment" ? and(
        eq(nativeRunFinalizations.controllerGeneration, release.controllerGeneration),
        sql`extract(epoch from ${nativeRunFinalizations.leaseExpiresAt})::numeric::text = ${containedExpiryEpoch}`,
        coordinator.controllerHostHash === null ? isNull(nativeRunFinalizations.controllerHostHash)
          : eq(nativeRunFinalizations.controllerHostHash, coordinator.controllerHostHash),
      ) : undefined,
    )).returning({ runId: nativeRunFinalizations.runId });
    if (!updated) return false;
    const [settledRun] = await tx.update(heartbeatRuns).set({ nativePhase: "terminal_failure", nativePhaseUpdatedAt: now, updatedAt: now,
      ...(release.kind === "operator_containment" ? { status: "failed", finishedAt: now,
        errorCode: failureCode, error: "The original controller and provider were contained by a board operator. Review the recorded action outcomes before explicitly retrying.",
        processPid: null, processGroupId: null, processStartedAt: null, executionControlDeadlineAt: null } : {}),
    }).where(eq(heartbeatRuns.id, run.id)).returning();
    if (release.kind === "operator_containment" && settledRun) {
      await preserveNativeFailedWorkspace(tx, settledRun);
      await settleNativeTerminalWake(tx, settledRun);
      await notifyNativeStatusReassessment(tx, scope);
      // Durable activity only: this call may be a savepoint of board resolution,
      // so publishing a live event here would precede the outer commit.
      await persistActivity(tx, { companyId: run.companyId, actorType: "user", actorId: release.actorId,
        action: "native.controller_containment_recorded", entityType: "heartbeat_run", entityId: run.id,
        agentId: run.agentId, runId: run.id, details: { recoveryActionId: release.actionId,
          authorityDigest: release.authorityDigest, replay: "not_authorized" } });
      return true;
    }
    await logActivity(tx, {
      companyId: run.companyId, actorType: "system", actorId: ACTOR_ID,
      action: "native.failed_run_owner_released", entityType: "heartbeat_run", entityId: run.id,
      agentId: run.agentId, runId: run.id, issueId: coordinator.issueId,
      details: { reason: release.kind, runStatus: run.status, failureCode, attempt: release.attempt,
        controllerGeneration: coordinator.controllerGeneration },
    }, publications);
    return true;
  });
  for (const publication of publications) publishActivity(publication);
  return settled;
}

/**
 * Settles a session-resume claim whose dispatched execution returned without
 * the native executor ever taking its own provider claim. The executor bumps
 * the coordinator attempt when it claims, so an unchanged attempt proves no
 * provider turn started under this owner. Failures that reach the executor's
 * claim are settled by the executor and no longer match.
 */
export async function settleUnstartedNativeSessionResume(db: Db, claim: {
  runId: string; leaseOwner: string; attempt: number;
}): Promise<boolean> {
  return settleFailedRunOwner(db, { kind: "unstarted_resume", ...claim }, new Date()).catch((error: unknown) => {
    logger.warn({ err: error, runId: claim.runId },
      "Native session resume owner release failed; the abandoned owner pass will release it after lease expiry");
    return false;
  });
}

let abandonedOwnerReleaseCursor: string | null = null;

export function resetAbandonedNativeOwnerReleaseForTests() {
  abandonedOwnerReleaseCursor = null;
}

/**
 * Releases expired, result-less owners left on native runs that already ended
 * failed, timed out, or interrupted. Each release re-proves under row locks that
 * the run's environment leases are settled and that neither its process nor its
 * controller may still be running. Cancelled runs keep their own stop-proof path
 * in `agentExecutionsHaveStopped`.
 */
export async function releaseAbandonedNativeOwners(db: Db, now = new Date(), pageSize = 50): Promise<number> {
  // One bounded page per pass. The cursor rotates across passes, so rows that a
  // live process still holds cannot starve stopped owners behind them; any
  // remaining expired row keeps the finalization deadline due for the next pass.
  const page = (after: string | null) => db.select({
    runId: nativeRunFinalizations.runId,
    leaseOwner: nativeRunFinalizations.leaseOwner,
    attempt: nativeRunFinalizations.attempt,
    controllerGeneration: nativeRunFinalizations.controllerGeneration,
  }).from(nativeRunFinalizations)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, nativeRunFinalizations.runId),
      eq(heartbeatRuns.companyId, nativeRunFinalizations.companyId)))
    .where(and(abandonedOwnerCondition(), lte(nativeRunFinalizations.leaseExpiresAt, now),
      after ? gt(nativeRunFinalizations.runId, after) : undefined))
    .orderBy(asc(nativeRunFinalizations.runId))
    .limit(pageSize);
  let candidates = await page(abandonedOwnerReleaseCursor);
  if (candidates.length === 0 && abandonedOwnerReleaseCursor !== null) candidates = await page(null);
  abandonedOwnerReleaseCursor = candidates.length === pageSize ? candidates[candidates.length - 1]!.runId : null;
  let released = 0;
  for (const candidate of candidates) {
    try {
      if (await settleFailedRunOwner(db, { kind: "expired_owner", runId: candidate.runId,
        leaseOwner: candidate.leaseOwner!, attempt: candidate.attempt,
        controllerGeneration: candidate.controllerGeneration }, now)) released += 1;
    } catch (error) {
      logger.warn({ err: error, runId: candidate.runId },
        "Abandoned native owner release remains pending; continuing with other runs");
    }
  }
  return released;
}

/** This entry is called only by the board-authorized reconciliation owner.
 * Its opaque authority is reloaded and checked under the normal settlement
 * locks; the operator receipt never becomes a fabricated provider result. */
export async function settleOperatorContainedNativeOwner(db: Db, input: {
  companyId: string; issueId: string; runId: string; actionId: string;
  authorityDigest: string; actorId: string;
  actionOutcome: ExecutionReconciliation["actionOutcome"]; outcomeEvidence: string;
}): Promise<boolean> {
  const [owner] = await db.select().from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, input.companyId), eq(nativeRunFinalizations.issueId, input.issueId),
    eq(nativeRunFinalizations.runId, input.runId)));
  if (!owner?.leaseOwner) return false;
  return settleFailedRunOwner(db, { kind: "operator_containment", ...input,
    leaseOwner: owner.leaseOwner, attempt: owner.attempt, controllerGeneration: owner.controllerGeneration }, new Date());
}
