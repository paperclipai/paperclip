import { carriesInheritedRunnerIdentity } from "./native-inherited-runner-retry.js";
import { readPendingNativeRunStop } from "./native-cancellation-request.js";
import { CONTROLLER_LEASE_RENEW_MS } from "../controller-instance-lease.js";
import { currentControllerProcessStamp, UNKNOWN_PROCESS_SPACE } from "../controller-process-identity.js";
import { readNativeSessionResumptionAgent, restoreNativeSessionExecution } from "./native-session-resumption-admission.js";
import { notifyLiveRunRecovery } from "../live-run-recovery-notifications.js";
import { NATIVE_RETAINED_OWNER_WAIT } from "./native-controller-recovery.js";
import { notifyNativeEnvironmentSettlement } from "../native-environment-settlement-notifications.js";
import { remoteWorkspaceRunReferenceSchema } from "@paperclipai/shared";
import { notifyExternalAgentSettlement } from "../../modules/external-agents/index.js";
import { notifyNativeStatusReassessment } from "../native-status-reassessment-notifications.js";
import { notifyUnsafeWorkspaceExportRunChange } from "../unsafe-workspace-export-notifications.js";
import { notifyCancelledWorkspacePreservation } from "../cancelled-workspace-preservation-notifications.js";
import { notifyInstructionCollection } from "../instruction-collection-notifications.js";
import { notifyExecutionRunWork } from "../execution-control-notifications.js";
import { preserveNativeFailedWorkspace } from "./native-failed-workspace-recovery.js";
import { hasNativeRunnerCheckpoint, loadNativeRunnerCheckpointHeader,
  nativeRunnerCheckpointRemoteBootstrapProof } from "./native-runner-checkpoint.js";
import { resolveNativeStagedAttachmentRecovery, type NativeStagedAttachmentRecovery } from "./native-staged-attachment-recovery.js";
import { readNativeWorkspaceSyncReference } from "./native-workspace-sync.js";
import { activeNativeExecutionRunIds, NATIVE_PREPARATION_FENCING_VERSION } from "./native-active-runs.js";
import {
  PROCESS_IDENTITY_RECORDED,
  PROCESS_START_REQUESTED,
  recordNativeLocalProcessStopInTransaction,
} from "../native-local-process-stop.js";
import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import {
  agents,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  issueRecoveryActions,
  nativeRunFinalizations,
} from "@paperclipai/db";
import { REMOTE_CONTROLLER_LEASE_MS } from "./native-runner-recovery-contract.js";
import { PROVIDER_ATTEMPT_CREDIT_GENERATION_LIMIT, providerAttemptChargesBudget, providerAttemptWindowStart, readProviderAttemptOutcome } from "./provider-attempt-outcome.js";
import { readProcessStartedAt } from "../hot-restart.js";
import { currentProcessProbe, proveOwnerGone, type ProcessProbe } from "../owner-proof.js";
import { persistActivity } from "../activity-log.js";
import { OPERATOR_ATTESTED_CONTROLLER_HOST, requestNativeControllerStopConfirmation } from "./native-controller-host-recovery.js";
import { currentControllerBootId, currentProcessSpaceHash, currentProcessStartedAtMs, processStartsDefinitelyDiffer } from "../controller-process-identity.js";
import { getServerProcessStartedAt } from "../../server-info.js";
import { redactSensitiveText } from "../../redaction.js";
import { isUniqueViolation } from "../../db-errors.js";
import { logger } from "../../middleware/logger.js";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import { isNewTerminalRunFailure, reportRunFailure } from "../run-failure-report.js";
import { nativeControllerAuthorityDigest, isNativeRunnerOwnershipHeld, readNativeRemoteExecutionOwnership } from "./native-runner-ownership.js";
import { nativeRestartContinuationInFlight, nativeRestartInterruptedTurnId, type PersistedNativeSession } from "../../vendor/paperclip-runner/index.js";
import { retireSupersededNativeRetry } from "./native-superseded-retry.js";
import { legacyWorkspaceRecoveryNotMigrated } from "../legacy-workspace-recovery-migration.js";
import { requestNativeStartupCleanup, readNativeStartupContext, promoteNativeStartupCleanup } from "./native-startup-cleanup.js";
import { createSystemRecovery, failSystemRecovery, readSystemRecovery, reserveSystemRecoveryAttempt,
  SystemRecoveryFailure, type SystemRecoveryState } from "../system-recovery-state.js";

export type NativeControllerIdentity = {
  bootId: string;
  pid: number;
  processStartedAt: Date;
  /** PID space of `pid`; "unknown" when this host's space cannot be read,
   * which no later probe accepts. Optional for identities built in tests. */
  hostHash?: string;
};

export type NativeRestartKind = "hot" | "hard" | "graceful";

/** A recovery claim for one run failed unexpectedly and was deferred. */
export const NATIVE_RESTART_RECOVERY_FAILED = "restart_recovery_failed";

export const NATIVE_PROVIDER_RECOVERY_ATTEMPT_LIMIT = 3;

export type NativeRestartRecoveryClaim =
  | {
      kind: "reattach_existing_runner";
      runId: string;
      leaseOwner: string;
      controllerGeneration: number;
      providerAttempt: number;
      restartKind: NativeRestartKind;
      recoveryRequestId: string | null;
      process: {
        pid: number;
        processGroupId: number | null;
        startedAt: string;
      };
    }
  | {
      kind: "reattach_remote_runner";
      runId: string;
      leaseOwner: string;
      controllerGeneration: number;
      providerAttempt: number;
      restartKind: NativeRestartKind;
      recoveryRequestId: string | null;
      remote: { kind?: "sandbox"; providerLeaseId: string; remoteCwd: string }
        | { kind: "plugin_task"; leaseId: string };
      /** Discovery evidence only; executor revalidates the encrypted header. */
      stagedAttachment?: Pick<NativeStagedAttachmentRecovery, "sourceIdentity" | "targetIdentity" | "templateDigest">;
    }
  | {
      kind: "resume_dead_runner";
      runId: string;
      leaseOwner: string;
      controllerGeneration: number;
      providerAttempt: number;
      restartKind: NativeRestartKind;
      recoveryRequestId: string | null;
      /** False when the prior controller suspended this run in a clean drain. */
      chargesProviderAttempt?: boolean;
    }
  | {
      kind: "bootstrap_incomplete";
      runId: string;
      leaseOwner: string;
      controllerGeneration: number;
      providerAttempt: number;
      restartKind: NativeRestartKind;
      recoveryRequestId: string | null;
      /** False when the prior controller suspended this run in a clean drain. */
      chargesProviderAttempt?: boolean;
    };

export type NativeRestartRecoveryDisposition =
  | NativeRestartRecoveryClaim
  | {
      kind: "awaiting_evidence" | "blocked" | "already_finalized";
      runId: string;
      reason: string;
      retryAt?: Date;
      transitionUnchanged?: boolean;
    };

export function nextNativeProviderAttempt(
  currentAttempt: number,
  recoveryKind?: NativeRestartRecoveryClaim["kind"],
  chargesProviderAttempt = true,
): number {
  return !chargesProviderAttempt ||
    recoveryKind === "reattach_existing_runner" ||
    recoveryKind === "reattach_remote_runner"
    ? currentAttempt
    : currentAttempt + 1;
}

/**
 * The execution recovery budget bounds runs that keep failing their provider
 * turn. A graceful drain that suspended the run for reattachment is an
 * infrastructure restart the run did not cause, so the next controller's
 * resume of that turn does not spend an attempt. A crash (no drain record)
 * still charges one. The drain record is consumed by the next claim; waits for
 * ownership evidence or a deferred block in between do not erase it.
 */
const RECOVERY_CLAIM_DISPOSITIONS: ReadonlySet<unknown> = new Set<NativeRestartRecoveryClaim["kind"]>([
  "reattach_existing_runner", "reattach_remote_runner", "resume_dead_runner", "bootstrap_incomplete",
]);
export function suspendedByCleanDrain(coordinator: {
  attempt: number;
  recoveryHistory: ReadonlyArray<{ disposition?: unknown }>;
}): boolean {
  // Attempt 0 means no execution has claimed the run yet. Its first provider
  // start must still be counted, whatever interrupted preparation.
  if (coordinator.attempt <= 0) return false;
  for (let index = coordinator.recoveryHistory.length - 1; index >= 0; index -= 1) {
    const disposition = coordinator.recoveryHistory[index]?.disposition;
    if (disposition === "restart_suspended") return true;
    if (RECOVERY_CLAIM_DISPOSITIONS.has(disposition)) return false;
  }
  return false;
}

/**
 * A controller restart (a crash, so no drain record) charges the interrupted
 * attempt only by the work-based rule in provider-attempt-outcome.ts: the
 * provider accepted a turn in that attempt and no accepted turn completed work
 * before the crash. Each claim records the run's event-log position, so the
 * next claim judges only what happened after it. A resume the controller died
 * before starting, a runner that never admitted its provider, and a turn.start
 * the provider did not accept are not charged. Credit stops after
 * NATIVE_PROGRESS_CREDIT_GENERATION_LIMIT controller generations, so a crash
 * loop that never starts the provider, or that makes progress and then crashes
 * the controller every time, is still bounded.
 */
export const NATIVE_PROGRESS_CREDIT_GENERATION_LIMIT = PROVIDER_ATTEMPT_CREDIT_GENERATION_LIMIT;

type RecoveryClaimProgressEntry = { disposition?: unknown; progressWatermarkSeq?: unknown; progressAttempt?: unknown };

/**
 * The most recent recovery claim's event-log position and the provider attempt
 * its resume runs as. Entries from releases that did not record them give none.
 */
export function lastRecoveryClaimResume(
  recoveryHistory: ReadonlyArray<RecoveryClaimProgressEntry>,
): { watermark: number; attempt: number; launchesRunner: boolean } | null {
  const previous = previousRecoveryClaim(recoveryHistory);
  return previous === "none" || previous === "unrecorded" ? null : previous;
}

function previousRecoveryClaim(
  recoveryHistory: ReadonlyArray<RecoveryClaimProgressEntry>,
): { watermark: number; attempt: number; launchesRunner: boolean } | "none" | "unrecorded" {
  for (let index = recoveryHistory.length - 1; index >= 0; index -= 1) {
    const entry = recoveryHistory[index];
    if (!RECOVERY_CLAIM_DISPOSITIONS.has(entry?.disposition)) continue;
    const watermark = entry?.progressWatermarkSeq;
    const attempt = entry?.progressAttempt;
    // A reattachment adopts a runner that had already started its provider.
    const launchesRunner = entry?.disposition === "resume_dead_runner" || entry?.disposition === "bootstrap_incomplete";
    return typeof watermark === "number" && Number.isSafeInteger(watermark) && watermark >= 0
      && typeof attempt === "number" && Number.isSafeInteger(attempt)
      ? { watermark, attempt, launchesRunner } : "unrecorded";
  }
  return "none";
}

/**
 * Whether the resume claimed at `watermark` reached execution. The executor
 * records native.process_start_requested before any backend may spawn a
 * runner, and every runner event carries a source event ID.
 */
async function nativeExecutionStartedSince(tx: Pick<Db, "select">, runId: string, watermark: number): Promise<boolean> {
  const [started] = await tx
    .select({ seq: heartbeatRunEvents.seq })
    .from(heartbeatRunEvents)
    .where(and(
      eq(heartbeatRunEvents.runId, runId),
      gt(heartbeatRunEvents.seq, watermark),
      or(
        isNotNull(heartbeatRunEvents.sourceEventId),
        inArray(heartbeatRunEvents.eventType, [
          "adapter.invoke", PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED, "tool.execution.started",
        ]),
      ),
    ))
    .limit(1);
  return started !== undefined;
}

async function nativeRunEventWatermark(tx: Pick<Db, "select">, runId: string): Promise<number> {
  const [row] = await tx
    .select({ seq: sql<string | number | null>`max(${heartbeatRunEvents.seq})` })
    .from(heartbeatRunEvents)
    .where(eq(heartbeatRunEvents.runId, runId));
  return Number(row?.seq ?? 0);
}

/**
 * Whether this restart claim keeps the provider attempt instead of charging
 * one, judged by the work-based rule (provider-attempt-outcome.ts) over the
 * attempt the restart interrupted:
 * - The first restart judges the original execution's attempt.
 * - A later restart judges the attempt that ran after the previous claim's
 *   recorded position. A normal retry in between starts a new attempt window,
 *   so earlier work does not count for it.
 * - When the previous claim launched a new runner but that resume never
 *   reached execution, it consumed nothing and this claim replaces it. Its
 *   charge decision was never applied, so this claim carries it: the attempt
 *   ends at the attempt that resume was to run as, never above it.
 * - A claim history written before claims recorded their position charges.
 * At or after NATIVE_PROGRESS_CREDIT_GENERATION_LIMIT every restart charges.
 */
export async function restartResumeKeepsAttempt(tx: Pick<Db, "select">, input: {
  runId: string;
  coordinator: {
    attempt: number;
    controllerGeneration: number;
    recoveryHistory: ReadonlyArray<RecoveryClaimProgressEntry>;
  };
}): Promise<boolean> {
  if (input.coordinator.attempt <= 0) return false;
  if (input.coordinator.controllerGeneration >= NATIVE_PROGRESS_CREDIT_GENERATION_LIMIT) return false;
  const previous = previousRecoveryClaim(input.coordinator.recoveryHistory);
  if (previous === "unrecorded") return false;
  if (previous !== "none" && previous.launchesRunner
    && !await nativeExecutionStartedSince(tx, input.runId, previous.watermark))
    return input.coordinator.attempt >= previous.attempt;
  const claimedAt = previous === "none" ? 0 : previous.watermark;
  // A reattachment adopted a provider that had already started, and it keeps
  // the attempt; a normal retry after it starts a new attempt.
  const adoptedProviderWork = previous !== "none" && !previous.launchesRunner
    && input.coordinator.attempt === previous.attempt;
  const window = adoptedProviderWork ? { seq: claimedAt }
    : await providerAttemptWindowStart(tx, {
      runId: input.runId, sinceSeq: claimedAt, providerAttempt: input.coordinator.attempt,
    });
  if (window === "unstarted") return true;
  const outcome = await readProviderAttemptOutcome(tx, {
    runId: input.runId,
    sinceSeq: window.seq,
    adoptedProviderWork,
  });
  return !providerAttemptChargesBudget(outcome);
}


function processIsAlive(pid: number | null | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

function processGroupIsAlive(
  processGroupId: number | null | undefined,
): boolean {
  if (
    process.platform === "win32" ||
    !processGroupId ||
    !Number.isInteger(processGroupId) ||
    processGroupId <= 0
  ) {
    return false;
  }
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

async function observedProcessStart(pid: number): Promise<Date | null> {
  try {
    const startedAt = await readProcessStartedAt(pid);
    if (!startedAt) return null;
    const parsed = new Date(startedAt);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  } catch {
    return null;
  }
}

/** The native controller stamp of this process. The boot id is the single
 * process boot id (`controller-process-identity.ts`) and the start time is read
 * from the OS once, so claims and renewals on the turn path spawn no `ps`. */
export async function currentNativeControllerIdentity(): Promise<NativeControllerIdentity> {
  const observed = await currentProcessStartedAtMs();
  const fallback = new Date(getServerProcessStartedAt());
  return {
    bootId: currentControllerBootId(),
    pid: process.pid,
    processStartedAt:
      observed !== null ? new Date(observed) : (Number.isNaN(fallback.getTime()) ? new Date() : fallback),
    hostHash: currentProcessSpaceHash(),
  };
}

export function isCurrentNativeControllerProcess(owner: {
  controllerBootId: string | null;
  controllerPid: number | null;
}): boolean {
  return owner.controllerBootId === currentControllerBootId() && owner.controllerPid === process.pid;
}

function sameProcessStart(left: Date | null, right: Date | null): boolean {
  return left !== null && right !== null && left.getTime() === right.getTime();
}

function definitivelyDifferentProcessStart(
  left: Date | null,
  right: Date | null,
): boolean {
  // Shared with every other owner proof: a sub-second gap is ambiguous.
  return processStartsDefinitelyDiffer(left, right);
}

export type NativeControllerTakeoverDecision = {
  allowed: boolean;
  reason: string;
  /** The proof used the one-release local fallback for a row with no recorded host. */
  legacyHostFallback?: true;
};

/** Activity-log action for each use of the null-host fallback. The release
 * that removes the fallback counts these to see whether any rows still need
 * it. It is not a run-log event: run events are progress evidence for
 * restart recovery, and this record must not change any recovery decision. */
export const LEGACY_HOST_FALLBACK_EVENT = "legacy_host_unknown_dead_pid_proof";

export async function recordLegacyHostFallbackProof(db: Db, run: { companyId: string; id: string; agentId: string },
  decision: NativeControllerTakeoverDecision, source: string) {
  if (!decision.legacyHostFallback) return;
  await persistActivity(db, { companyId: run.companyId, actorType: "system", actorId: "native-restart-recovery",
    action: LEGACY_HOST_FALLBACK_EVENT, entityType: "heartbeat_run", entityId: run.id, runId: run.id, agentId: run.agentId,
    details: { reason: decision.reason, source } });
}

export async function evaluateNativeControllerTakeover(input: {
  owner: Pick<
    typeof nativeRunFinalizations.$inferSelect,
    | "leaseOwner"
    | "leaseExpiresAt"
    | "controllerPid"
    | "controllerProcessStartedAt"
  > & {
    /** PID space of controllerPid. Absent for owners built from receipts
     * that never stored one. Null on coordinator rows saved before the column
     * existed: those keep the previous local proof for one release, outside
     * ephemeral mode only (see LEGACY_HOST_FALLBACK_EVENT). */
    controllerHostHash?: string | null;
    controllerBootId?: string | null;
    updatedAt?: Date;
  };
  now: Date;
  coordinatedPreviousController?: {
    pid: number;
    processStartedAt: Date | null;
  } | null;
  isProcessAlive?: (pid: number) => boolean;
  readProcessStartedAt?: (pid: number) => Promise<Date | null>;
  requireStoppedController?: boolean;
  requireRecordedProcessSpace?: boolean;
  remoteLeaseFenced?: boolean;
}): Promise<NativeControllerTakeoverDecision> {
  const { owner, now } = input;
  if (input.remoteLeaseFenced) {
    if (!owner.leaseExpiresAt || owner.leaseExpiresAt <= now) {
      return { allowed: true, reason: "remote_controller_lease_released_or_expired" };
    }
    // The lease fences a second live controller from driving the same remote
    // runner. When the lease holder recorded this exact process space, the
    // shared prover can show it is gone (a hard restart), so the takeover need
    // not wait out the lease. A controller in another process space (another
    // container or host) is never probed here: its lease must expire. The
    // one-release null-host fallback is never enough for a remote runner.
    const sameProcessSpace = Object.prototype.hasOwnProperty.call(owner, "controllerHostHash")
      && typeof owner.controllerHostHash === "string"
      && owner.controllerHostHash !== UNKNOWN_PROCESS_SPACE
      && owner.controllerHostHash === currentProcessProbe().processSpace;
    if (sameProcessSpace && owner.controllerPid) {
      const local = await evaluateNativeControllerTakeover({ ...input, remoteLeaseFenced: false, requireStoppedController: true });
      if (local.allowed && !local.legacyHostFallback) return { allowed: true, reason: `remote_lease_${local.reason}` };
    }
    return { allowed: false, reason: "remote_controller_lease_live" };
  }
  if ((!owner.leaseOwner || !owner.leaseExpiresAt) && !input.requireStoppedController) {
    return { allowed: true, reason: "unowned" };
  }

  const priorPid = owner.controllerPid;
  if (!priorPid) {
    return {
      allowed: false,
      reason:
        owner.leaseExpiresAt !== null && owner.leaseExpiresAt <= now
          ? "expired_lease_without_controller_identity"
          : "live_legacy_lease_without_controller_identity",
    };
  }
  const recordsHost = Object.prototype.hasOwnProperty.call(owner, "controllerHostHash");
  // A board operator confirmed this exact controller stopped (see
  // confirmNativeControllerStopped); that attestation is the proof.
  if (recordsHost && owner.controllerHostHash === OPERATOR_ATTESTED_CONTROLLER_HOST) {
    return { allowed: true, reason: "operator_attested_controller_stopped" };
  }
  // The local branch is the shared prover (plan Phase 2): a PID is judged
  // only in the PID space that recorded it, a reused PID must have started
  // definitely later, and EPERM is alive. A coordinator row saved before the
  // host column keeps the one-release local proof on single-host servers
  // (`processSpaceUnrecorded`; each use is recorded by the caller as
  // LEGACY_HOST_FALLBACK_EVENT), and an ephemeral server never judges it.
  // Owners built from receipts that never stored a PID space are judged in
  // this PID space: their callers checked the recorded host first.
  const base = currentProcessProbe();
  const probe: ProcessProbe = {
    ...base,
    // No platform-deployment shortcut: this stamp records no worker.
    deployment: null,
    pidExists: input.isProcessAlive ?? base.pidExists,
    readStartedAt: input.readProcessStartedAt ?? base.readStartedAt,
  };
  const needsBootProof = input.requireRecordedProcessSpace || (owner.controllerHostHash != null
    && (owner.controllerHostHash !== probe.processSpace || owner.controllerHostHash === UNKNOWN_PROCESS_SPACE));
  const proof = await proveOwnerGone({
    kind: "local", scope: "native_controller", generation: null, host: null,
    processSpace: recordsHost ? owner.controllerHostHash ?? null : probe.processSpace,
    processSpaceUnrecorded: recordsHost && owner.controllerHostHash == null,
    ...(input.requireRecordedProcessSpace ? { requireRecordedProcessSpace: true } : {}),
    bootId: needsBootProof ? owner.controllerBootId ?? null : null, touchedAt: owner.updatedAt?.toISOString() ?? null,
    pid: priorPid, processStartedAt: owner.controllerProcessStartedAt?.toISOString() ?? null,
    processGroupId: null,
  }, probe);
  const fallback = proof.legacyHostFallback ? { legacyHostFallback: true as const } : {};
  if (proof.verdict === "gone") {
    if (proof.reason === "controller_fenced" || proof.reason === "controller_stopped") return { allowed: true, reason: proof.reason };
    if (proof.reason === "pid_reused") return { allowed: true, reason: "controller_pid_recycled", ...fallback };
    return {
      allowed: true,
      reason:
        owner.leaseExpiresAt !== null && owner.leaseExpiresAt <= now
          ? "expired_lease_controller_process_dead"
          : "controller_process_dead",
      ...fallback,
    };
  }
  if (proof.reason === "controller_lease_held" || proof.reason === "controller_lease_grace") return { allowed: false, reason: proof.reason };
  if (proof.reason === "process_space_unrecorded") return { allowed: false, reason: "controller_host_unrecorded" };
  if (proof.reason === "different_process_space" || proof.reason === "unknown_process_space"
    || proof.reason === "different_host") {
    return { allowed: false, reason: "controller_host_unprovable" };
  }
  // A live PID observed to start before the recorded controller is an
  // inconsistent stamp, never proof of reuse.
  if (proof.reason === "pid_start_inconsistent") return { allowed: false, reason: "controller_pid_start_inconsistent" };

  const coordinated = input.coordinatedPreviousController;
  if (
    coordinated &&
    coordinated.pid === priorPid &&
    coordinated.processStartedAt &&
    owner.controllerProcessStartedAt &&
    sameProcessStart(
      coordinated.processStartedAt,
      owner.controllerProcessStartedAt,
    )
  ) {
    return { allowed: false, reason: "coordinated_controller_still_alive" };
  }

  return { allowed: false, reason: "controller_still_alive" };
}

export type NativeProviderProcessIdentity = {
  pid: number;
  processStartedAt: Date | null;
};

export async function evaluateNativeProviderProcesses(input: {
  identities: NativeProviderProcessIdentity[];
  isProcessAlive?: (pid: number) => boolean;
  readProcessStartedAt?: (pid: number) => Promise<Date | null>;
}): Promise<{
  knownPids: number[];
  livePids: number[];
  ambiguousLivePids: number[];
  recycledPids: number[];
}> {
  const isAlive = input.isProcessAlive ?? processIsAlive;
  const readStartedAt = input.readProcessStartedAt ?? observedProcessStart;
  const expectedStarts = new Map<number, Date | null>();
  for (const identity of input.identities) {
    const current = expectedStarts.get(identity.pid);
    if (
      current === undefined ||
      (current === null && identity.processStartedAt)
    ) {
      expectedStarts.set(identity.pid, identity.processStartedAt);
    }
  }

  const livePids: number[] = [];
  const ambiguousLivePids: number[] = [];
  const recycledPids: number[] = [];
  for (const [pid, expectedStartedAt] of expectedStarts) {
    if (!isAlive(pid)) continue;
    const observedStartedAt = await readStartedAt(pid);
    if (!expectedStartedAt || !observedStartedAt) {
      ambiguousLivePids.push(pid);
    } else if (sameProcessStart(expectedStartedAt, observedStartedAt)) {
      livePids.push(pid);
    } else if (
      definitivelyDifferentProcessStart(expectedStartedAt, observedStartedAt)
    ) {
      recycledPids.push(pid);
    } else {
      ambiguousLivePids.push(pid);
    }
  }
  return {
    knownPids: [...expectedStarts.keys()],
    livePids,
    ambiguousLivePids,
    recycledPids,
  };
}

/** Run event types that can carry a provider process identity. */
/** Projected events a runner emits while opening its provider session, before any turn. */
const SESSION_OPEN_PROVIDER_EVENT_TYPES: ReadonlySet<string> = new Set([
  "harness.ready", "session.started", "session.resumed", "session.updated",
]);

export const NATIVE_PROVIDER_PROCESS_EVENT_TYPES = [
  "harness.ready",
  "session.started",
  "session.resumed",
  "session.updated",
  "turn.started",
  "provider.event",
  "provider.rpc_result",
] as const;

function parsedProcessStart(value: unknown): Date | null {
  const parsed = typeof value === "string" ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
}

/** Provider process identities from a saved checkpoint and recent run events. */
export function nativeProviderProcessIdentities(
  checkpoint: Record<string, unknown>,
  providerEvents: ReadonlyArray<{ payload: Record<string, unknown> | null }>,
): NativeProviderProcessIdentity[] {
  const identities: NativeProviderProcessIdentity[] = [];
  const checkpointProcess =
    checkpoint.process && typeof checkpoint.process === "object" && !Array.isArray(checkpoint.process)
      ? (checkpoint.process as Record<string, unknown>)
      : {};
  for (const [field, startedAtField] of [
    ["providerPid", "providerProcessStartedAt"],
    ["codexPid", "codexProcessStartedAt"],
    ["sidecarPid", "sidecarProcessStartedAt"],
    ["agentPid", "agentProcessStartedAt"],
  ] as const) {
    const value = checkpointProcess[field];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      identities.push({ pid: value, processStartedAt: parsedProcessStart(checkpointProcess[startedAtField]) });
    }
  }
  for (const providerEvent of providerEvents) {
    const prpEvent = providerEvent.payload?.prpEvent;
    const event = prpEvent && typeof prpEvent === "object" && !Array.isArray(prpEvent)
      ? (prpEvent as Record<string, unknown>) : {};
    const eventPayload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>) : {};
    const processId = eventPayload.processId;
    if (typeof processId === "number" && Number.isInteger(processId) && processId > 0) {
      identities.push({ pid: processId,
        processStartedAt: parsedProcessStart(eventPayload.processStartedAt ?? eventPayload.providerProcessStartedAt) });
    }
  }
  return identities;
}

export type NativeLocalRunnerStopProof =
  | { stopped: true }
  | {
      stopped: false;
      reason:
        | "runner_process_identity_missing"
        | "runner_process_alive"
        | "runner_process_identity_unverifiable"
        | "runner_process_group_alive"
        | "provider_process_alive"
        | "provider_process_identity_unverifiable";
    };

/**
 * Proves that a finished local runner and its recorded provider processes
 * stopped, with the same exact PID and start-time checks as restart recovery.
 * A PID that now belongs to a different process counts as stopped. A live
 * process with the recorded identity, a live process group, or a live PID
 * whose start time cannot be compared is not proof.
 */
export async function proveNativeLocalRunnerStopped(input: {
  processPid: number | null;
  processGroupId: number | null;
  processStartedAt: Date | null;
  providerProcesses?: readonly NativeProviderProcessIdentity[];
  /** A current, server-authored stop receipt already proved this exact Runner and group absent. */
  runnerStopRecorded?: boolean;
  isProcessAlive?: (pid: number) => boolean;
  isProcessGroupAlive?: (processGroupId: number) => boolean;
  readProcessStartedAt?: (pid: number) => Promise<Date | null>;
}): Promise<NativeLocalRunnerStopProof> {
  const refuse = (reason: Extract<NativeLocalRunnerStopProof, { stopped: false }>["reason"]) =>
    ({ stopped: false as const, reason });
  // A local Runner leads its own process group. Without both identities, a
  // live child in that group could outlive the Runner unseen.
  if (!input.processPid || !Number.isInteger(input.processPid) || input.processPid <= 1 || !input.processGroupId
    || (!input.processStartedAt && !input.runnerStopRecorded)) {
    return refuse("runner_process_identity_missing");
  }
  if (!input.runnerStopRecorded) {
    const runner = await evaluateNativeProviderProcesses({
      identities: [{ pid: input.processPid, processStartedAt: input.processStartedAt }],
      isProcessAlive: input.isProcessAlive,
      readProcessStartedAt: input.readProcessStartedAt,
    });
    if (runner.livePids.length > 0) return refuse("runner_process_alive");
    if (runner.ambiguousLivePids.length > 0) return refuse("runner_process_identity_unverifiable");
  }
  const groupAlive = input.isProcessGroupAlive ?? processGroupIsAlive;
  if (groupAlive(input.processGroupId)) return refuse("runner_process_group_alive");
  const providers = await evaluateNativeProviderProcesses({
    identities: (input.providerProcesses ?? []).filter(identity => identity.pid !== input.processPid),
    isProcessAlive: input.isProcessAlive,
    readProcessStartedAt: input.readProcessStartedAt,
  });
  if (providers.livePids.length > 0) return refuse("provider_process_alive");
  if (providers.ambiguousLivePids.length > 0) return refuse("provider_process_identity_unverifiable");
  return { stopped: true };
}

export function classifyNativeRunnerRecoveryEvidence(input: {
  runnerPidAlive: boolean;
  runnerGroupAlive: boolean;
  remoteSandbox?: boolean;
  unclaimedBootstrap?: boolean;
  /** Durable evidence proves a claimed remote bootstrap reached no provider work. */
  remoteBootstrapProvenIncomplete?: boolean;
  remoteBootstrapIncompleteReason?: "remote_runner_never_launched" | "remote_session_opened_without_turn"
    | "remote_runner_exited_before_provider_work" | "remote_runner_never_received_commands";
  processStartMatches: boolean;
  knownProviderProcessAlive?: boolean;
  knownProviderProcessIdentityAmbiguous?: boolean;
  hasCheckpoint: boolean;
  checkpointIdentityMatches?: boolean;
  hasProviderEvidence: boolean;
  checkpointFailed?: boolean;
  stagedAttachmentVerified?: boolean;
  providerAttempt?: number;
  /** False when resuming keeps the current attempt (a clean drain). */
  resumeChargesAttempt?: boolean;
}): {
  claimKind: NativeRestartRecoveryClaim["kind"] | null;
  reason: string;
} {
  if (input.checkpointFailed)
    return {
      claimKind: null,
      reason: "provider_checkpoint_permanently_failed",
    };
  // Sandbox PIDs belong to another host. This claim only authorizes remote
  // inspection; the executor must prove the original lease and authenticate
  // the surviving runner before it can resume delivery.
  if (input.remoteSandbox) {
    if (input.stagedAttachmentVerified === true) {
      return { claimKind: "reattach_remote_runner", reason: "staged_remote_attachment_requires_sandbox_verification" };
    }
    if (input.unclaimedBootstrap === true && !input.hasCheckpoint && !input.hasProviderEvidence) {
      return { claimKind: "bootstrap_incomplete", reason: "remote_execution_never_claimed" };
    }
    // Callers prove provider evidence is absent or only session-open events.
    if (input.remoteBootstrapProvenIncomplete === true && !input.hasCheckpoint) {
      // Each same-run bootstrap is another provider attempt; keep restarts bounded.
      if (input.resumeChargesAttempt !== false && (input.providerAttempt ?? 0) >= 3)
        return { claimKind: null, reason: "execution_recovery_budget_exhausted" };
      return { claimKind: "bootstrap_incomplete",
        reason: input.remoteBootstrapIncompleteReason ?? "remote_bootstrap_proven_incomplete" };
    }
    return input.hasCheckpoint &&
      input.checkpointIdentityMatches === true &&
      input.hasProviderEvidence
      ? {
          claimKind: "reattach_remote_runner",
          reason: "remote_runner_requires_sandbox_verification",
        }
      : { claimKind: null, reason: "ambiguous_remote_recovery_evidence" };
  }
  if (input.runnerPidAlive && input.processStartMatches) {
    return {
      claimKind: "reattach_existing_runner",
      reason: "runner_process_identity_verified",
    };
  }
  if (input.runnerPidAlive || input.runnerGroupAlive) {
    return {
      claimKind: null,
      reason: input.runnerPidAlive
        ? "live_runner_identity_mismatch"
        : "live_runner_process_group_without_exact_pid",
    };
  }
  if (input.knownProviderProcessAlive) {
    return {
      claimKind: null,
      reason: "live_provider_process_without_runner_authority",
    };
  }
  if (input.knownProviderProcessIdentityAmbiguous) {
    return {
      claimKind: null,
      reason: "live_provider_process_identity_unverifiable",
    };
  }
  // Continuing an attempt already counted needs no budget; a new one does.
  if (input.resumeChargesAttempt !== false && (input.providerAttempt ?? 0) >= NATIVE_PROVIDER_RECOVERY_ATTEMPT_LIMIT)
    return { claimKind: null, reason: "execution_recovery_budget_exhausted" };
  const checkpointIdentityMatches =
    input.checkpointIdentityMatches ?? input.hasCheckpoint;
  if (
    input.hasCheckpoint &&
    checkpointIdentityMatches &&
    input.hasProviderEvidence
  ) {
    return {
      claimKind: "resume_dead_runner",
      reason: "dead_runner_with_exact_provider_checkpoint",
    };
  }
  if (!input.hasCheckpoint && !input.hasProviderEvidence) {
    return {
      claimKind: "bootstrap_incomplete",
      reason: "dead_runner_before_provider_identity",
    };
  }
  return { claimKind: null, reason: "ambiguous_provider_recovery_evidence" };
}

/** Any record that execution reached a runner: a requested or identified
 * process, an adapter invocation, a tool start, or a runner-sourced event. */
/** Whether a runner or provider produced any event for this run. Unlike
 * hasNativeExecutionStartEvidence, the controller's own process-start and
 * identity records do not count: a relaunched runner that exited before run.prepare
 * has those, but nothing the runner itself sent. */
async function hasNativeRunnerOriginatedEvidence(
  tx: Pick<Db, "select">, run: { companyId: string; id: string },
): Promise<boolean> {
  const [event] = await tx.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents)
    .where(and(eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
      or(isNotNull(heartbeatRunEvents.sourceEventId),
        inArray(heartbeatRunEvents.eventType, ["adapter.invoke", "tool.execution.started"]))))
    .limit(1);
  return event !== undefined;
}

async function hasNativeRunEvent(
  tx: Pick<Db, "select">, run: { companyId: string; id: string }, eventType: string,
): Promise<boolean> {
  const [event] = await tx.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents)
    .where(and(eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
      eq(heartbeatRunEvents.eventType, eventType)))
    .limit(1);
  return event !== undefined;
}

export async function hasNativeExecutionStartEvidence(
  tx: Pick<Db, "select">, run: { companyId: string; id: string },
): Promise<boolean> {
  const [executionEvent] = await tx
    .select({ id: heartbeatRunEvents.id })
    .from(heartbeatRunEvents)
    .where(and(
      eq(heartbeatRunEvents.companyId, run.companyId),
      eq(heartbeatRunEvents.runId, run.id),
      or(
        isNotNull(heartbeatRunEvents.sourceEventId),
        inArray(heartbeatRunEvents.eventType, [
          "adapter.invoke",
          PROCESS_START_REQUESTED,
          PROCESS_IDENTITY_RECORDED,
          "tool.execution.started",
        ]),
      ),
    ))
    .limit(1);
  return executionEvent !== undefined;
}

function historyEntry(input: {
  now: Date;
  restartKind: NativeRestartKind;
  controller: NativeControllerIdentity;
  generation: number;
  disposition: string;
  reason: string;
  requestId: string | null;
  providerAttempt: number;
  processPid: number | null;
  processStartedAt: Date | null;
  hasCheckpoint: boolean;
  checkpointIdentityMatches?: boolean;
  hasProviderEvidence: boolean;
  knownProviderPids?: number[];
  liveProviderPids?: number[];
  ambiguousProviderPids?: number[];
  recycledProviderPids?: number[];
  stderrTail?: string | null;
}) {
  return {
    at: input.now.toISOString(),
    restartKind: input.restartKind,
    controllerBootId: input.controller.bootId,
    controllerPid: input.controller.pid,
    controllerProcessStartedAt: input.controller.processStartedAt.toISOString(),
    controllerGeneration: input.generation,
    disposition: input.disposition,
    reason: input.reason,
    stateRootAction:
      input.disposition === "reattach_existing_runner" ||
      input.disposition === "reattach_remote_runner"
        ? "reopen_exact_root"
        : input.disposition === "resume_dead_runner"
          ? "reuse_exact_root"
          : input.disposition === "bootstrap_incomplete"
            ? "quarantine_incomplete_root_then_bootstrap"
            : input.disposition === "awaiting_evidence"
              ? "preserve_awaiting_evidence"
              : "preserve_fail_closed",
    recoveryRequestId: input.requestId,
    providerAttempt: input.providerAttempt,
    processPid: input.processPid,
    processStartedAt: input.processStartedAt?.toISOString() ?? null,
    hasCheckpoint: input.hasCheckpoint,
    checkpointIdentityMatches: input.checkpointIdentityMatches ?? false,
    hasProviderEvidence: input.hasProviderEvidence,
    knownProviderPids: input.knownProviderPids ?? [],
    liveProviderPids: input.liveProviderPids ?? [],
    ambiguousProviderPids: input.ambiguousProviderPids ?? [],
    recycledProviderPids: input.recycledProviderPids ?? [],
    stderrTail:
      input.stderrTail && input.stderrTail.trim()
        ? redactSensitiveText(input.stderrTail).slice(-4_096)
        : null,
  } satisfies Record<string, unknown>;
}

function appendBoundedRecoveryHistory(entry: Record<string, unknown>) {
  const encoded = JSON.stringify(entry);
  return sql`(
    select coalesce(jsonb_agg(item order by ordinal), '[]'::jsonb)
    from jsonb_array_elements(
      coalesce(${nativeRunFinalizations.recoveryHistory}, '[]'::jsonb)
      || jsonb_build_array(${encoded}::jsonb)
    ) with ordinality as history(item, ordinal)
    where ordinal > greatest(
      jsonb_array_length(
        coalesce(${nativeRunFinalizations.recoveryHistory}, '[]'::jsonb)
        || jsonb_build_array(${encoded}::jsonb)
      ) - 20,
      0
    )
  )`;
}

/** Shared by restart inspection and failed-owner cleanup under their existing
 * issue/coordinator/run locks. Publishing attention never grants a new turn. */
export async function surfaceNativeControllerNamespaceAttention(db: Db, input: {
  run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "agentId">;
  coordinator: typeof nativeRunFinalizations.$inferSelect;
  expiryEpoch: string | null;
  remoteProcess: boolean;
}): Promise<void> {
  const reason = input.remoteProcess ? "remote_controller_process_space_unverified" : "controller_process_space_unverified";
  const attention = issueRecoveryActionService(db);
  const digest = nativeControllerAuthorityDigest(input.coordinator, input.expiryEpoch);
  const fingerprint = `native-controller-space:${input.run.id}:${digest}`;
  const [existing] = await db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, input.run.companyId), eq(issueRecoveryActions.sourceIssueId, input.coordinator.issueId),
    inArray(issueRecoveryActions.status, ["active", "escalated"]),
  )).for("update").limit(1);
  // One incident per exact authority. A repeat neither spends a retry
  // attempt nor emits a new wake. Renewed/replaced authority gets a new
  // incident, preserving the prior confirmation/history. An unrelated
  // active recovery owner is never overwritten by this observation.
  const sameSource = existing?.cause === "native_restart_recovery_blocked"
    && existing.evidence.runId === input.run.id
    && ["controller_process_space_unverified", "remote_controller_process_space_unverified"].includes(String(existing.evidence.reason));
  if (!existing || (sameSource && existing.fingerprint !== fingerprint)) {
    await attention.upsertSourceScoped({
      companyId: input.run.companyId, sourceIssueId: input.coordinator.issueId,
      kind: "active_run_watchdog", ownerType: "board", returnOwnerAgentId: input.run.agentId,
      cause: "native_restart_recovery_blocked", fingerprint,
      evidence: { runId: input.run.id, reason, executorStopEvidence: "unverified",
        ...(!input.remoteProcess ? { controllerAuthority: { schema: "paperclip.native-controller-authority.v1",
          digest, leaseExpiresAt: input.coordinator.leaseExpiresAt!.toISOString() } } : {}) },
      nextAction: input.remoteProcess
        ? "Use the task's ordinary Stop action and its environment provider's stop/cleanup recovery. Wait for that exact controller/provider acknowledgement. Local PID checks and local containment confirmation cannot authorize remote recovery."
        : "Stop the original controller and provider on their original host. After the saved lease expires, a board operator must record both stops and review action outcomes. Recording containment does not retry the task.",
      createOnly: !existing, supersedeOnIdentityChange: true,
      attemptCount: 0, maxAttempts: null, timeoutAt: null, lastAttemptAt: null,
      wakePolicy: null, monitorPolicy: null,
    });
  }
}

export async function claimNativeRestartRecoveries(input: {
  db: Db;
  controller?: NativeControllerIdentity;
  restartKind: NativeRestartKind;
  recoveryRequestId?: string | null;
  runIds?: string[];
  liveRunExecutions?: Pick<ReadonlySet<string>, "has">;
  now?: Date;
  limit?: number;
  /** Called after each committed claim, before scanning the next candidate. */
  onClaim?: (claim: NativeRestartRecoveryClaim, scope: {
    companyId: string; issueId: string; controller: NativeControllerIdentity; remote: boolean;
  }) => void;
  coordinatedPreviousController?: {
    pid: number;
    processStartedAt: Date | null;
  } | null;
}): Promise<NativeRestartRecoveryDisposition[]> {
  const now = input.now ?? new Date();
  const controller =
    input.controller ?? (await currentNativeControllerIdentity());
  const controllerHostHash = currentProcessSpaceHash();
  const candidateQuery = input.db
    .select({
      runId: heartbeatRuns.id,
      issueId: nativeRunFinalizations.issueId,
      companyId: heartbeatRuns.companyId,
    })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
    .innerJoin(
      nativeRunFinalizations,
      eq(nativeRunFinalizations.runId, heartbeatRuns.id),
    )
    .where(
      and(
        eq(heartbeatRuns.runtimeMode, "native"),
        legacyWorkspaceRecoveryNotMigrated(),
        eq(agents.adapterType, "paperclip_runner"),
        or(inArray(heartbeatRuns.status, ["running", "failed"]), and(
          eq(heartbeatRuns.status, "interrupted"), eq(nativeRunFinalizations.phase, "observed"),
          sql`${heartbeatRuns.resultJson}->'nativeCancellation'->>'dispatchState' = 'pending'`,
        )),
        isNull(nativeRunFinalizations.resultId),
        // A pre-provider retained-owner wait belongs to normal same-run
        // resumption, including when its deadline elapsed while we were down.
        or(isNull(nativeRunFinalizations.failureCode), ne(nativeRunFinalizations.failureCode, NATIVE_RETAINED_OWNER_WAIT)),
        or(
          eq(nativeRunFinalizations.phase, "observed"),
          and(
            eq(nativeRunFinalizations.phase, "retryable_failure"),
            or(
              isNull(nativeRunFinalizations.nextAttemptAt),
              lte(nativeRunFinalizations.nextAttemptAt, now),
            ),
          ),
        ),
        ...(input.runIds?.length
          ? [inArray(heartbeatRuns.id, input.runIds)]
          : []),
      ),
    )
    .orderBy(heartbeatRuns.id);
  const candidates = await (input.limit === undefined
    ? candidateQuery
    : candidateQuery.limit(input.limit));

  const dispositions: NativeRestartRecoveryDisposition[] = [];
  for (const candidate of candidates) {
    const now = input.now ?? new Date();
    let claimScope: { companyId: string; issueId: string; controller: NativeControllerIdentity; remote: boolean } | undefined;
    // Set inside the transaction only when the write below genuinely
    // transitions the run into "failed". Read after the transaction
    // commits, so a rolled-back write never reports a false failure.
    let terminalRunToReport: typeof heartbeatRuns.$inferSelect | null = null;
    const disposition = await input.db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('statement_timeout', '15000', true), set_config('lock_timeout', '1000', true)`,
      );
      const busy = () => ({ kind: "awaiting_evidence" as const, runId: candidate.runId,
        reason: "recovery_rows_busy", retryAt: new Date(now.getTime() + 1_000) });
      // During overlap the serving controller can be committing this run.
      // Defer that concrete recovery obligation instead of failing startup
      // or waiting while holding a lock the serving controller needs.
      const [issue] = await tx
        .select({ id: issues.id, companyId: issues.companyId, status: issues.status,
          executionRunId: issues.executionRunId, checkoutRunId: issues.checkoutRunId,
          assigneeAgentId: issues.assigneeAgentId })
        .from(issues)
        .where(and(eq(issues.id, candidate.issueId), eq(issues.companyId, candidate.companyId)))
        .for("update", { skipLocked: true });
      if (!issue) return busy();
      const row = await tx
        .select({
          run: heartbeatRuns,
          coordinator: nativeRunFinalizations,
          controllerLeaseExpiryEpoch: sql<string | null>`extract(epoch from ${nativeRunFinalizations.leaseExpiresAt})::numeric::text`,
          issueExecutionRunId: issues.executionRunId,
          issueCheckoutRunId: issues.checkoutRunId,
          issueAssigneeAgentId: issues.assigneeAgentId,
          issueStatus: issues.status,
        })
        .from(heartbeatRuns)
        .innerJoin(
          nativeRunFinalizations,
          eq(nativeRunFinalizations.runId, heartbeatRuns.id),
        )
        .innerJoin(
          issues,
          and(
            eq(issues.id, nativeRunFinalizations.issueId),
            eq(issues.companyId, nativeRunFinalizations.companyId),
          ),
        )
        .where(eq(heartbeatRuns.id, candidate.runId))
        .for("update", { skipLocked: true })
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!row) {
        return busy();
      }
      if (row.run.runnerProfileJson?.legacyWorkspaceRecoveryMigration != null)
        return { kind: "blocked", runId: row.run.id, reason: "legacy_workspace_recovery_migrated" } as const;
      const stopCleanup = row.coordinator.phase === "observed"
        && row.coordinator.companyId === row.run.companyId && row.coordinator.issueId === row.run.nativeIssueId
        && await readPendingNativeRunStop(tx as unknown as Db, row.run);
      if (!["running", "failed"].includes(row.run.status) && !(row.run.status === "interrupted" && stopCleanup)) {
        return { kind: "blocked", runId: row.run.id, reason: "run_no_longer_recoverable" } as const;
      }
      if (isNativeRunnerOwnershipHeld(row.run)) {
        return {
          kind: "blocked",
          runId: row.run.id,
          reason: "native_execution_ownership_unverified",
        } as const;
      }
      if (row.coordinator.resultId) {
        return {
          kind: "already_finalized",
          runId: row.run.id,
          reason: "result_already_persisted",
        } as const;
      }
      if (!input.liveRunExecutions?.has(row.run.id) && await retireSupersededNativeRetry(tx as unknown as Db, {
        run: row.run, coordinator: row.coordinator, issueExecutionRunId: row.issueExecutionRunId, now,
      })) return { kind: "blocked", runId: row.run.id, reason: "native_retry_superseded" } as const;
      const profile = row.run.runnerProfileJson ?? {};
      const storedRemoteWorkspace = remoteWorkspaceRunReferenceSchema.safeParse(profile.remoteWorkspace);
      const remoteWorkspace = readNativeWorkspaceSyncReference(profile.nativeWorkspaceSync)
        ?? (storedRemoteWorkspace.success ? storedRemoteWorkspace.data : null);
      const { pluginTask, remoteProcess } = await readNativeRemoteExecutionOwnership(tx as unknown as Db,
        { run: row.run, issueId: issue.id });
      const failedRemoteRetry = row.run.status === "failed" && row.coordinator.phase === "retryable_failure"
        && row.coordinator.failureDetail?.recoveryMode === "exact_checkpoint_resume" && (remoteWorkspace !== null || pluginTask !== undefined);
      // A same-run bootstrap retry cannot take back an issue lock that moved
      // off it. Without a bounded admission it would re-check forever, never
      // settle, and keep its sandbox lease from the orphan-lease sweep.
      const lockLostBootstrapRetry = row.run.status === "failed" && row.coordinator.phase === "retryable_failure"
        && row.coordinator.failureDetail?.recoveryMode === "bootstrap_retry" && row.issueExecutionRunId !== row.run.id;
      const releasedRemoteRetry = failedRemoteRetry && row.issueExecutionRunId === null;
      const exhaustedRemoteRetry = failedRemoteRetry && row.coordinator.attempt >= 3;
      const needsResumptionAdmission = releasedRemoteRetry || exhaustedRemoteRetry ||
        (failedRemoteRetry && ["done", "cancelled"].includes(issue.status));
      const admission = { exhausted: null as { reason: string; policy: SystemRecoveryState } | null };
      const deferRemoteRetry = async (reason: string, permanent = false) => {
        if (input.liveRunExecutions?.has(row.run.id)) {
          return { kind: "awaiting_evidence", runId: row.run.id, reason: "current_controller_preparing" } as const;
        }
        const existingDeadline = Math.max(row.coordinator.nextAttemptAt?.getTime() ?? 0,
          row.coordinator.leaseOwner ? row.coordinator.leaseExpiresAt?.getTime() ?? 0 : 0);
        if (existingDeadline > now.getTime()) {
          return { kind: "blocked", runId: row.run.id, reason, retryAt: new Date(existingDeadline),
            transitionUnchanged: true } as const;
        }
        const previousPolicy = readSystemRecovery(row.coordinator.failureDetail);
        const policy = previousPolicy?.sourceRunId === row.run.id ? previousPolicy : createSystemRecovery(row.run.id);
        const reserved = reserveSystemRecoveryAttempt(policy, now.getTime());
        const failed = reserved ? failSystemRecovery(reserved, new SystemRecoveryFailure(
          permanent ? "source_binding_invalid" : "allocation_ownership_ambiguous",
          permanent ? "user_action_required" : "recheck_evidence"), { now: now.getTime(), evidenceFingerprint: reason })
          : { ...policy, state: "exhausted" as const, nextAttemptAt: null };
        if (failed.state === "exhausted") {
          admission.exhausted = { reason, policy: failed };
          return null;
        }
        const retryAt = new Date(failed.nextAttemptAt!);
        const previous = row.coordinator.recoveryHistory.at(-1);
        const transitionUnchanged = previous?.disposition === "blocked" && previous.reason === reason;
        await notifyLiveRunRecovery(tx, { companyId: row.run.companyId, runId: row.run.id });
        const updated = await tx.update(nativeRunFinalizations).set({ nextAttemptAt: retryAt, updatedAt: now,
          failureDetail: { ...row.coordinator.failureDetail, systemRecovery: failed },
          ...(!transitionUnchanged ? { recoveryHistory: appendBoundedRecoveryHistory({
            at: now.toISOString(), restartKind: input.restartKind, controllerBootId: controller.bootId,
            controllerGeneration: row.coordinator.controllerGeneration, disposition: "blocked", reason,
            recoveryRequestId: input.recoveryRequestId ?? null, providerAttempt: row.coordinator.attempt,
            stateRootAction: "preserve_fail_closed", retryAt: retryAt.toISOString(),
          }) } : {}),
        }).where(and(eq(nativeRunFinalizations.companyId, row.run.companyId),
          eq(nativeRunFinalizations.issueId, issue.id), eq(nativeRunFinalizations.runId, row.run.id),
          eq(nativeRunFinalizations.phase, "retryable_failure"), eq(nativeRunFinalizations.attempt, row.coordinator.attempt),
          isNull(nativeRunFinalizations.resultId),
          or(isNull(nativeRunFinalizations.nextAttemptAt), lte(nativeRunFinalizations.nextAttemptAt, now)),
          or(isNull(nativeRunFinalizations.leaseOwner), isNull(nativeRunFinalizations.leaseExpiresAt), lte(nativeRunFinalizations.leaseExpiresAt, now)),
        )).returning({ runId: nativeRunFinalizations.runId });
        if (!updated.length) throw new Error("native_retry_deferral_claim_changed");
        return { kind: "blocked", runId: row.run.id, reason, retryAt, transitionUnchanged } as const;
      };
      if (failedRemoteRetry || lockLostBootstrapRetry) {
        const source = alias(heartbeatRuns, "native_retry_source");
        const [newer] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
          .innerJoin(source, and(eq(source.companyId, row.run.companyId), eq(source.id, row.run.id)))
          .where(and(
            eq(heartbeatRuns.companyId, row.run.companyId),
            or(gt(heartbeatRuns.createdAt, source.createdAt), and(
              eq(heartbeatRuns.createdAt, source.createdAt), gt(heartbeatRuns.id, source.id),
            )),
            or(eq(heartbeatRuns.issueId, issue.id), eq(heartbeatRuns.nativeIssueId, issue.id),
              sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`),
          )).limit(1);
        if (newer) {
          const deferred = await deferRemoteRetry("native_retry_source_superseded", true);
          if (deferred) return deferred;
        }
      }
      const resumptionAgent = needsResumptionAdmission
        ? await readNativeSessionResumptionAgent(tx as unknown as Db, { issue, run: row.run, coordinator: row.coordinator })
        : null;
      if (needsResumptionAdmission && !resumptionAgent && !admission.exhausted) {
        const deferred = await deferRemoteRetry("native_retry_admission_ineligible", ["done", "cancelled"].includes(issue.status));
        if (deferred) return deferred;
      }
      if (lockLostBootstrapRetry && !admission.exhausted) {
        const deferred = await deferRemoteRetry("issue_execution_lock_changed");
        if (deferred) return deferred;
      }
      if (row.issueExecutionRunId !== row.run.id && !(stopCleanup && row.issueExecutionRunId === null) && !releasedRemoteRetry && !admission.exhausted) {
        return {
          kind: "blocked",
          runId: row.run.id,
          reason: "issue_execution_lock_changed",
        } as const;
      }

      const startupContext = readNativeStartupContext(row.run, row.coordinator);
      const startupRetryAt = startupContext ? new Date(Math.max(now.getTime() + 30_000,
        startupContext.deadlineAtMs, row.coordinator.leaseExpiresAt?.getTime() ?? 0)) : undefined;
      if (input.liveRunExecutions?.has(row.run.id)) {
        return {
          kind: "awaiting_evidence",
          runId: row.run.id,
          reason: "current_controller_preparing",
          ...(startupRetryAt ? { retryAt: startupRetryAt } : {}),
        } as const;
      }
      if (startupContext) {
        if (await promoteNativeStartupCleanup(tx as unknown as Db, row.run, row.coordinator, now)) {
          return { kind: "blocked", runId: row.run.id, reason: "native_startup_cleanup_pending" } as const;
        }
        return { kind: "awaiting_evidence", runId: row.run.id, reason: "native_startup_cleanup_pending", retryAt: startupRetryAt } as const;
      }

      const startup = pluginTask?.metadata?.runnerTaskStartup as { contextId?: unknown; deadlineAtMs?: unknown; runId?: unknown } | undefined;
      if (startup?.runId === row.run.id && typeof startup.contextId === "string" &&
          Number.isSafeInteger(startup.deadlineAtMs) && Number(startup.deadlineAtMs) <= now.getTime() &&
          !row.run.sessionIdAfter && row.coordinator.leaseOwner && row.coordinator.leaseExpiresAt && row.coordinator.leaseExpiresAt <= now) {
        await requestNativeStartupCleanup(tx as unknown as Db, { companyId: row.run.companyId, agentId: row.run.agentId,
          runId: row.run.id, contextId: startup.contextId, deadlineAtMs: Number(startup.deadlineAtMs),
          leaseOwner: row.coordinator.leaseOwner, requiresPreparationStop: true, leaseId: pluginTask!.id }, { publish: false });
        return { kind: "blocked", runId: row.run.id, reason: "native_startup_cleanup_pending" } as const;
      }
      const remoteSandbox = profile.nativeWorkspaceSync != null || profile.remoteWorkspace != null;
      const durableAuthority = (remoteWorkspace || pluginTask) && await hasNativeRunnerCheckpoint(tx, {
        companyId: row.run.companyId, issueId: row.coordinator.issueId, runId: row.run.id,
      });
      // Lease expiry alone does not prove a local in-flight owner stopped.
      // Only this boot's own PID or the same known process space can make a
      // local PID observation meaningful. Durable remote leases keep their
      // existing released/expired authority instead of using local probes.
      const processSpaceUnverified = !durableAuthority
        && Boolean(row.coordinator.leaseOwner && row.coordinator.leaseExpiresAt)
        && !isCurrentNativeControllerProcess(row.coordinator)
        && (controllerHostHash === "unknown" || row.coordinator.controllerHostHash !== controllerHostHash);
      const nonExecutionOwner = row.coordinator.leaseOwner?.startsWith("native-finalizer:")
        || row.coordinator.leaseOwner?.startsWith("native-cleanup:");
      const evaluatedTakeover = nonExecutionOwner
        ? { allowed: false, reason: "native_finalization_or_cleanup_owner" }
        : await evaluateNativeControllerTakeover({
          owner: row.coordinator,
          now,
          requireRecordedProcessSpace: processSpaceUnverified,
          remoteLeaseFenced: Boolean(durableAuthority),
          coordinatedPreviousController:
            input.coordinatedPreviousController ?? null,
        });
      const independentControllerWait = !evaluatedTakeover.allowed
        && ["controller_lease_held", "controller_lease_grace"].includes(evaluatedTakeover.reason);
      // Controller death does not prove a foreign local Runner or provider
      // stopped. Remote execution never uses local PID probes and still owes
      // its existing checkpoint or never-launched proof below.
      const independentlyStoppedRemoteController = remoteProcess && evaluatedTakeover.allowed
        && ["controller_stopped", "controller_fenced"].includes(evaluatedTakeover.reason);
      const namespaceAttentionNeeded = processSpaceUnverified && !nonExecutionOwner
        && !independentControllerWait && !independentlyStoppedRemoteController;
      const takeover = namespaceAttentionNeeded
        ? { allowed: false, reason: remoteProcess ? "remote_controller_process_space_unverified" : "controller_process_space_unverified" }
        : evaluatedTakeover;
      await recordLegacyHostFallbackProof(tx as unknown as Db, row.run, takeover, "native_restart_recovery");
      if (!takeover.allowed && ["controller_host_unrecorded", "controller_host_unprovable"].includes(takeover.reason)) {
        await requestNativeControllerStopConfirmation(tx as unknown as Db, row.coordinator);
      }
      if (!takeover.allowed) {
        if (namespaceAttentionNeeded) {
          await surfaceNativeControllerNamespaceAttention(tx as unknown as Db, {
            run: row.run, coordinator: row.coordinator, expiryEpoch: row.controllerLeaseExpiryEpoch, remoteProcess,
          });
        }
        const previous = row.coordinator.recoveryHistory.at(-1);
        const waitAlreadyRecorded = previous?.disposition === "awaiting_evidence" && previous.reason === takeover.reason;
        const event = historyEntry({
          now,
          restartKind: input.restartKind,
          controller,
          generation: row.coordinator.controllerGeneration,
          disposition: "awaiting_evidence",
          reason: takeover.reason,
          requestId: input.recoveryRequestId ?? null,
          providerAttempt: row.coordinator.attempt,
          processPid: row.run.processPid,
          processStartedAt: row.run.processStartedAt,
          hasCheckpoint: false,
          hasProviderEvidence: false,
          stderrTail: row.run.stderrExcerpt,
        });
        await notifyLiveRunRecovery(tx, { companyId: row.run.companyId, runId: row.run.id, agentId: row.run.agentId });
        await tx
          .update(nativeRunFinalizations)
          .set({
            recoveryState: "awaiting_evidence",
            recoveryRequestId: input.recoveryRequestId ?? null,
            // Repeated scans of one ownership wait record it once, so the
            // bounded history keeps the drain record the next claim reads.
            ...(waitAlreadyRecorded ? {} : { recoveryHistory: appendBoundedRecoveryHistory(event) }),
            updatedAt: waitAlreadyRecorded && row.coordinator.recoveryState === "awaiting_evidence"
              && row.coordinator.recoveryRequestId === (input.recoveryRequestId ?? null) ? row.coordinator.updatedAt : now,
          })
          .where(
            and(
              eq(nativeRunFinalizations.runId, row.run.id),
              eq(nativeRunFinalizations.attempt, row.coordinator.attempt),
              eq(nativeRunFinalizations.phase, row.coordinator.phase),
            ),
          );
        return {
          kind: "awaiting_evidence",
          runId: row.run.id,
          reason: takeover.reason,
          ...(durableAuthority && row.coordinator.leaseExpiresAt ? { retryAt: row.coordinator.leaseExpiresAt }
            : ["controller_lease_held", "controller_lease_grace"].includes(takeover.reason)
              ? { retryAt: new Date(now.getTime() + CONTROLLER_LEASE_RENEW_MS) } : {}),
        } as const;
      }

      // Only the classic remote path stages attachments. After the owner is
      // eligible for takeover, inspect its bounded header even if activation
      // already published a runtime snapshot. Never scan command/event payloads.
      const stagedHeader = remoteWorkspace && !pluginTask && durableAuthority
        ? await loadNativeRunnerCheckpointHeader(tx, {
            companyId: row.run.companyId, issueId: row.coordinator.issueId, runId: row.run.id,
          }) : null;
      const stagedAttachment = stagedHeader ? await resolveNativeStagedAttachmentRecovery({
        db: tx, currentRun: row.run, header: stagedHeader,
      }) : null;

      const runnerPidAlive =
        !remoteProcess && processIsAlive(row.run.processPid);
      const runnerGroupAlive =
        !remoteProcess && processGroupIsAlive(row.run.processGroupId);
      const observedRunnerStart =
        row.run.processPid && runnerPidAlive
          ? await observedProcessStart(row.run.processPid)
          : null;
      const exactRunnerIdentity =
        runnerPidAlive &&
        row.run.processPid !== null &&
        sameProcessStart(row.run.processStartedAt, observedRunnerStart);

      const checkpoint = profile.sessionCheckpoint;
      const checkpointRecord =
        checkpoint &&
        typeof checkpoint === "object" &&
        !Array.isArray(checkpoint)
          ? (checkpoint as Record<string, unknown>)
          : {};
      const hasCheckpoint = checkpoint !== undefined && checkpoint !== null;
      const checkpointIdentity =
        checkpointRecord.identity &&
        typeof checkpointRecord.identity === "object" &&
        !Array.isArray(checkpointRecord.identity)
          ? (checkpointRecord.identity as Record<string, unknown>)
          : {};
      const checkpointIdentityMatches =
        hasCheckpoint &&
        typeof row.run.nativeSessionId === "string" &&
        row.run.nativeSessionId.length > 0 &&
        checkpointIdentity.runId === row.run.id &&
        checkpointIdentity.companyId === row.run.companyId &&
        checkpointIdentity.issueId === row.coordinator.issueId &&
        checkpointIdentity.agentId === row.run.agentId &&
        checkpointIdentity.sessionId === row.run.nativeSessionId;
      const hasCheckpointProviderIdentity =
        (typeof checkpointRecord.providerSessionId === "string" &&
          checkpointRecord.providerSessionId.length > 0) ||
        (checkpointRecord.providerIdentity !== null &&
          typeof checkpointRecord.providerIdentity === "object" &&
          !Array.isArray(checkpointRecord.providerIdentity) &&
          Object.keys(checkpointRecord.providerIdentity).length > 0);
      const providerEvents = await tx
        .select({
          id: heartbeatRunEvents.id,
          eventType: heartbeatRunEvents.eventType,
          payload: heartbeatRunEvents.payload,
        })
        .from(heartbeatRunEvents)
        .where(
          and(
            eq(heartbeatRunEvents.runId, row.run.id),
            inArray(heartbeatRunEvents.eventType, [...NATIVE_PROVIDER_PROCESS_EVENT_TYPES]),
          ),
        )
        .orderBy(desc(heartbeatRunEvents.id))
        .limit(100);
      const providerProcessIdentities = nativeProviderProcessIdentities(checkpointRecord, providerEvents);
      const providerProcesses = await evaluateNativeProviderProcesses({
        identities: (remoteProcess ? [] : providerProcessIdentities).filter(
          (identity) => identity.pid !== row.run.processPid,
        ),
      });
      const hasProviderEvidence =
        hasCheckpointProviderIdentity || providerEvents.length > 0;

      const admissionCheckpointOnly = !hasCheckpoint || (checkpointIdentityMatches && checkpointRecord.cursor == null
        && (!Array.isArray(checkpointRecord.terminalTurns) || checkpointRecord.terminalTurns.length === 0)
        && checkpointRecord.activeTurnId == null && checkpointRecord.semanticResult == null && checkpointRecord.terminal == null
        && (checkpointRecord.pendingRuntimeRequests == null
          || (Array.isArray(checkpointRecord.pendingRuntimeRequests) && checkpointRecord.pendingRuntimeRequests.length === 0)));
      const inheritedCheckpointOnly = hasCheckpoint && admissionCheckpointOnly && remoteSandbox && !pluginTask
        && !durableAuthority && stagedAttachment === null && providerEvents.length === 0;
      const inheritedRunnerIdentity = inheritedCheckpointOnly && Boolean(row.run.processPid || row.run.processGroupId)
        && await carriesInheritedRunnerIdentity(tx, row.run);
      let unclaimedBootstrap =
        remoteWorkspace?.state === "prepared" &&
        row.run.runnerProfileJson?.nativePreparationFencingVersion === NATIVE_PREPARATION_FENCING_VERSION &&
        row.coordinator.phase === "observed" &&
        row.coordinator.attempt === 0 &&
        row.coordinator.controllerGeneration === 0 &&
        !row.coordinator.controllerBootId &&
        !row.coordinator.controllerPid &&
        !row.coordinator.controllerProcessStartedAt &&
        !row.coordinator.leaseOwner &&
        // A graceful shutdown stamps an expiry on every coordinator it
        // suspends. Without an owner, an elapsed expiry grants no authority.
        (!row.coordinator.leaseExpiresAt || row.coordinator.leaseExpiresAt <= now) &&
        !row.coordinator.failureDetail?.successorRunId &&
        (inheritedRunnerIdentity || (!row.run.processPid && !row.run.processGroupId && !row.run.processStartedAt)) &&
        !row.run.sessionIdBefore &&
        !row.run.sessionIdAfter &&
        Boolean(row.run.nativeSessionId && row.run.runnerInstanceId) &&
        (!hasCheckpoint || inheritedCheckpointOnly) &&
        (!hasProviderEvidence || inheritedCheckpointOnly);
      if (unclaimedBootstrap) {
        if (activeNativeExecutionRunIds.has(row.run.id) &&
            controller.bootId === (await currentNativeControllerIdentity()).bootId) {
          return { kind: "awaiting_evidence", runId: row.run.id, reason: "current_controller_preparing" } as const;
        }
        unclaimedBootstrap = !(await hasNativeExecutionStartEvidence(tx, row.run));
      }

      // A claimed remote run whose executor died while still preparing. The
      // executor durably records native.process_start_requested before any
      // backend may spawn a runner, and a remote runner exchanges commands only
      // through a Postgres controller checkpoint. With neither, nothing reached
      // a runner. The previous controller is gone (takeover was allowed above).
      const pendingInheritedRequests = Array.isArray(checkpointRecord.pendingRuntimeRequests)
        && checkpointRecord.pendingRuntimeRequests.length > 0;
      const continuedSessionOnly = hasCheckpoint && checkpointIdentityMatches && providerEvents.length === 0
        && !pendingInheritedRequests && checkpointRecord.activeTurnId == null && checkpointRecord.semanticResult == null
        && checkpointRecord.terminal == null;
      const remoteRunnerNeverLaunched = !unclaimedBootstrap && remoteWorkspace?.state === "prepared" && !pluginTask
        && !durableAuthority && stagedAttachment === null
        && row.run.runnerProfileJson?.nativePreparationFencingVersion === NATIVE_PREPARATION_FENCING_VERSION
        && row.coordinator.attempt >= 1 && row.coordinator.controllerGeneration >= 1
        && Boolean(row.coordinator.controllerBootId && row.coordinator.controllerPid && row.coordinator.controllerProcessStartedAt)
        // Either the executor still held the claim, or it settled a same-run
        // bootstrap retry itself (for example after a shutdown closed its local
        // runtime listener) and released the lease. That retry already proved
        // no provider session, event or checkpoint; the checks below re-prove it.
        && (row.coordinator.phase === "observed" ? Boolean(row.coordinator.leaseOwner)
          : row.coordinator.phase === "retryable_failure" && row.run.status === "failed"
            && row.coordinator.failureDetail?.recoveryMode === "bootstrap_retry" && !row.coordinator.leaseOwner)
        && !row.coordinator.failureDetail?.successorRunId
        && !row.run.processPid && !row.run.processGroupId && !row.run.processStartedAt
        && (!row.run.sessionIdBefore || continuedSessionOnly) && !row.run.sessionIdAfter
        && Boolean(row.run.nativeSessionId && row.run.runnerInstanceId)
        && (continuedSessionOnly || (!hasCheckpoint && !hasProviderEvidence))
        && !(await hasNativeExecutionStartEvidence(tx, row.run));
      // A settled retry starts new work, so it needs the same current
      // admission as the resumption reconciler: task pause, agent status,
      // dependencies, ownership and competing runs. Keep it waiting otherwise.
      // The executor relaunched a remote runner for a same-run bootstrap
      // retry, and that runner exited (observed by its transport) before any
      // provider work: the executor's settled failure durably records no
      // provider session, no provider event and no checkpoint, and none exists
      // now. The runner's own exit is the remote proof that it is gone; a
      // recorded runner PID alone would not be (Daytona wave s9301).
      const settledFailure = row.coordinator.failureDetail;
      const remoteRunnerExitedBeforeProviderWork = !unclaimedBootstrap && !remoteRunnerNeverLaunched
        && remoteWorkspace?.state === "prepared" && !pluginTask && stagedAttachment === null
        && row.run.runnerProfileJson?.nativePreparationFencingVersion === NATIVE_PREPARATION_FENCING_VERSION
        && row.coordinator.phase === "retryable_failure" && row.run.status === "failed" && !row.coordinator.leaseOwner
        && settledFailure?.recoveryMode === "bootstrap_retry"
        && settledFailure?.originalFailureCode === "native_runner_process_exited"
        && settledFailure?.providerSessionEstablished === false && settledFailure?.providerEventsExist === false
        && settledFailure?.checkpointExists === false && !settledFailure?.successorRunId
        && !row.run.sessionIdBefore && !row.run.sessionIdAfter
        && Boolean(row.run.nativeSessionId && row.run.runnerInstanceId)
        && !hasCheckpoint && !hasProviderEvidence
        // Fresh evidence wins over the saved failure: any event the runner or
        // provider sent contradicts "no provider work".
        && !(await hasNativeRunnerOriginatedEvidence(tx, row.run));
      if ((remoteRunnerNeverLaunched || remoteRunnerExitedBeforeProviderWork) && row.coordinator.phase === "retryable_failure" && !admission.exhausted
        && !await readNativeSessionResumptionAgent(tx as unknown as Db, { issue, run: row.run, coordinator: row.coordinator })) {
        const deferred = await deferRemoteRetry("native_retry_admission_ineligible", ["done", "cancelled"].includes(issue.status));
        if (deferred) return deferred;
      }

      // A claimed remote bootstrap (runner launched, perhaps connected) has no
      // provider evidence when its controller dies before session.open
      // completes. The owner's lease has expired above, and the controller
      // writes every command to Postgres before sending it, so that checkpoint
      // is the complete record of what reached the sandbox runner. When it
      // proves no provider work, bootstrap again instead of holding the task.
      // A graceful drain can also suspend a run whose runner had just opened its
      // provider session: session-open events may already be projected here,
      // but no session snapshot or turn exists. Those events alone do not make
      // the checkpoint proof ambiguous; any turn or provider event does.
      const providerEvidenceIsSessionOpenOnly = !hasCheckpointProviderIdentity
        && providerEvents.every(event => SESSION_OPEN_PROVIDER_EVENT_TYPES.has(event.eventType));
      const remoteBootstrapProof = !unclaimedBootstrap && remoteWorkspace !== null && !pluginTask
        && Boolean(durableAuthority) && stagedAttachment === null && !hasCheckpoint && providerEvidenceIsSessionOpenOnly
        && Boolean(row.run.runnerInstanceId && row.run.nativeSessionId)
        ? await nativeRunnerCheckpointRemoteBootstrapProof(tx, {
          companyId: row.run.companyId, issueId: row.coordinator.issueId, runId: row.run.id,
        }, { runnerInstanceId: row.run.runnerInstanceId!, normalizedSessionId: row.run.nativeSessionId! })
        : null;
      // Projected session-open events need the stronger session-opened proof.
      const remoteBootstrapProvenIncomplete = remoteBootstrapProof !== null
        && (!hasProviderEvidence || remoteBootstrapProof === "session_opened_without_turn");

      const remoteRunnerNeverReceivedCommands = !unclaimedBootstrap && !remoteRunnerNeverLaunched
        && !remoteRunnerExitedBeforeProviderWork && !remoteBootstrapProvenIncomplete
        && remoteSandbox && remoteWorkspace !== null && !pluginTask && !durableAuthority && stagedAttachment === null
        && admissionCheckpointOnly && providerEvents.length === 0
        && row.run.runnerProfileJson?.nativePreparationFencingVersion === NATIVE_PREPARATION_FENCING_VERSION
        && row.coordinator.phase === "observed" && Boolean(row.coordinator.leaseOwner)
        && row.coordinator.attempt >= 1 && row.coordinator.controllerGeneration >= 1
        && Boolean(row.coordinator.controllerBootId && row.coordinator.controllerPid && row.coordinator.controllerProcessStartedAt)
        && !row.coordinator.failureDetail?.successorRunId
        && !row.run.processPid && !row.run.processGroupId && !row.run.processStartedAt
        && !row.run.sessionIdBefore && !row.run.sessionIdAfter
        && Boolean(row.run.nativeSessionId && row.run.runnerInstanceId)
        && !(await hasNativeRunnerOriginatedEvidence(tx, row.run))
        && !(await hasNativeRunEvent(tx, row.run, PROCESS_IDENTITY_RECORDED));

      // Read before this claim appends its own history entry.
      const cleanDrainSuspension = suspendedByCleanDrain(row.coordinator);
      const resumeKeepsAttempt = cleanDrainSuspension || await restartResumeKeepsAttempt(tx, {
        runId: row.run.id, coordinator: row.coordinator,
      });
      const classification = classifyNativeRunnerRecoveryEvidence({
        remoteSandbox: remoteSandbox || Boolean(pluginTask && durableAuthority),
        unclaimedBootstrap,
        remoteBootstrapProvenIncomplete: remoteBootstrapProvenIncomplete || remoteRunnerNeverLaunched
          || remoteRunnerExitedBeforeProviderWork || remoteRunnerNeverReceivedCommands,
        remoteBootstrapIncompleteReason: remoteRunnerNeverLaunched ? "remote_runner_never_launched"
          : remoteRunnerExitedBeforeProviderWork ? "remote_runner_exited_before_provider_work"
          : remoteRunnerNeverReceivedCommands ? "remote_runner_never_received_commands"
          : remoteBootstrapProof === "session_opened_without_turn" ? "remote_session_opened_without_turn" : undefined,
        runnerPidAlive,
        runnerGroupAlive,
        processStartMatches: exactRunnerIdentity,
        knownProviderProcessAlive: providerProcesses.livePids.length > 0,
        knownProviderProcessIdentityAmbiguous:
          providerProcesses.ambiguousLivePids.length > 0,
        hasCheckpoint: hasCheckpoint && !remoteRunnerNeverReceivedCommands && !(unclaimedBootstrap && inheritedCheckpointOnly)
          && !remoteRunnerNeverLaunched,
        stagedAttachmentVerified: stagedAttachment !== null,
        checkpointIdentityMatches:
          checkpointIdentityMatches &&
          (!remoteSandbox || remoteWorkspace !== null),
        hasProviderEvidence: hasProviderEvidence && !(unclaimedBootstrap && inheritedCheckpointOnly),
        checkpointFailed:
          (checkpointRecord.terminal as Record<string, unknown> | undefined)
            ?.runTerminalState === "failed" &&
          nativeRestartInterruptedTurnId(checkpointRecord as unknown as PersistedNativeSession) === null &&
          !nativeRestartContinuationInFlight(checkpointRecord as unknown as PersistedNativeSession),
        providerAttempt: row.coordinator.attempt,
        resumeChargesAttempt: !resumeKeepsAttempt,
      });
      if (stopCleanup && classification.claimKind !== "reattach_remote_runner") {
        return { kind: "blocked", runId: row.run.id, reason: "native_stop_requires_existing_remote_session" } as const;
      }
      const ownershipChanged =
        row.issueAssigneeAgentId !== row.run.agentId ||
        ["done", "cancelled"].includes(row.issueStatus);
      if (needsResumptionAdmission && (!durableAuthority || ownershipChanged || classification.claimKind !== "reattach_remote_runner")) {
        if (!admission.exhausted) {
          const deferred = await deferRemoteRetry("native_retry_remote_authority_unverified");
          if (deferred) return deferred;
        }
      }

      const hold = admission.exhausted;
      const preserveExecutionBinding = hold !== null;
      const claimKind = hold || ownershipChanged || exhaustedRemoteRetry ? null : classification.claimKind;
      const reason = hold?.reason ?? (ownershipChanged
        ? "task_ownership_or_status_changed"
        : exhaustedRemoteRetry ? "execution_recovery_budget_exhausted" : classification.reason);
      const nextAction = hold
        ? "Automatic admission checks exhausted. The original executor stop and state remain unverified. The provider PID, checkpoint and task bindings are preserved; reconcile that execution before starting fresh work."
        : "Inspect the preserved checkpoint and reconcile the previous execution before starting a fresh session.";

      if (!claimKind) {
        const generation = row.coordinator.controllerGeneration;
        const event = historyEntry({
          now,
          restartKind: input.restartKind,
          controller,
          generation,
          disposition: "blocked",
          reason,
          requestId: input.recoveryRequestId ?? null,
          providerAttempt: row.coordinator.attempt,
          processPid: row.run.processPid,
          processStartedAt: row.run.processStartedAt,
          hasCheckpoint,
          checkpointIdentityMatches,
          hasProviderEvidence,
          knownProviderPids: providerProcesses.knownPids,
          liveProviderPids: providerProcesses.livePids,
          ambiguousProviderPids: providerProcesses.ambiguousLivePids,
          recycledProviderPids: providerProcesses.recycledPids,
          stderrTail: row.run.stderrExcerpt,
        });
        await notifyExecutionRunWork(tx, { companyId: row.run.companyId });
        await tx
          .update(nativeRunFinalizations)
          .set({
            phase: "terminal_failure",
            leaseOwner: null,
            leaseExpiresAt: null,
            nextAttemptAt: null,
            failureCode: "native_restart_recovery_blocked",
            failureDetail: {
              ...row.coordinator.failureDetail,
              ...(hold ? { systemRecovery: hold.policy } : {}),
              reason,
              nextAction,
            },
            recoveryState: "blocked",
            recoveryRequestId: input.recoveryRequestId ?? null,
            recoveryHistory: appendBoundedRecoveryHistory(event),
            updatedAt: now,
          })
          .where(
            and(
              eq(nativeRunFinalizations.runId, row.run.id),
              eq(nativeRunFinalizations.attempt, row.coordinator.attempt),
              eq(nativeRunFinalizations.phase, row.coordinator.phase),
            ),
          );
        if (!preserveExecutionBinding) {
          await notifyExternalAgentSettlement(tx, { companyId: row.run.companyId, runId: row.run.id });
          await notifyNativeEnvironmentSettlement(tx, { companyId: row.run.companyId, runId: row.run.id });
          await notifyInstructionCollection(tx, { companyId: row.run.companyId, runId: row.run.id });
          await notifyCancelledWorkspacePreservation(tx, { companyId: row.run.companyId, runId: row.run.id });
          await notifyUnsafeWorkspaceExportRunChange(tx, row.run);
        }
        const [updatedRun] = await tx
          .update(heartbeatRuns)
          .set({
            status: "failed",
            nativePhase: "terminal_failure",
            nativePhaseUpdatedAt: now,
            executionStatusDeliveryId: randomUUID(),
            finishedAt: now,
            errorCode: "native_restart_recovery_blocked",
            error: reason,
            updatedAt: now,
          })
          .where(eq(heartbeatRuns.id, row.run.id))
          .returning();
        if (updatedRun && isNewTerminalRunFailure(row.run, updatedRun)) {
          terminalRunToReport = updatedRun;
        }
        await notifyNativeStatusReassessment(tx, { companyId: row.run.companyId, issueId: row.coordinator.issueId });
        if (!preserveExecutionBinding) await tx
          .update(issues)
          .set({ executionRunId: null, updatedAt: now })
          .where(
            and(
              eq(issues.id, row.coordinator.issueId),
              eq(issues.companyId, row.run.companyId),
              eq(issues.executionRunId, row.run.id),
            ),
          );
        if (!preserveExecutionBinding) await tx
          .update(issues)
          .set({ checkoutRunId: null, updatedAt: now })
          .where(
            and(
              eq(issues.id, row.coordinator.issueId),
              eq(issues.companyId, row.run.companyId),
              eq(issues.checkoutRunId, row.run.id),
            ),
          );
        if (
          preserveExecutionBinding || (row.issueAssigneeAgentId === row.run.agentId &&
          !["done", "cancelled"].includes(row.issueStatus))
        )
          await issueRecoveryActionService(
            tx as unknown as Db,
          ).upsertSourceScoped({
            companyId: row.run.companyId,
            sourceIssueId: row.coordinator.issueId,
            kind: "active_run_watchdog",
            ownerType: "board",
            returnOwnerAgentId: row.run.agentId,
            cause: "native_restart_recovery_blocked",
            fingerprint: `native-restart:${row.run.id}`,
            evidence: {
              runId: row.run.id,
              reason,
              providerAttempt: row.coordinator.attempt,
              ...(hold ? { automaticAdmissionExhausted: true, executorStopEvidence: "unverified",
                providerPid: row.run.processPid, checkpointPreserved: hasCheckpoint } : {}),
            },
            nextAction,
            maxAttempts: 3,
            wakePolicy: null,
            supersedeOnIdentityChange: true,
          });
        if (updatedRun && !preserveExecutionBinding) await preserveNativeFailedWorkspace(tx as unknown as Db, updatedRun);
        return { kind: "blocked", runId: row.run.id, reason } as const;
      }

      const providerAttempt = failedRemoteRetry
        ? nextNativeProviderAttempt(row.coordinator.attempt)
        : row.coordinator.attempt;
      const generation = row.coordinator.controllerGeneration + 1;
      const leaseOwner = `${controller.bootId}:${generation}:${randomUUID()}`;
      const event = historyEntry({
        now,
        restartKind: input.restartKind,
        controller,
        generation,
        disposition: claimKind,
        reason,
        requestId: input.recoveryRequestId ?? null,
        providerAttempt,
        processPid: row.run.processPid,
        processStartedAt: row.run.processStartedAt,
        hasCheckpoint,
        checkpointIdentityMatches,
        hasProviderEvidence,
        knownProviderPids: providerProcesses.knownPids,
        liveProviderPids: providerProcesses.livePids,
        ambiguousProviderPids: providerProcesses.ambiguousLivePids,
        recycledProviderPids: providerProcesses.recycledPids,
        stderrTail: row.run.stderrExcerpt,
      });
      // The next claim credits this resume only for work recorded after here.
      const progressWatermarkSeq = await nativeRunEventWatermark(tx, row.run.id);
      const attemptKeptForProgress = resumeKeepsAttempt && !cleanDrainSuspension;
      // The attempt the executor runs this resume as (see its execution claim).
      const progressAttempt = nextNativeProviderAttempt(providerAttempt, claimKind, !resumeKeepsAttempt);
      await notifyLiveRunRecovery(tx, { companyId: row.run.companyId, runId: row.run.id, agentId: row.run.agentId });
      currentControllerProcessStamp();
      const claimed = await tx
        .update(nativeRunFinalizations)
        .set({
          phase: "observed",
          attempt: providerAttempt,
          leaseOwner,
          // Cleanup and earlier candidates can outlive the batch observation.
          // The owner row is locked: grant the full lease at this write.
          leaseExpiresAt: sql`clock_timestamp() + ${durableAuthority ? REMOTE_CONTROLLER_LEASE_MS : 20 * 60_000} * interval '1 millisecond'`,
          controllerBootId: controller.bootId,
          controllerHostHash,
          controllerPid: controller.pid,
          controllerProcessStartedAt: controller.processStartedAt,
          controllerGeneration: generation,
          recoveryState:
            claimKind === "reattach_existing_runner" ||
            claimKind === "reattach_remote_runner"
              ? "awaiting_runner_reattach"
              : claimKind === "resume_dead_runner"
                ? "resuming_session"
                : "bootstrap_incomplete",
          recoveryRequestId: input.recoveryRequestId ?? null,
          recoveryHistory: appendBoundedRecoveryHistory({
            ...event, progressWatermarkSeq, progressAttempt, ...(attemptKeptForProgress ? { attemptKeptForProgress } : {}),
          }),
          failureCode: null,
          nextAttemptAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(nativeRunFinalizations.runId, row.run.id),
            eq(nativeRunFinalizations.attempt, row.coordinator.attempt),
            eq(nativeRunFinalizations.phase, row.coordinator.phase),
            row.coordinator.leaseOwner === null
              ? isNull(nativeRunFinalizations.leaseOwner)
              : eq(
                  nativeRunFinalizations.leaseOwner,
                  row.coordinator.leaseOwner,
                ),
          ),
        )
        .returning({ runId: nativeRunFinalizations.runId })
        .then((rows) => rows[0] ?? null);
      if (!claimed) {
        return {
          kind: "awaiting_evidence",
          runId: row.run.id,
          reason: "concurrent_recovery_claim",
        } as const;
      }

      // A successful ordinary claim has now reconciled this exact earlier
      // authority. Retire only its namespace attention; stale/other incidents
      // remain owned and no operator confirmation is fabricated.
      await issueRecoveryActionService(tx as unknown as Db).resolveActiveForIssue({
        companyId: row.run.companyId, sourceIssueId: row.coordinator.issueId,
        kind: "active_run_watchdog", cause: "native_restart_recovery_blocked",
        fingerprint: `native-controller-space:${row.run.id}:${nativeControllerAuthorityDigest(row.coordinator, row.controllerLeaseExpiryEpoch)}`,
        status: "resolved", outcome: "restored",
        resolutionNote: "Normal restart recovery verified the previous authority and committed its exact replacement claim.",
      }, tx);

      if (
        claimKind !== "reattach_existing_runner" &&
        claimKind !== "reattach_remote_runner"
      ) {
        await recordNativeLocalProcessStopInTransaction(tx as unknown as Db, row.run);
      }

      await tx
        .update(heartbeatRuns)
        .set({
          status: "running",
          finishedAt: null,
          error: null,
          errorCode: null,
          nativePhase: "observed",
          nativePhaseUpdatedAt: now,
          ...(claimKind === "reattach_existing_runner" ||
          claimKind === "reattach_remote_runner"
            ? {}
            : {
                processPid: null,
                processGroupId: null,
                processStartedAt: null,
              }),
          updatedAt: now,
        })
        .where(eq(heartbeatRuns.id, row.run.id));

      if (releasedRemoteRetry && resumptionAgent) {
        await restoreNativeSessionExecution(tx as unknown as Db, { issue, run: row.run, agentName: resumptionAgent.name, now });
      }

      claimScope = { companyId: row.run.companyId, issueId: row.coordinator.issueId, controller, remote: Boolean(durableAuthority) };
      const common = {
        runId: row.run.id,
        leaseOwner,
        controllerGeneration: generation,
        providerAttempt,
        restartKind: input.restartKind,
        recoveryRequestId: input.recoveryRequestId ?? null,
        chargesProviderAttempt: !resumeKeepsAttempt,
      };
      if (claimKind === "reattach_remote_runner") {
        return {
          kind: claimKind,
          ...common,
          ...(stagedAttachment ? { stagedAttachment: {
            sourceIdentity: stagedAttachment.sourceIdentity, targetIdentity: stagedAttachment.targetIdentity,
            templateDigest: stagedAttachment.templateDigest,
          } } : {}),
          remote: pluginTask ? { kind: "plugin_task", leaseId: pluginTask.id } : {
            providerLeaseId: remoteWorkspace!.providerLeaseId,
            remoteCwd: remoteWorkspace!.remoteCwd,
          },
        } satisfies NativeRestartRecoveryClaim;
      }
      if (claimKind === "reattach_existing_runner") {
        return {
          kind: claimKind,
          ...common,
          process: {
            pid: row.run.processPid!,
            processGroupId: row.run.processGroupId,
            startedAt: row.run.processStartedAt!.toISOString(),
          },
        } satisfies NativeRestartRecoveryClaim;
      }
      return {
        kind: claimKind,
        ...common,
      } satisfies NativeRestartRecoveryClaim;
    }).catch((error: unknown) => {
      // The whole candidate transaction rolled back, so this run's state is
      // unchanged and nothing was claimed. Keep the obligation on the existing
      // recovery deadline and continue the batch: one run must not stop
      // startup recovery.
      terminalRunToReport = null;
      claimScope = undefined;
      const routineBusy = isUniqueViolation(error, "issues_open_routine_execution_uq");
      if (!routineBusy) {
        logger.error({ err: error, runId: candidate.runId }, "native restart recovery failed for one run; deferring it");
      }
      return { kind: "awaiting_evidence" as const, runId: candidate.runId,
        reason: routineBusy ? "routine_execution_busy" : NATIVE_RESTART_RECOVERY_FAILED,
        retryAt: new Date(now.getTime() + 30_000) };
    });
    if (terminalRunToReport)
      void reportRunFailure(input.db, terminalRunToReport);
    if (claimScope && "leaseOwner" in disposition) input.onClaim?.(disposition, claimScope);
    dispositions.push(disposition);
  }
  return dispositions;
}

export async function nativeRestartRecoverySummary(db: Db) {
  const rows = await db
    .select({
      state: nativeRunFinalizations.recoveryState,
      count: sql<number>`count(*)::int`,
    })
    .from(nativeRunFinalizations)
    .where(
      inArray(nativeRunFinalizations.recoveryState, [
        "awaiting_evidence",
        "awaiting_runner_reattach",
        "resuming_session",
        "bootstrap_incomplete",
        "blocked",
      ]),
    )
    .groupBy(nativeRunFinalizations.recoveryState);
  return Object.fromEntries(
    rows.map((row) => [row.state ?? "unknown", row.count]),
  );
}
