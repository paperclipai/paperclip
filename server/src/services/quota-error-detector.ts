/**
 * Detects quota-exhausted errors from adapter run failure messages so the
 * ProviderCooldownService can quarantine the affected route automatically.
 *
 * Patterns matched (from FUL-5181 incident and Gemini/Anthropic API docs):
 *   - "QUOTA_EXHAUSTED"
 *   - "RESOURCE_EXHAUSTED"
 *   - "TerminalQuotaError"
 *   - HTTP 429 with "capacity on this model"
 *   - "quota" + "exceeded" (case-insensitive fallback)
 *
 * @see FUL-5634 — Wire into SRE run-failure monitoring
 * @see FUL-5202 — Per-model quota quarantine + fallback
 */

/** Default cooldown when the API does not supply a retry-after hint (1 hour). */
export const DEFAULT_QUOTA_COOLDOWN_MS = 60 * 60 * 1_000;

export interface QuotaDetectionResult {
  /** True if the error message indicates a per-model quota exhaustion. */
  isQuotaExhausted: boolean;
  /** Suggested cooldown duration in milliseconds. */
  cooldownMs: number;
  /** Human-readable reason string for the cooldown entry. */
  reason: string;
}

const QUOTA_PATTERNS: RegExp[] = [
  /QUOTA_EXHAUSTED/i,
  /RESOURCE_EXHAUSTED/i,
  /TerminalQuotaError/i,
  /capacity on this model/i,
  /quota.*exceeded/i,
  /exceeded.*quota/i,
  // Anthropic: "rate_limit_error" on token-level quota
  /rate_limit_error.*token/i,
];

/** Parse a retry-after hint from the error message (seconds → ms). */
function parseRetryAfterMs(errorMessage: string): number | undefined {
  // "retry after N seconds" or "retryDelay: Ns"
  const match =
    /retry[_ ]?after[:\s]+(\d+)\s*s/i.exec(errorMessage) ??
    /retryDelay[:\s]+"?(\d+)s/i.exec(errorMessage);
  if (match) {
    const seconds = parseInt(match[1], 10);
    if (!isNaN(seconds) && seconds > 0) {
      return seconds * 1_000;
    }
  }
  return undefined;
}

/**
 * Inspect an adapter run failure message and determine whether it represents
 * a quota-exhaustion event that warrants a per-route cooldown.
 */
export function detectQuotaError(errorMessage: string): QuotaDetectionResult {
  const isQuotaExhausted = QUOTA_PATTERNS.some((re) => re.test(errorMessage));

  if (!isQuotaExhausted) {
    return { isQuotaExhausted: false, cooldownMs: 0, reason: "" };
  }

  const retryAfterMs = parseRetryAfterMs(errorMessage);
  const cooldownMs = retryAfterMs ?? DEFAULT_QUOTA_COOLDOWN_MS;

  return {
    isQuotaExhausted: true,
    cooldownMs,
    reason: `quota_exhausted: ${errorMessage.slice(0, 200)}`,
  };
}
