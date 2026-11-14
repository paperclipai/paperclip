import { currentProcessSpaceHash } from "../controller-process-identity.js";
import type { ExecutionReconciliation } from "@paperclipai/shared";
import { nativeControllerAuthorityDigest, readNativeRemoteExecutionOwnership, isNativeRunnerOwnershipHeld } from "./native-runner-ownership.js";
import { preserveNativeFailedWorkspace } from "./native-failed-workspace-recovery.js";
import { settleNativeTerminalWake } from "./native-run-projection.js";
import { notifyNativeStatusReassessment } from "../native-status-reassessment-notifications.js";
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { activityLog, environmentLeases, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults, workspaceOperations, type Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { adapterExecutionControls } from "../adapter-execution-control.js";
import { proveOwnerGone, type LocalOwnerStamp } from "../owner-proof.js";
import { logActivity, persistActivity, publishActivity, type ActivityPublication } from "../activity-log.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";
import { notifyExecutionRunWork } from "../execution-control-notifications.js";
import { notifyNativeFinalizationWork } from "../native-finalization-notifications.js";
import { LEGACY_WORKSPACE_RECOVERY_KEY } from "../workspace-restore-recovery-state.js";
import { activeNativeExecutionRunIds } from "./native-active-runs.js";
import { currentNativeControllerIdentity, isCurrentNativeControllerProcess, surfaceNativeControllerNamespaceAttention, recordLegacyHostFallbackProof } from "./native-restart-recovery.js";
import { nativeControllerOwnerStamp, runProcessOwnerStamp } from "./native-owner-stamps.js";

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

/** Local owners retain their release deadline. Foreign owners retain the same
 * original deadline until expiry surfaces attention owned by the board. */
async function localOwnerSpaceCondition() {
  const processSpace = currentProcessSpaceHash();
  const native = await currentNativeControllerIdentity();
  return or(
    and(eq(nativeRunFinalizations.controllerBootId, native.bootId), eq(nativeRunFinalizations.controllerPid, native.pid)),
    processSpace !== "unknown" ? eq(nativeRunFinalizations.controllerHostHash, processSpace) : sql`false`,
  )!;
}

export async function nextAbandonedNativeOwnerReleaseAt(db: Db): Promise<Date | null> {
  // A finite remaining inspection page is work; a surfaced foreign owner is not
  // a timer. The existing cursor is cleared after the last lookahead page.
  if (abandonedOwnerReleaseCursor !== null) return new Date();
  const local = await localOwnerSpaceCondition();
  // Notifications can coalesce while a partial page advances. A lower-sorting
  // arrival without any active attention remains durable inspection work, so
  // completing the higher pages cannot consume its only wake.
  const [unattended] = await db.select({ at: nativeRunFinalizations.leaseExpiresAt }).from(nativeRunFinalizations)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, nativeRunFinalizations.runId),
      eq(heartbeatRuns.companyId, nativeRunFinalizations.companyId)))
    .where(and(abandonedOwnerCondition(), sql`not coalesce(${local}, false)`,
      sql`${nativeRunFinalizations.leaseOwner} not like 'native-finalizer:%'`,
      sql`${nativeRunFinalizations.leaseOwner} not like 'native-cleanup:%'`,
      sql`not exists (select 1 from ${issueRecoveryActions} attention
        where attention.company_id = ${nativeRunFinalizations.companyId}
          and attention.source_issue_id = ${nativeRunFinalizations.issueId}
          and attention.status in ('active', 'escalated'))`,
    )).orderBy(asc(nativeRunFinalizations.leaseExpiresAt)).limit(1);
  const [row] = await db.select({ at: nativeRunFinalizations.leaseExpiresAt }).from(nativeRunFinalizations)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, nativeRunFinalizations.runId),
      eq(heartbeatRuns.companyId, nativeRunFinalizations.companyId)))
    .where(and(abandonedOwnerCondition(), sql`coalesce(${local}, false)`))
    .orderBy(asc(nativeRunFinalizations.leaseExpiresAt)).limit(1);
  if (!unattended?.at) return row?.at ?? null;
  if (!row?.at) return unattended.at;
  return unattended.at < row.at ? unattended.at : row.at;
}

/** A proof that used the one-release fallback for a row saved before its PID
 * space was recorded; each is logged once the release commits. */
type FallbackUse = { reason: string; source: string };

/** True unless the shared prover proves the stamped owner gone. Only a `gone`
 * verdict releases: a live, unprovable or foreign-space owner may be live. */
async function ownerMayBeLive(stamp: LocalOwnerStamp, source: string, fallbacks: FallbackUse[]): Promise<boolean> {
  const proof = await proveOwnerGone(stamp);
  if (proof.verdict !== "gone") return true;
  if (proof.legacyHostFallback) fallbacks.push({ reason: proof.reason, source });
  return false;
}

/**
 * The run-level process evidence `agentExecutionsHaveStopped` requires. This
 * process answers for itself from its in-memory execution registries; a
 * recorded adapter process (PID and group) is judged by the shared prover.
 */
async function runProcessMayBeLive(run: Run, now: Date, fallbacks: FallbackUse[]): Promise<boolean> {
  if (adapterExecutionControls.has(run.id) || activeNativeExecutionRunIds.has(run.id)) return true;
  if (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > now) return true;
  if (!run.processPid && !run.processGroupId) return false;
  return ownerMayBeLive(runProcessOwnerStamp(run, "native_failed_run_process", { legacyFallback: true }),
    "native_failed_run_process", fallbacks);
}

/** An expired owner's recorded controller, unless this process is that controller. */
async function controllerMayBeLive(coordinator: Coordinator, fallbacks: FallbackUse[]): Promise<boolean> {
  if (isCurrentNativeControllerProcess(coordinator)) return false;
  // A previous boot of this process can share its PID, but cannot be its controller.
  if (coordinator.controllerPid === process.pid) return false;
  if (!coordinator.controllerPid) return false;
  // Not this boot (checked above), so the prover must not treat its boot id as live.
  return ownerMayBeLive({ ...nativeControllerOwnerStamp(coordinator, "native_failed_run_controller"), bootId: null },
    "native_failed_run_controller", fallbacks);
}

async function settleFailedRunOwner(db: Db, release: Release, now: Date): Promise<boolean> {
  const publications: ActivityPublication[] = [];
  const settled = await db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const fallbacks: FallbackUse[] = [];
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
        || ["done", "cancelled"].includes(task.status)
        || (task.executionRunId !== run.id && !(task.executionRunId === null && RELEASABLE_RUN_STATUSES.includes(run.status)))
        || (task.checkoutRunId !== null && task.checkoutRunId !== run.id)
        || !coordinator.leaseExpiresAt || coordinator.leaseExpiresAt > now
        || coordinator.leaseOwner?.startsWith("native-finalizer:") || coordinator.leaseOwner?.startsWith("native-cleanup:")
        || coordinator.failureDetail?.successorRunId || isCurrentNativeControllerProcess(coordinator)
        || isNativeRunnerOwnershipHeld(run) || (run.controllerLeaseExpiresAt !== null && run.controllerLeaseExpiresAt > now)
        || run.runnerProfileJson?.nativeWorkspaceSync != null || run.runnerProfileJson?.remoteWorkspace != null
        || run.runnerProfileJson?.nativeControllerRecovery != null
        || run.resultJson?.[LEGACY_WORKSPACE_RECOVERY_KEY] != null
        || adapterExecutionControls.has(run.id) || activeNativeExecutionRunIds.has(run.id)) return false;
      if (task.executionRunId === null) {
        // Issue lock serializes admission. A cleared failure pointer does not
        // authorize containment of an older/replaced source.
        const [newer] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
          eq(heartbeatRuns.companyId, run.companyId),
          or(eq(heartbeatRuns.nativeIssueId, coordinator.issueId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${coordinator.issueId}`,
            sql`exists (select 1 from ${nativeRunFinalizations} newer_owner
              where newer_owner.run_id = ${heartbeatRuns.id} and newer_owner.company_id = ${run.companyId}
                and newer_owner.issue_id = ${coordinator.issueId})`),
          ne(heartbeatRuns.id, run.id),
          sql`${heartbeatRuns.createdAt} >= (select source.created_at from ${heartbeatRuns} source
            where source.id = ${run.id} and source.company_id = ${run.companyId})`,
        )).limit(1);
        if (newer) return false;
      }
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
      if (!coordinator.leaseExpiresAt || coordinator.controllerGeneration !== release.controllerGeneration
        || run.resultJson?.[LEGACY_WORKSPACE_RECOVERY_KEY] != null
        || coordinator.leaseExpiresAt > now) return false;
      // An expired lease does not make foreign PID numbers local evidence.
      // Keep this boot's exact owner semantics; every other owner needs the
      // same known kernel/PID space before either recorded-process probe.
      if (!isCurrentNativeControllerProcess(coordinator)) {
        const current = currentProcessSpaceHash();
        if (current === "unknown" || coordinator.controllerHostHash !== current) {
          if (!coordinator.leaseOwner?.startsWith("native-finalizer:") && !coordinator.leaseOwner?.startsWith("native-cleanup:")) {
            const [expiry] = await tx.select({ epoch: sql<string | null>`extract(epoch from ${nativeRunFinalizations.leaseExpiresAt})::numeric::text` })
              .from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, run.id));
            const { remoteProcess } = await readNativeRemoteExecutionOwnership(tx, { run, issueId: coordinator.issueId });
            await surfaceNativeControllerNamespaceAttention(tx, { run, coordinator, expiryEpoch: expiry?.epoch ?? null, remoteProcess });
          }
          return false;
        }
      }
      const [heldElsewhere] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.id, run.id), or(unsettledRunEnvironmentLease, pendingNativeStop))).limit(1);
      if (heldElsewhere || await runProcessMayBeLive(run, now, fallbacks)
        || await controllerMayBeLive(coordinator, fallbacks)) return false;
    } else if (await runProcessMayBeLive(run, now, fallbacks)) {
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
          ? { schema: "paperclip.native-controller-containment.v1", reason: release.kind, actionId: release.actionId,
              controllerGeneration: coordinator.controllerGeneration, controllerBootId: coordinator.controllerBootId,
              controllerHostHash: coordinator.controllerHostHash, authorityDigest: release.authorityDigest, attempt: release.attempt,
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
    for (const use of fallbacks) {
      await recordLegacyHostFallbackProof(tx, run, { allowed: true, reason: use.reason, legacyHostFallback: true }, use.source);
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
    .limit(pageSize + 1);
  const rows = await page(abandonedOwnerReleaseCursor);
  const candidates = rows.slice(0, pageSize);
  abandonedOwnerReleaseCursor = rows.length > pageSize ? candidates[candidates.length - 1]!.runId : null;
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

/** Committed operator evidence is a separate authority from an observed local
 * stop. It permits only a new, independently authorized Retry of this source;
 * it never proves a PID was observed dead or admits provider replay. */
export async function hasCommittedNativeControllerContainment(
  db: Pick<Db, "select">,
  run: Run,
  issueId: string,
): Promise<boolean> {
  if (run.runtimeMode !== "native" || run.nativeIssueId !== issueId || run.status !== "failed"
    || run.nativePhase !== "terminal_failure" || !run.finishedAt
    || run.errorCode !== "native_restart_recovery_blocked"
    || run.processPid !== null || run.processGroupId !== null || run.processStartedAt !== null
    || adapterExecutionControls.has(run.id) || activeNativeExecutionRunIds.has(run.id)
    || (run.controllerLeaseExpiresAt !== null && run.controllerLeaseExpiresAt > new Date())
    || run.runnerProfileJson?.nativeWorkspaceSync != null || run.runnerProfileJson?.remoteWorkspace != null
    || run.runnerProfileJson?.nativeControllerRecovery != null
    || run.resultJson?.[LEGACY_WORKSPACE_RECOVERY_KEY] != null) return false;
  const [task] = await db.select().from(issues).where(and(eq(issues.companyId, run.companyId),
    eq(issues.id, issueId))).for("share", { noWait: true });
  if (!task || task.assigneeAgentId !== run.agentId || ["done", "cancelled"].includes(task.status)) return false;
  // This is a committed source-containment fact, not admission authority.
  // Existing chat/queue owners separately bind current checkout/execution and
  // the exact admitted successor; a legitimate successor does not undo the
  // source's original-host containment.
  const [owner] = await db.select().from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, run.companyId), eq(nativeRunFinalizations.issueId, issueId),
    eq(nativeRunFinalizations.runId, run.id))).for("share", { noWait: true });
  if (!owner || owner.phase !== "terminal_failure" || owner.recoveryState !== "blocked"
    || owner.failureCode !== "native_restart_recovery_blocked" || owner.leaseOwner || owner.leaseExpiresAt
    || owner.nextAttemptAt || owner.resultId || owner.assessmentId || owner.decisionId
    || owner.failureDetail?.successorRunId) return false;
  const value = owner.failureDetail?.releasedOwner;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  if (receipt.schema !== "paperclip.native-controller-containment.v1" || receipt.reason !== "operator_containment"
    || typeof receipt.actionId !== "string" || typeof receipt.authorityDigest !== "string"
    || !/^[a-f0-9]{64}$/.test(receipt.authorityDigest)
    || receipt.attempt !== owner.attempt || receipt.controllerGeneration !== owner.controllerGeneration
    || receipt.controllerBootId !== owner.controllerBootId || receipt.controllerHostHash !== owner.controllerHostHash
    || receipt.controllerStopped !== true || receipt.providerStopped !== true
    || !["completed", "not_performed", "mixed"].includes(String(receipt.actionOutcome))
    || typeof receipt.outcomeEvidence !== "string" || receipt.outcomeEvidence.trim().length < 20
    || receipt.outcomeEvidence.length > 12_000 || typeof receipt.actorId !== "string" || !receipt.actorId
    || typeof receipt.recordedAt !== "string" || !Number.isFinite(Date.parse(receipt.recordedAt))) return false;
  const [action] = await db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, run.companyId), eq(issueRecoveryActions.sourceIssueId, issueId),
    eq(issueRecoveryActions.id, receipt.actionId))).for("share", { noWait: true });
  const authority = action?.evidence.controllerAuthority;
  const decision = action?.evidence.executionReconciliation;
  if (!action || action.kind !== "active_run_watchdog" || action.ownerType !== "board"
    || action.status !== "resolved" || action.outcome !== "restored" || !action.resolvedAt
    || action.returnOwnerAgentId !== run.agentId || action.cause !== "native_restart_recovery_blocked"
    || action.fingerprint !== `native-controller-space:${run.id}:${receipt.authorityDigest}`
    || action.evidence.runId !== run.id || action.evidence.reason !== "controller_process_space_unverified"
    || action.evidence.continuationDelivery !== "not_requested"
    || !authority || typeof authority !== "object" || Array.isArray(authority)
    || !("schema" in authority) || authority.schema !== "paperclip.native-controller-authority.v1"
    || !("digest" in authority) || authority.digest !== receipt.authorityDigest
    || !decision || typeof decision !== "object" || Array.isArray(decision)) return false;
  const reconciliation = decision as Record<string, unknown>;
  if (reconciliation.runId !== run.id || reconciliation.controllerStopped !== true || reconciliation.providerStopped !== true
    || reconciliation.controllerAuthorityDigest !== receipt.authorityDigest || reconciliation.actorId !== receipt.actorId
    || reconciliation.actionOutcome !== receipt.actionOutcome || reconciliation.outcomeEvidence !== receipt.outcomeEvidence) return false;
  const [audit] = await db.select({ id: activityLog.id }).from(activityLog).where(and(
    eq(activityLog.companyId, run.companyId), eq(activityLog.entityType, "heartbeat_run"),
    eq(activityLog.entityId, run.id), eq(activityLog.actorType, "user"), eq(activityLog.actorId, receipt.actorId),
    eq(activityLog.action, "native.controller_containment_recorded"),
    sql`${activityLog.details}->>'recoveryActionId' = ${action.id}`,
    sql`${activityLog.details}->>'authorityDigest' = ${receipt.authorityDigest}`,
    sql`${activityLog.details}->>'replay' = 'not_authorized'`)).limit(1);
  if (!audit) return false;
  const [blocked] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id),
    or(unsettledRunEnvironmentLease, pendingNativeStop))).limit(1);
  const [accepted] = await db.select({ id: nativeRunResults.id }).from(nativeRunResults).where(and(
    eq(nativeRunResults.companyId, run.companyId), eq(nativeRunResults.runId, run.id),
    eq(nativeRunResults.schemaStatus, "accepted"))).limit(1);
  const [work] = await db.select({ id: workspaceOperations.id }).from(workspaceOperations).where(and(
    eq(workspaceOperations.companyId, run.companyId), eq(workspaceOperations.heartbeatRunId, run.id),
    inArray(workspaceOperations.status, ["queued", "running"]))).limit(1);
  const [remote] = await db.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
    eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
    ne(environmentLeases.provider, "local"))).limit(1);
  return !blocked && !accepted && !work && !remote;
}
