/**
 * The interrupted provider attempt that a same-run exact-checkpoint retry was
 * resuming when the retry failed before it took its own provider claim.
 */
export type InterruptedExactResume = {
  originalFailureCode: string;
  originalMessage: string;
  interruptedAttempt: number;
};

/** Bounds the original message in the chained message and in the run result. */
const ORIGINAL_MESSAGE_MAX_CHARS = 1_500;
/** The coordinator failure detail keeps at most this many characters. */
const FAILURE_DETAIL_MAX_CHARS = 2_000;
/** Leaves the refusal readable however long the original message is. */
const REFUSAL_MAX_CHARS = 480;
const REFUSAL_SEPARATOR = "; exact checkpoint resume refused: ";
/** Restart-recovery waits that keep the interrupted provider attempt. */
const RECOVERY_WAIT_DISPOSITIONS: ReadonlySet<unknown> = new Set(["blocked", "awaiting_evidence"]);

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
 * has no checkpoint and an ambiguous state is never retryable. Restart
 * recovery can record waits for the same attempt after that entry (for
 * example a held remote retry); those are skipped. Any other entry, or any
 * entry for a later provider attempt, ends the search without a cause.
 */
export function interruptedExactResumeCause(coordinator: {
  phase: string;
  attempt: number;
  resultId: string | null;
  recoveryHistory: unknown;
} | null | undefined): InterruptedExactResume | null {
  if (!coordinator || coordinator.phase !== "observed" || coordinator.resultId !== null || coordinator.attempt < 1) return null;
  const history = Array.isArray(coordinator.recoveryHistory) ? coordinator.recoveryHistory : [];
  let entry: Record<string, unknown> = {};
  for (let index = history.length - 1; index >= 0; index -= 1) {
    entry = record(history[index]);
    if (!RECOVERY_WAIT_DISPOSITIONS.has(entry.disposition) || entry.providerAttempt !== coordinator.attempt) break;
  }
  if (
    entry.disposition !== "retryable_failure" ||
    entry.providerAttempt !== coordinator.attempt ||
    entry.checkpointExists !== true ||
    entry.providerSessionEstablished !== true ||
    typeof entry.reason !== "string" || !entry.reason
  ) return null;
  // The executor removed credentials and bounded this tail before it
  // persisted the entry. It is returned whole so the caller can mask
  // usernames before any length budget cuts it.
  const message = typeof entry.stderrTail === "string" ? entry.stderrTail.trim() : "";
  return {
    originalFailureCode: entry.reason,
    originalMessage: message,
    interruptedAttempt: coordinator.attempt,
  };
}

/** The original message as the run result keeps it. Mask it before calling this. */
export function boundOriginalMessage(message: string): string {
  return message.slice(0, ORIGINAL_MESSAGE_MAX_CHARS);
}

/**
 * The text that failure classification reads for a run. A refused exact
 * resume reports the interrupted attempt in `error` for operators, but retry
 * and recovery decisions must follow the current refusal, which the run
 * result keeps separately.
 */
export function failureClassificationText(run: { error?: string | null; resultJson?: unknown } | null | undefined): string | null {
  const refusal = record(record(run?.resultJson).nativeExactResumeRefusal).refusal;
  return typeof refusal === "string" ? refusal : run?.error ?? null;
}

/**
 * Names the interrupted attempt first, then why its exact checkpoint could not
 * resume. The refusal keeps its own budget, and the original message is cut to
 * the room left, so the whole message fits the failure-detail bound. Both
 * texts must already be masked, because a cut can split a username.
 */
export function describeRefusedExactResume(cause: InterruptedExactResume, refusal: string): string {
  const refused = `${REFUSAL_SEPARATOR}${refusal.slice(0, REFUSAL_MAX_CHARS)}`;
  const originalBudget = Math.max(0, FAILURE_DETAIL_MAX_CHARS - refused.length);
  const code = cause.originalFailureCode.slice(0, originalBudget);
  const messageBudget = originalBudget - code.length - 2;
  const original = cause.originalMessage && messageBudget > 0
    ? `${code}: ${cause.originalMessage.slice(0, Math.min(ORIGINAL_MESSAGE_MAX_CHARS, messageBudget))}`
    : code;
  return `${original}${refused}`;
}
