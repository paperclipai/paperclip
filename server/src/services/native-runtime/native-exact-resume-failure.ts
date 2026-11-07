/**
 * The interrupted provider attempt that a same-run exact-checkpoint retry was
 * resuming when the retry failed before it took its own provider claim.
 */
export type InterruptedExactResume = {
  originalFailureCode: string;
  originalMessage: string;
  interruptedAttempt: number;
};

/** Bounds the persisted original message before the chained message is built. */
const ORIGINAL_MESSAGE_MAX_CHARS = 1_500;
/** The coordinator failure detail keeps at most this many characters. */
const FAILURE_DETAIL_MAX_CHARS = 2_000;
/** Leaves the refusal readable however long the original message is. */
const REFUSAL_MAX_CHARS = 480;
const REFUSAL_SEPARATOR = "; exact checkpoint resume refused: ";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * A same-run resume claim clears the coordinator failure fields, so the
 * interrupted attempt survives only in its recovery history entry. That entry
 * explains the retry only while the claim is still `observed` and no later
 * provider attempt was claimed: the executor increments `attempt` when it
 * claims, and it records its own failures for that attempt. A retryable entry
 * with a checkpoint was an exact-checkpoint resume, because a bootstrap retry
 * has no checkpoint and an ambiguous state is never retryable.
 */
export function interruptedExactResumeCause(coordinator: {
  phase: string;
  attempt: number;
  resultId: string | null;
  recoveryHistory: unknown;
} | null | undefined): InterruptedExactResume | null {
  if (!coordinator || coordinator.phase !== "observed" || coordinator.resultId !== null || coordinator.attempt < 1) return null;
  const history = Array.isArray(coordinator.recoveryHistory) ? coordinator.recoveryHistory : [];
  const entry = record(history.at(-1));
  if (
    entry.disposition !== "retryable_failure" ||
    entry.providerAttempt !== coordinator.attempt ||
    entry.checkpointExists !== true ||
    entry.providerSessionEstablished !== true ||
    typeof entry.reason !== "string" || !entry.reason
  ) return null;
  // The executor redacted and bounded this tail before it persisted the entry.
  const message = typeof entry.stderrTail === "string" ? entry.stderrTail.trim() : "";
  return {
    originalFailureCode: entry.reason,
    originalMessage: message.slice(0, ORIGINAL_MESSAGE_MAX_CHARS),
    interruptedAttempt: coordinator.attempt,
  };
}

/**
 * Names the interrupted attempt first, then why its exact checkpoint could not
 * resume. The refusal keeps its own budget, and the original message is cut to
 * the room left, so the whole message fits the failure-detail bound.
 */
export function describeRefusedExactResume(cause: InterruptedExactResume, refusal: string): string {
  const refused = `${REFUSAL_SEPARATOR}${refusal.slice(0, REFUSAL_MAX_CHARS)}`;
  const originalBudget = Math.max(0, FAILURE_DETAIL_MAX_CHARS - refused.length);
  const code = cause.originalFailureCode.slice(0, originalBudget);
  const messageBudget = originalBudget - code.length - 2;
  const original = cause.originalMessage && messageBudget > 0
    ? `${code}: ${cause.originalMessage.slice(0, messageBudget)}`
    : code;
  return `${original}${refused}`;
}
