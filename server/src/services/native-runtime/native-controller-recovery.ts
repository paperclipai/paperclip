import { and, eq, ne, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, issues, nativeRunFinalizations, nativeRunnerCheckpoints, type Db } from "@paperclipai/db";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { DurablePrpCheckpoint, PersistedNativeSession } from "../../vendor/paperclip-runner/index.js";
import { notifyNativeFinalizationWork } from "../native-finalization-notifications.js";
import { readRunCancellation } from "../run-cancellation.js";
import { nativeSha256 } from "./canonical.js";
import { findNativeSessionResumeRun, isNativeSessionId, isUnusedNativeSessionBootstrap, nativeSessionProviderEvidence } from "./native-session-resume.js";
import { loadNativeRunnerCheckpoint } from "./native-runner-checkpoint.js";
import { redactRunnerApiPayloads } from "./runner-api-log-redaction.js";

export const NATIVE_CONTROLLER_RECOVERY_MAX_BYTES = 4 * 1024;

/** Private run-profile metadata. No credentials or controller-local paths. */
export interface NativeControllerRecovery {
  schema: "paperclip.native-controller-recovery.v1";
  snapshotSha256: string;
  configDigest: string;
  processConfigDigest: string | null;
  checkpoint: {
    runId: string;
    runnerInstanceId: string;
    normalizedSessionId: string;
  } | null;
}

export type NativeControllerCompatibility = Pick<NativeControllerRecovery, "configDigest" | "processConfigDigest">;

export function createNativeControllerRecovery(
  snapshot: PersistedNativeSession,
  compatibility: NativeControllerCompatibility,
  checkpoint: NativeControllerRecovery["checkpoint"],
): NativeControllerRecovery {
  const value: NativeControllerRecovery = {
    schema: "paperclip.native-controller-recovery.v1",
    snapshotSha256: nativeSha256(snapshot),
    configDigest: compatibility.configDigest,
    processConfigDigest: compatibility.processConfigDigest,
    checkpoint,
  };
  if (Buffer.byteLength(JSON.stringify(value)) > NATIVE_CONTROLLER_RECOVERY_MAX_BYTES) {
    throw new Error("native_controller_recovery_metadata_too_large");
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function readNativeControllerRecovery(value: unknown, snapshot: unknown): NativeControllerRecovery | null {
  const envelope = record(value), checkpoint = record(envelope.checkpoint);
  if (Buffer.byteLength(JSON.stringify(value) ?? "null") > NATIVE_CONTROLLER_RECOVERY_MAX_BYTES
    || envelope.schema !== "paperclip.native-controller-recovery.v1"
    || typeof envelope.snapshotSha256 !== "string" || envelope.snapshotSha256 !== nativeSha256(snapshot)
    || typeof envelope.configDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(envelope.configDigest)
    || !(envelope.processConfigDigest === null || (typeof envelope.processConfigDigest === "string" && /^[a-f0-9]{64}$/.test(envelope.processConfigDigest)))
    || ![checkpoint.runId, checkpoint.runnerInstanceId, checkpoint.normalizedSessionId].every(v => typeof v === "string" && v.length > 0)) return null;
  return envelope as unknown as NativeControllerRecovery;
}

export type NativeControllerRecoveryOutcome =
  | { kind: "recoverable"; snapshot: PersistedNativeSession; metadata: NativeControllerRecovery; checkpoint: DurablePrpCheckpoint }
  | { kind: "waiting_for_owner"; deadline: Date }
  | { kind: "missing_evidence" | "unsupported" | "dependency_unavailable"; reason: string; cause?: unknown }
  | { kind: "no_prior_execution" };

export const NATIVE_RETAINED_OWNER_WAIT = "native_controller_recovery_waiting_for_owner";

export class NativeControllerRecoveryWaitingError extends Error {
  constructor(readonly retryAt: Date) {
    super(NATIVE_RETAINED_OWNER_WAIT);
    this.name = "NativeControllerRecoveryWaitingError";
  }
}

/** Admission has not crossed the provider boundary. Retain this same business
 * run on the existing retry owner; never turn an ownership wait into a failure
 * or invent a new provider attempt. The usual resumption gates recheck Stop,
 * permissions and task ownership when this deadline arrives. */
export async function deferNativeControllerRecovery(db: Db, input: {
  companyId: string; agentId: string; issueId: string; runId: string;
  leaseOwner?: string; retryAt: Date;
}): Promise<void> {
  await db.transaction(async tx => {
    const [task] = await tx.select({ executionRunId: issues.executionRunId }).from(issues)
      .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))).for("update");
    const [owner] = await tx.select().from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.companyId, input.companyId), eq(nativeRunFinalizations.issueId, input.issueId),
      eq(nativeRunFinalizations.runId, input.runId))).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.nativeIssueId, input.issueId))).for("update");
    const [authority] = await tx.select({ runId: nativeRunnerCheckpoints.runId }).from(nativeRunnerCheckpoints)
      .where(and(eq(nativeRunnerCheckpoints.companyId, input.companyId), eq(nativeRunnerCheckpoints.runId, input.runId))).limit(1);
    const progress = await nativeSessionProviderEvidence(tx as unknown as Db, [input.runId]);
    const cancellation = record(run?.resultJson?.nativeCancellation);
    const stop = readRunCancellation(run?.resultJson);
    const [clock] = await tx.execute<{ now: Date }>(sql`select clock_timestamp() as now`);
    if (!run || run.runtimeMode !== "native" || run.status !== "running" || task?.executionRunId !== input.runId
      || !owner || owner.phase !== "observed" || owner.resultId || owner.attempt !== 0
      || owner.controllerGeneration !== 0 || owner.leaseOwner !== (input.leaseOwner ?? null)
      || (input.leaseOwner && (!owner.leaseExpiresAt || owner.leaseExpiresAt <= new Date(clock.now)))
      || run.processPid || run.processGroupId || run.processStartedAt || authority || progress.size
      || !record(run.runnerProfileJson).nativeExecutionInput || run.resultJson?.startupCancellation
      || (stop?.source === "operator" && stop.expected)
      || (["run", "issue"].includes(String(cancellation.scope)) && ["pending", "acknowledged"].includes(String(cancellation.dispatchState)))) {
      throw new Error("native_controller_recovery_wait_authority_changed");
    }
    await notifyNativeFinalizationWork(tx, input);
    await tx.update(nativeRunFinalizations).set({
      phase: "retryable_failure", leaseOwner: null, leaseExpiresAt: null, controlDeadlineAt: null,
      nextAttemptAt: input.retryAt, recoveryState: "resuming_session", failureCode: NATIVE_RETAINED_OWNER_WAIT,
      failureDetail: { originalFailureCode: NATIVE_RETAINED_OWNER_WAIT,
        message: "Waiting for the retained native controller owner to release its lease.",
        recoveryMode: record(run.runnerProfileJson).sessionCheckpoint ? "same_session_resume" : "bootstrap_retry",
        providerSessionEstablished: false, providerEventsExist: false },
      updatedAt: new Date(),
    }).where(eq(nativeRunFinalizations.runId, input.runId));
  });
}

/** Bind a read of retained Runner lifecycle to the surviving sandbox. The
 * ordinary admission owner still checks current permissions before execution. */
export async function assertNativeRetainedSandboxBinding(db: Db, input: {
  companyId: string; issueId: string; runId: string;
  target: Extract<AdapterExecutionTarget, { kind: "remote" }>;
}): Promise<void> {
  const { target } = input;
  if (target.transport !== "sandbox" || target.sandboxLeaseAcquisition?.outcome !== "resumed"
    || !target.providerKey || !target.environmentId || !target.leaseId) {
    throw new Error("native_controller_recovery_dependency_unavailable:retained_sandbox");
  }
  const [owner] = await db.select().from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, input.companyId), eq(nativeRunFinalizations.issueId, input.issueId),
    eq(nativeRunFinalizations.runId, input.runId)));
  const leases = await db.select({ metadata: environmentLeases.metadata, status: environmentLeases.status }).from(environmentLeases).where(and(
    eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.issueId, input.issueId),
    eq(environmentLeases.heartbeatRunId, input.runId), eq(environmentLeases.environmentId, target.environmentId),
    eq(environmentLeases.provider, target.providerKey), eq(environmentLeases.providerLeaseId, target.sandboxLeaseAcquisition.providerLeaseId)));
  if (!owner || owner.leaseOwner || owner.phase !== "committed" || !owner.resultId || owner.recoveryState
    || leases.length !== 1 || leases[0].metadata?.remoteCwd !== target.remoteCwd
    || !["active", "released", "expired"].includes(leases[0].status)) {
    throw new Error("native_controller_recovery_missing_evidence:retained_sandbox_binding");
  }
}

/** Only the existing bounded selector chooses history. Never search backwards
 * again when its selected record is incomplete or incompatible. This operation
 * reads evidence; it grants neither command nor acknowledgement authority. */
export async function resolveNativeControllerRecovery(db: Db, input: {
  companyId: string; agentId: string; issueId: string; normalizedSessionId: string; currentRunId: string;
}): Promise<NativeControllerRecoveryOutcome> {
  if (!isNativeSessionId(input.normalizedSessionId)) return { kind: "missing_evidence", reason: "session_binding" };
  const [current] = await db.select({ createdAt: heartbeatRuns.createdAt, processPid: heartbeatRuns.processPid,
    processGroupId: heartbeatRuns.processGroupId, processStartedAt: heartbeatRuns.processStartedAt,
    runnerProfileJson: heartbeatRuns.runnerProfileJson }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, input.currentRunId), eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.nativeIssueId, input.issueId),
    eq(heartbeatRuns.nativeSessionId, input.normalizedSessionId)));
  if (!current) return { kind: "missing_evidence", reason: "current_binding" };
  const source = await findNativeSessionResumeRun(db, { ...input, beforeCreatedAt: current.createdAt, includeProgressBarrier: true });
  if (!source) {
    // An exhausted candidate window is unknown history, not fresh-bootstrap
    // proof. Read only IDs, and retain the selector's existing 32-row boundary.
    const prior = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      ne(heartbeatRuns.id, input.currentRunId), eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.nativeIssueId, input.issueId),
      eq(heartbeatRuns.nativeSessionId, input.normalizedSessionId))).limit(33);
    if (prior.length > 32) return { kind: "missing_evidence", reason: "candidate_window_exhausted" };
    const progress = await nativeSessionProviderEvidence(db, [input.currentRunId]);
    if (!isUnusedNativeSessionBootstrap(current, progress.has(input.currentRunId))) {
      return { kind: "missing_evidence", reason: "current_execution_progress" };
    }
    // The normal admission and remote untouched-session claim still execute.
    return { kind: "no_prior_execution" };
  }
  const [owner] = await db.select({ leaseOwner: nativeRunFinalizations.leaseOwner, leaseExpiresAt: nativeRunFinalizations.leaseExpiresAt }).from(nativeRunFinalizations)
    .where(and(eq(nativeRunFinalizations.runId, source.id), eq(nativeRunFinalizations.companyId, input.companyId),
      eq(nativeRunFinalizations.issueId, input.issueId)));
  if (owner?.leaseOwner && owner.leaseExpiresAt && owner.leaseExpiresAt.getTime() > Date.now()) {
    return { kind: "waiting_for_owner", deadline: owner.leaseExpiresAt };
  }
  if (source.runtimeMode !== "native" || !["succeeded", "failed", "cancelled", "interrupted", "timed_out"].includes(source.status)
    || source.createdAt > current.createdAt) return { kind: "missing_evidence", reason: "newer_progress_barrier" };
  const profile = record(source.runnerProfileJson), snapshot = record(profile.sessionCheckpoint);
  const identity = record(snapshot.identity);
  if (identity.companyId !== input.companyId || identity.agentId !== input.agentId
    || identity.issueId !== input.issueId || identity.runId !== source.id || identity.sessionId !== input.normalizedSessionId) {
    return { kind: "missing_evidence", reason: "snapshot_binding" };
  }
  if (record(profile.nativeControllerRecovery).schema !== "paperclip.native-controller-recovery.v1") {
    return { kind: "unsupported", reason: "metadata_format" };
  }
  const metadata = readNativeControllerRecovery(profile.nativeControllerRecovery, snapshot);
  if (!metadata?.checkpoint || metadata.checkpoint.runId !== source.id
    || metadata.checkpoint.normalizedSessionId !== input.normalizedSessionId
    || metadata.checkpoint.runnerInstanceId !== source.runnerInstanceId) {
    return { kind: "missing_evidence", reason: "snapshot_digest_or_checkpoint_binding" };
  }
  let checkpoint: DurablePrpCheckpoint | null;
  try {
    checkpoint = await loadNativeRunnerCheckpoint(db, { companyId: input.companyId, issueId: input.issueId, runId: source.id });
  } catch (cause) {
    return { kind: "dependency_unavailable", reason: "checkpoint_authority_unreadable", cause };
  }
  if (!checkpoint || checkpoint.recoveryEvidence.runnerInstanceId !== metadata.checkpoint.runnerInstanceId
    || checkpoint.recoveryEvidence.normalizedSessionId !== input.normalizedSessionId) {
    return { kind: "missing_evidence", reason: "checkpoint_binding" };
  }
  return { kind: "recoverable", snapshot: snapshot as unknown as PersistedNativeSession, metadata, checkpoint };
}

/** Bounded internal migration of ONE retained source while its disk is available.
 * The migration owner supplies compatibility computed from the admitted input.
 * This never repairs/replaces the saved snapshot or claims a live execution. */
export async function importNativeControllerRecovery(db: Db, input: {
  companyId: string; agentId: string; issueId: string; runId: string; normalizedSessionId: string;
  expectedConfigDigest: string;
  supervisor: unknown;
}): Promise<{ kind: "imported" | "unchanged" } | Exclude<NativeControllerRecoveryOutcome, { kind: "recoverable" } | { kind: "no_prior_execution" }>> {
  const supervisor = record(input.supervisor);
  if (supervisor.schema !== "paperclip.native-session-supervisor.v1" || supervisor.configDigest !== input.expectedConfigDigest) {
    return { kind: "unsupported", reason: "supervisor_compatibility" };
  }
  return db.transaction(async tx => {
    const [task] = await tx.select({ executionRunId: issues.executionRunId }).from(issues)
      .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))).for("share");
    const [owner] = await tx.select().from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.companyId, input.companyId), eq(nativeRunFinalizations.issueId, input.issueId),
      eq(nativeRunFinalizations.runId, input.runId))).for("update");
    if (!task || !owner) return { kind: "missing_evidence" as const, reason: "owner_binding" };
    if (owner.leaseOwner || task.executionRunId) {
      return owner.leaseExpiresAt && owner.leaseExpiresAt > new Date()
        ? { kind: "waiting_for_owner" as const, deadline: owner.leaseExpiresAt }
        : { kind: "missing_evidence" as const, reason: "normal_ownership_recovery_required" };
    }
    if (owner.phase !== "committed" || !owner.resultId || owner.recoveryState) {
      return { kind: "missing_evidence" as const, reason: "pending_finalization" };
    }
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.runId),
      eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId),
      eq(heartbeatRuns.nativeIssueId, input.issueId), eq(heartbeatRuns.nativeSessionId, input.normalizedSessionId))).for("update");
    const profile = record(run?.runnerProfileJson), snapshot = record(profile.sessionCheckpoint), identity = record(snapshot.identity);
    if (run?.runtimeMode !== "native" || run.status !== "succeeded" || !run.finishedAt
      || identity.runId !== input.runId || identity.companyId !== input.companyId || identity.issueId !== input.issueId
      || identity.agentId !== input.agentId || identity.sessionId !== input.normalizedSessionId
      || nativeSha256(snapshot) !== nativeSha256(redactRunnerApiPayloads(supervisor.snapshot))) {
      return { kind: "missing_evidence" as const, reason: "stale_supervisor_snapshot" };
    }
    const checkpoint = await loadNativeRunnerCheckpoint(tx, input);
    if (!checkpoint || checkpoint.recoveryEvidence.normalizedSessionId !== input.normalizedSessionId
      || checkpoint.recoveryEvidence.runnerInstanceId !== run.runnerInstanceId) {
      return { kind: "missing_evidence" as const, reason: "checkpoint_binding" };
    }
    const metadata = createNativeControllerRecovery(snapshot as unknown as PersistedNativeSession, {
      configDigest: input.expectedConfigDigest,
      processConfigDigest: typeof supervisor.processConfigDigest === "string" ? supervisor.processConfigDigest : null,
    }, { runId: input.runId, runnerInstanceId: checkpoint.recoveryEvidence.runnerInstanceId, normalizedSessionId: input.normalizedSessionId });
    if (!readNativeControllerRecovery(metadata, snapshot)) return { kind: "unsupported" as const, reason: "metadata_format" };
    if (profile.nativeControllerRecovery) {
      return nativeSha256(profile.nativeControllerRecovery) === nativeSha256(metadata)
        ? { kind: "unchanged" as const }
        : { kind: "missing_evidence" as const, reason: "existing_metadata_conflict" };
    }
    await tx.update(heartbeatRuns).set({ runnerProfileJson: { ...profile, nativeControllerRecovery: metadata }, updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, input.runId));
    return { kind: "imported" as const };
  });
}
