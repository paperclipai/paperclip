import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ENVIRONMENT_LEASE_POLICIES, WORKSPACE_SOURCE_VERIFICATION_REASONS,
  type WorkspaceSourceVerificationFailure } from "@paperclipai/shared";

export const SYSTEM_RECOVERY_POLICY_VERSION = 1;
export const SYSTEM_RECOVERY_MAX_RETRIES = 5;
export const SYSTEM_RECOVERY_WINDOW_MS = 30 * 60_000;
export function infrastructureRetryDelayMs(retryNumber: number, sample: number) {
  return Math.round(30_000 * 2 ** (retryNumber - 1) * (0.8 + Math.min(1, Math.max(0, sample)) * 0.4));
}
/** Assumed provider limit cooldown when the provider reports no reset time. */
export const PROVIDER_LIMIT_DEFAULT_COOLDOWN_MS = 60 * 60_000;

export const recoveryFailureCodes = [
  "historical_source_missing", "source_binding_invalid", "allocation_ownership_ambiguous",
  "agent_stop_unconfirmed", "copyback_stop_unconfirmed", "workspace_writer_active",
  "provider_unavailable", "export_interrupted", "archive_unsafe", "snapshot_verification_failed",
  "source_unavailable", "effect_unresolved",
] as const;
export type RecoveryFailureCode = typeof recoveryFailureCodes[number];
export const recoveryRetryClasses = [
  "retry_transient", "recheck_evidence", "use_alternative_strategy", "service_required", "user_action_required",
] as const;
export type RecoveryRetryClass = typeof recoveryRetryClasses[number];

export class SystemRecoveryFailure extends Error {
  constructor(readonly code: RecoveryFailureCode, readonly retryClass: RecoveryRetryClass, message = code,
    readonly sourceVerification?: WorkspaceSourceVerificationFailure) {
    super(message);
  }
}

export const workspaceSourceVerificationFailureSchema = z.object({
  reason: z.enum(WORKSPACE_SOURCE_VERIFICATION_REASONS),
  observedLeasePolicy: z.enum([...ENVIRONMENT_LEASE_POLICIES, "unrecognized"]).optional(),
});

/** Why an attempt failed, in closed labels only. Provider text never appears. */
export const recoveryFailureCauseSchema = z.object({
  label: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/),
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/).nullable(),
  status: z.number().int().min(100).max(599).nullable(),
});
export type RecoveryFailureCause = z.infer<typeof recoveryFailureCauseSchema>;

export const systemRecoverySchema = z.object({
  schema: z.literal("paperclip.system-recovery.v1"),
  policyVersion: z.literal(SYSTEM_RECOVERY_POLICY_VERSION),
  sourceRunId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  generationId: z.string().uuid(),
  intentId: z.string().uuid().nullable(),
  phase: z.enum(["verify_execution", "preserve_files", "reconcile_effects", "settle_result_or_dispatch"]),
  state: z.enum(["scheduled", "running", "awaiting_evidence", "exhausted", "complete"]),
  attemptId: z.string().uuid().nullable(),
  attempts: z.number().int().nonnegative(),
  retriesUsed: z.number().int().min(0).max(SYSTEM_RECOVERY_MAX_RETRIES),
  firstFailureAt: z.number().nullable(),
  nextAttemptAt: z.number().nullable(),
  deadlineAt: z.number().nullable(),
  providerCooldownAt: z.number().nullable().default(null),
  failure: z.object({
    code: z.enum(recoveryFailureCodes),
    retryClass: z.enum(recoveryRetryClasses),
    evidenceFingerprint: z.string(),
    sourceVerification: workspaceSourceVerificationFailureSchema.optional(),
    cause: recoveryFailureCauseSchema.optional(),
  }).nullable(),
  preservationOperationIds: z.array(z.string().uuid()),
  freshAttemptRunId: z.string().uuid().nullable(),
});
export type SystemRecoveryState = z.infer<typeof systemRecoverySchema>;

export function readSystemRecovery(evidence: Record<string, unknown> | null | undefined): SystemRecoveryState | null {
  const parsed = systemRecoverySchema.safeParse(evidence?.systemRecovery);
  return parsed.success ? parsed.data : null;
}

/** New generations require new intent or one-time policy adoption, never a sweep. */
export function createSystemRecovery(sourceRunId: string, intentId: string | null = null): SystemRecoveryState {
  return {
    schema: "paperclip.system-recovery.v1", policyVersion: SYSTEM_RECOVERY_POLICY_VERSION,
    sourceRunId, revision: 0, generationId: intentId ?? randomUUID(), intentId,
    phase: "verify_execution", state: "scheduled", attemptId: null, attempts: 0, retriesUsed: 0,
    firstFailureAt: null, nextAttemptAt: null, deadlineAt: null, providerCooldownAt: null, failure: null,
    preservationOperationIds: [], freshAttemptRunId: null,
  };
}

export function reserveSystemRecoveryAttempt(state: SystemRecoveryState, now = Date.now()): SystemRecoveryState | null {
  if (state.state === "complete" || state.state === "exhausted" ||
      (state.nextAttemptAt !== null && state.nextAttemptAt > now)) return null;
  // A reclaimed physical owner first reconciles the same interrupted attempt.
  // Starting another call is not evidence that the prior call failed.
  if (state.state === "running" && state.attemptId) return { ...state, revision: state.revision + 1 };
  if ((state.deadlineAt !== null && now >= state.deadlineAt) ||
      (state.attempts > 0 && state.retriesUsed >= SYSTEM_RECOVERY_MAX_RETRIES)) return null;
  return { ...state, revision: state.revision + 1, state: "running", attemptId: randomUUID(),
    attempts: state.attempts + 1, retriesUsed: state.retriesUsed + (state.attempts > 0 ? 1 : 0), nextAttemptAt: null };
}

/** The caller persists this timestamp. A restart must not recalculate jitter. */
export function failSystemRecovery(
  state: SystemRecoveryState, failure: SystemRecoveryFailure,
  options: { now?: number; retryAfterAt?: number; evidenceFingerprint?: string; cause?: RecoveryFailureCause } = {},
): SystemRecoveryState {
  const now = options.now ?? Date.now();
  const firstFailureAt = state.firstFailureAt ?? now;
  const deadlineAt = state.deadlineAt ?? firstFailureAt + SYSTEM_RECOVERY_WINDOW_MS;
  const retryNumber = state.retriesUsed + 1;
  const entropy = createHash("sha256").update(`${state.generationId}:${retryNumber}`).digest().readUInt32BE(0) / 0xffffffff;
  const delay = infrastructureRetryDelayMs(retryNumber, entropy);
  const nextAttemptAt = Math.max(now + delay, options.retryAfterAt ?? 0);
  const retryable = ["retry_transient", "recheck_evidence"].includes(failure.retryClass);
  const retry = retryable && retryNumber <= SYSTEM_RECOVERY_MAX_RETRIES && nextAttemptAt < deadlineAt;
  const sourceVerification = workspaceSourceVerificationFailureSchema.safeParse(failure.sourceVerification);
  const cause = recoveryFailureCauseSchema.safeParse(options.cause);
  return { ...state, revision: state.revision + 1, firstFailureAt, deadlineAt,
    providerCooldownAt: options.retryAfterAt ?? null,
    state: retry ? failure.retryClass === "recheck_evidence" ? "awaiting_evidence" : "scheduled" : "exhausted",
    nextAttemptAt: retry ? nextAttemptAt : null,
    failure: { code: failure.code, retryClass: failure.retryClass,
      ...(sourceVerification.success ? { sourceVerification: sourceVerification.data } : {}),
      ...(cause.success ? { cause: cause.data } : {}),
      evidenceFingerprint: options.evidenceFingerprint ?? createHash("sha256").update(`${state.sourceRunId}:${failure.code}`).digest("hex") },
  };
}

/**
 * An exhausted save whose last failure was an unproven agent stop is not a
 * permanent refusal: once the source run has ended, a later attempt can prove
 * the stop. Recovery re-arms it a bounded number of times on a backoff
 * (workspace-recovery-stop-proof), then an export hold continues from the last
 * save with the unsaved files attached, like a refused source.
 */
export const STOP_PROOF_RECOVERY_KEY = "stopProofRecovery";
export const STOP_PROOF_RECOVERY_SCHEMA = "paperclip.stop-proof-recovery.v1";
export const STOP_PROOF_MAX_REARMS = 4;
export const STOP_PROOF_WAIT_CODE = "agent_stop_unconfirmed";

export function readStopProofRecovery(evidence: Record<string, unknown> | null | undefined): { rearms: number; nextRearmAt: number | null } | null {
  const marker = evidence?.[STOP_PROOF_RECOVERY_KEY] as Record<string, unknown> | undefined;
  if (!marker || marker.schema !== STOP_PROOF_RECOVERY_SCHEMA || typeof marker.rearms !== "number") return null;
  return { rearms: marker.rearms, nextRearmAt: typeof marker.nextRearmAt === "number" ? marker.nextRearmAt : null };
}

export function isExhaustedStopProofWait(state: Pick<SystemRecoveryState, "state" | "failure"> | null | undefined) {
  return state?.state === "exhausted" && state.failure?.code === STOP_PROOF_WAIT_CODE
    && state.failure.retryClass === "recheck_evidence";
}

/** Every bounded re-arm of an unproven stop is spent. */
export function stopProofRearmsSpent(evidence: Record<string, unknown> | null | undefined) {
  return (readStopProofRecovery(evidence)?.rearms ?? 0) >= STOP_PROOF_MAX_REARMS;
}

/** User-facing text for a spent recovery budget. It names what happens next and
 * never asks a person to inspect a sandbox or environment. The code stays for support. */
export function exhaustedSystemRecoveryAction(state: SystemRecoveryState, evidence?: Record<string, unknown> | null): string {
  // Another Retry cannot release a copyback owner that stopped without reporting.
  if (state.failure?.code === "copyback_stop_unconfirmed")
    return "Recovery of saved work is waiting for the previous server's file copy to stop. "
      + "Recovery resumes once Paperclip can confirm that it stopped. No provider turn is submitted.";
  // An unproven agent stop is re-proven automatically once the run is over
  // (workspace-recovery-stop-proof), while a bounded re-arm remains.
  if (evidence !== undefined && isExhaustedStopProofWait(state) && !stopProofRearmsSpent(evidence))
    return "Recovery of saved work is waiting to confirm that the previous run stopped. "
      + "Paperclip tries again automatically, and the agent will not repeat its work.";
  const cause = state.failure?.cause ? `, cause: ${state.failure.cause.label}` : "";
  if (isDeterministicRecoveryRefusal(state)) {
    const code = state.failure!.code;
    return `Paperclip refused to recover the saved files: ${recoveryRefusalReasons[code] ?? "a safety check on the saved files did not pass"} `
      + `(${code}${cause}). Automatic recovery does not repeat this check, because the same saved state gives the same result. `
      + "Retry runs the check again and succeeds only after Paperclip is updated. The agent's result is saved, and the agent will not repeat its work.";
  }
  const reason = state.failure?.code ? ` (last failure: ${state.failure.code}${cause})` : "";
  const outcome = state.attempts > 1 ? `stopped after ${state.attempts} attempts` : "failed";
  return `Automatic recovery of saved work ${outcome}${reason}. `
    + "Retry to try again; the agent will not repeat its work.";
}

export function isDeterministicRecoveryRefusal(state: Pick<SystemRecoveryState, "state" | "failure"> | null | undefined) {
  return state?.state === "exhausted" && state.failure?.retryClass === "service_required";
}

const recoveryRefusalReasons: Partial<Record<RecoveryFailureCode, string>> = {
  allocation_ownership_ambiguous: "Paperclip cannot prove which runs used the sandbox that holds the saved files",
  source_binding_invalid: "the recorded source of the saved files does not match the run that saved them",
  snapshot_verification_failed: "the saved snapshot of the files did not pass verification",
  archive_unsafe: "the saved file archive contains entries that are not safe to apply",
  source_unavailable: "the saved files are no longer available where the run recorded them",
};
