import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export const SYSTEM_RECOVERY_POLICY_VERSION = 1;
export const SYSTEM_RECOVERY_MAX_RETRIES = 5;
export const SYSTEM_RECOVERY_WINDOW_MS = 30 * 60_000;
export function infrastructureRetryDelayMs(retryNumber: number, sample: number) {
  return Math.round(30_000 * 2 ** (retryNumber - 1) * (0.8 + Math.min(1, Math.max(0, sample)) * 0.4));
}

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
  constructor(readonly code: RecoveryFailureCode, readonly retryClass: RecoveryRetryClass, message = code) {
    super(message);
  }
}

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
  options: { now?: number; retryAfterAt?: number; evidenceFingerprint?: string } = {},
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
  return { ...state, revision: state.revision + 1, firstFailureAt, deadlineAt,
    providerCooldownAt: options.retryAfterAt ?? null,
    state: retry ? failure.retryClass === "recheck_evidence" ? "awaiting_evidence" : "scheduled" : "exhausted",
    nextAttemptAt: retry ? nextAttemptAt : null,
    failure: { code: failure.code, retryClass: failure.retryClass,
      evidenceFingerprint: options.evidenceFingerprint ?? createHash("sha256").update(`${state.sourceRunId}:${failure.code}`).digest("hex") },
  };
}
