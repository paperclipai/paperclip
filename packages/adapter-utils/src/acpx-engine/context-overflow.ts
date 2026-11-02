/**
 * Context-window overflow: the upstream refused the request because the
 * accumulated conversation no longer fits the model's context window
 * (MiniMax answers "400 invalid params, context window exceeds limit (2013)").
 *
 * This is a DIFFERENT failure from a transport interruption, even though both
 * are upstream-side refusals:
 *
 *   - a transport interruption ("Connection closed mid-response") leaves the
 *     request replayable: the same prompt usually succeeds on a fresh session.
 *   - a context-window overflow is a property of the ACCUMULATED context. The
 *     prompt is rebuilt from the same issue context on every retry, so a retry
 *     that replays it dies identically. The fix is not "retry harder"; it is
 *     "retry with a SMALLER prompt and a FRESH session".
 *
 * Hence the distinct error code: `acpx_transient_upsert` routes to the
 * bounded re-seed path (fresh ACP session + a re-seeded prompt) while
 * `acpx_transient_upstream` keeps the plain transient ladder.
 *
 * The patterns below are deliberately narrow - only unambiguous
 * context-window refusals qualify. A broad pattern (e.g. any "400") would
 * misclassify deterministic request faults as retryable.
 */
const CONTEXT_WINDOW_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /context\s+window\s+exceeds\s+limit/i,
  /\bcontext_length_exceeded\b/i,
  /\bmaximum\s+context\s+length\b/i,
  /\bprompt\s+is\s+too\s+long\b/i,
];

/**
 * The error code for a context-window overflow. Distinct from
 * `acpx_transient_upstream` so the heartbeat can route it to the re-seed
 * path instead of replaying the same oversized prompt.
 */
export const CONTEXT_OVERFLOW_ERROR_CODE = "acpx_transient_upsert" as const;

/**
 * The family stays `transient_upstream` on purpose: an overflow is still an
 * upstream refusal, so the bounded retry ladder must engage. What differs is
 * the CODE, and the code is what selects the re-seed path.
 */
export const CONTEXT_OVERFLOW_ERROR_FAMILY = "transient_upstream" as const;

export type ContextWindowOverflowFailure = {
  errorCode: typeof CONTEXT_OVERFLOW_ERROR_CODE;
  errorFamily: typeof CONTEXT_OVERFLOW_ERROR_FAMILY;
};

/**
 * True when the message describes an upstream refusal caused by an oversized
 * context window, rather than a transport cut or a deterministic fault.
 */
export function isContextWindowOverflowFailure(message: unknown): boolean {
  if (typeof message !== "string") return false;
  const text = message.trim();
  if (!text) return false;
  return CONTEXT_WINDOW_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Classify a context-window overflow so the run is recorded with the distinct
 * code. The heartbeat reads the code to route the retry through the re-seed
 * path instead of the plain transient ladder.
 */
export function classifyContextWindowOverflowFailure(
  message: unknown,
): ContextWindowOverflowFailure | null {
  if (!isContextWindowOverflowFailure(message)) return null;
  return {
    errorCode: CONTEXT_OVERFLOW_ERROR_CODE,
    errorFamily: CONTEXT_OVERFLOW_ERROR_FAMILY,
  };
}
