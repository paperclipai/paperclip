/**
 * Adapter failure classification — single source of truth for the
 * circuit-breaker reason keys (CLI-121 / CLI-156).
 *
 * Spec: docs/specs/adapter-circuit-breaker.md (v4)
 *
 * Design notes (carried forward from ClippyArch's design comment on CLI-156):
 *   - `adapterFailureReason` is the breaker-only counter input.
 *   - `errorCode` remains the operator/UI surface (e.g. the Claude auth CTA is
 *     keyed off `claude_auth_required`), so it MUST stay independent.
 *   - Both heartbeat thrown-startup catch paths classify through here so
 *     "Process adapter missing command" style faults count toward the breaker
 *     instead of being flattened to opaque `adapter_failed`.
 */

export interface AdapterFailureReasonEntry {
  /** Whether this reason should count toward circuit breaker trip thresholds. */
  readonly countsTowardBreaker: boolean;
  /**
   * Operator/UI-facing error code to surface when the adapter did not provide
   * a more specific `errorCode` itself. This preserves existing UX (e.g. the
   * claude-auth CTA) without entangling UI state with breaker counters.
   */
  readonly surfaceErrorCode: string;
}

export const ADAPTER_FAILURE_REASONS = {
  /** Process adapter threw "Process adapter missing command" (CLI-66 fault). */
  adapter_missing_command: { countsTowardBreaker: true, surfaceErrorCode: "adapter_failed" },
  /** HTTP adapter threw "HTTP adapter missing url". */
  adapter_missing_url: { countsTowardBreaker: true, surfaceErrorCode: "adapter_failed" },
  /** Child process spawn failure (ENOENT, permission denied, etc). */
  adapter_spawn_failed: { countsTowardBreaker: true, surfaceErrorCode: "adapter_failed" },
  /** Adapter-level authentication failure. Surfaces auth CTA in UI. */
  adapter_auth_failed: { countsTowardBreaker: true, surfaceErrorCode: "claude_auth_required" },
  /** Adapter stream/protocol violation. */
  adapter_protocol_error: { countsTowardBreaker: true, surfaceErrorCode: "adapter_failed" },
  /** Health probe timed out or failed. */
  adapter_probe_timeout: { countsTowardBreaker: true, surfaceErrorCode: "adapter_failed" },
  /** HTTP adapter returned a non-2xx status or the fetch itself failed. */
  adapter_http_error: { countsTowardBreaker: true, surfaceErrorCode: "adapter_failed" },
  /** The breaker itself refused this run because the adapter is quarantined. */
  adapter_quarantined: { countsTowardBreaker: false, surfaceErrorCode: "adapter_quarantined" },
  /** Mid-run timeout — agent-side, not counted toward the breaker. */
  adapter_mid_run_timeout: { countsTowardBreaker: false, surfaceErrorCode: "adapter_failed" },
  /** Fallback classification — counts toward breaker to preserve CLI-75 fleet protection. */
  adapter_unknown_error: { countsTowardBreaker: true, surfaceErrorCode: "adapter_failed" },
} as const satisfies Record<string, AdapterFailureReasonEntry>;

export type AdapterFailureReason = keyof typeof ADAPTER_FAILURE_REASONS;

/**
 * Stop reasons that must NOT collapse back into `adapter_failed` in
 * dashboards / run summaries. CLI-156 acceptance criterion.
 */
export const QUARANTINE_STOP_REASON = "adapter_quarantined" as const;

export interface ClassifiedAdapterFailure {
  adapterFailureReason: AdapterFailureReason;
  /** The operator/UI-facing error code. */
  surfaceErrorCode: string;
  /** True when this reason should count toward breaker trip thresholds. */
  countsTowardBreaker: boolean;
}

function readErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message ?? "";
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "";
}

function readErrorCodeProp(err: unknown): string | null {
  if (err && typeof err === "object" && "code" in err) {
    const c = (err as { code?: unknown }).code;
    if (typeof c === "string" && c.length > 0) return c;
  }
  return null;
}

function readErrorName(err: unknown): string {
  if (err instanceof Error) return err.name ?? "";
  if (err && typeof err === "object" && "name" in err) {
    const n = (err as { name?: unknown }).name;
    if (typeof n === "string") return n;
  }
  return "";
}

/**
 * Classify a thrown error from an adapter or adapter-setup path into a
 * circuit-breaker reason + surface error code.
 *
 * This is pure: it takes the raw thrown value and the adapter type and
 * returns a classification. No logging, no I/O. Safe to unit-test.
 */
export function classifyAdapterFailure(
  err: unknown,
  adapterType: string | null | undefined,
): ClassifiedAdapterFailure {
  const message = readErrorMessage(err);
  const lower = message.toLowerCase();
  const name = readErrorName(err);
  const codeProp = readErrorCodeProp(err);

  let reason: AdapterFailureReason = "adapter_unknown_error";

  // --- explicit shapes we know about ---------------------------------------
  if (/process adapter missing command/i.test(message)) {
    reason = "adapter_missing_command";
  } else if (/http adapter missing url/i.test(message)) {
    reason = "adapter_missing_url";
  } else if (
    codeProp === "ENOENT" ||
    /\bENOENT\b/.test(message) ||
    /command not found/i.test(message) ||
    /not recognized as .* (cmdlet|command)/i.test(message) ||
    /spawn .* ENOENT/i.test(message)
  ) {
    reason = "adapter_spawn_failed";
  } else if (
    /claude .*(auth|login|credential)/i.test(message) ||
    /please (run|log in|login|sign in)/i.test(lower) ||
    /not (logged in|authenticated)/i.test(lower) ||
    /missing .*(api key|token|credential)/i.test(lower) ||
    /401\b|403\b/.test(message) && /auth/i.test(message)
  ) {
    reason = "adapter_auth_failed";
  } else if (
    name === "AbortError" ||
    /probe .*(timed? out|timeout)/i.test(message) ||
    /health ?check .*(timed? out|timeout)/i.test(message)
  ) {
    reason = "adapter_probe_timeout";
  } else if (
    /http .*(invoke failed|status \d{3})/i.test(message) ||
    /\bHTTP \d{3}\b/.test(message) ||
    /fetch failed/i.test(message) ||
    adapterType === "http"
  ) {
    reason = "adapter_http_error";
  } else if (/protocol|parse|unexpected token|invalid json/i.test(message)) {
    reason = "adapter_protocol_error";
  }

  const entry = ADAPTER_FAILURE_REASONS[reason];
  return {
    adapterFailureReason: reason,
    surfaceErrorCode: entry.surfaceErrorCode,
    countsTowardBreaker: entry.countsTowardBreaker,
  };
}
