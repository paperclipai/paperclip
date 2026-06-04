/**
 * amplifier-agent error classification helpers.
 *
 * After the wrapper's 0.6.1 hardening release, envelope parsing and NDJSON
 * stream parsing are owned by `amplifier-agent-ts`:
 *   - The wrapper's `parseRunOutput()` decodes the §4.1 envelope.
 *   - The wrapper's `parseNdjsonStream()` parses the 9 stderr wire events.
 *   - The wrapper's `SessionHandle` surfaces both as typed `DisplayEvent`s.
 *
 * This module is the adapter's classifier layer: given a structured error
 * (from the wrapper's `DisplayEvent` of type `error`) plus accumulated
 * stderr, it answers paperclip-specific questions:
 *   - Was this an "unknown session" failure that warrants a fresh retry?
 *   - Was it a protocol skew (user-actionable)?
 *   - Was it G3's approval_unconfigured (indicates an argv assembly bug)?
 *   - What's the best human-readable message for the result?
 *
 * The classifier inputs are intentionally primitive (string / string / string)
 * so this file has no dependency on the wrapper's `DisplayEvent` type. The
 * caller (execute.ts) extracts the relevant fields from whatever shape it
 * has and passes them in.
 *
 * Engine error codes are from `src/amplifier_agent_lib/protocol/errors.py`
 * in `microsoft/amplifier-agent`.
 */

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * Minimal classifier input — paperclip-side equivalent of the engine's §4.1
 * envelope error. Constructed by execute.ts from either the wrapper's
 * `{type: "error", ...}` DisplayEvent or a thrown `AaaError`.
 */
export interface AmplifierErrorView {
  /** Engine error code (e.g. "session_not_found"). Empty when unknown. */
  code: string;
  /** Engine classification ("transport" | "protocol" | "engine" | "approval" | "unknown"). */
  classification: string;
  /** Human-readable message from the engine. */
  message: string;
  /** Last 4096 bytes of subprocess stderr, if surfaced by the wrapper. */
  stderrTail: string;
}

/**
 * Build an `AmplifierErrorView` from loose fields. Useful when the caller
 * has an `AaaError` or wrapper `DisplayEvent` and just wants a uniform shape.
 */
export function asAmplifierErrorView(input: {
  code?: string | null;
  classification?: string | null;
  message?: string | null;
  stderrTail?: string | null;
}): AmplifierErrorView {
  return {
    code: (input.code ?? "").trim(),
    classification: (input.classification ?? "").trim(),
    message: (input.message ?? "").trim(),
    stderrTail: input.stderrTail ?? "",
  };
}

// ---------------------------------------------------------------------------
// Unknown session detection
// ---------------------------------------------------------------------------

/**
 * Engine error codes that mean "the session id you asked to resume does not
 * exist on disk". When this fires on a resume attempt, execute.ts retries
 * with `--fresh` and sets `clearSession: true` on the result so paperclip
 * discards the stale runtimeSessionParams.
 *
 * Codes from `amplifier_agent_lib/protocol/errors.py`:
 *   - session_not_found    (canonical)
 *   - invalid_session      (legacy alias kept by engine for backward compat)
 *   - stale_session        (engine emits when transcript exists but has
 *                           been invalidated by a foundation upgrade)
 */
const AMPLIFIER_UNKNOWN_SESSION_CODES = new Set([
  "session_not_found",
  "invalid_session",
  "stale_session",
]);

/**
 * Human-readable patterns for engines that predate structured error codes
 * (defensive forward-compat). The adapter should never see these in
 * practice with engine ≥0.4.0; kept so older engines degrade gracefully.
 */
const AMPLIFIER_UNKNOWN_SESSION_RE =
  /session\b[^\n]*\b(?:not\s+found|does\s+not\s+exist|is\s+unavailable|is\s+invalid)|no\s+session\s+(?:found|directory)|missing\s+transcript|session\s+id\s+invalid/i;

/**
 * True when the failure indicates "the session id we tried to resume does
 * not exist". Causes execute.ts to retry with `--fresh` and clear paperclip's
 * stored sessionParams.
 *
 * Mirrors the codex-local `isCodexUnknownSessionError` pattern: checks the
 * structured error code first, then falls back to message/stderr regex
 * matching for resilience.
 */
export function isAmplifierUnknownSessionError(
  error: AmplifierErrorView,
  stderr: string,
): boolean {
  if (error.code && AMPLIFIER_UNKNOWN_SESSION_CODES.has(error.code)) {
    return true;
  }
  const haystack = [error.message, error.stderrTail, stderr]
    .filter((s) => s && s.length > 0)
    .join("\n");
  return AMPLIFIER_UNKNOWN_SESSION_RE.test(haystack);
}

// ---------------------------------------------------------------------------
// Other engine-specific error code matchers
// ---------------------------------------------------------------------------

/**
 * Wrapper-pinned protocol version diverged from the engine's. The wrapper
 * (≥0.6.1) catches this at `spawnAgent()` time via `checkProtocolVersion()`
 * and throws `AaaError(code: "protocol_version_mismatch")` before any
 * subprocess spawn — so the adapter should rarely observe this from the
 * engine directly. Kept as a check for the fallback path where the wrapper's
 * pre-flight is bypassed (e.g. `allowProtocolSkew: true`).
 *
 * The error surfaces a structured `remediation` field; execute.ts should
 * include it in the AdapterExecutionResult's errorMessage.
 */
export function isAmplifierProtocolMismatchError(
  error: AmplifierErrorView,
): boolean {
  return error.code === "protocol_version_mismatch";
}

/**
 * Engine G3 fail-fast: non-TTY run without an explicit approval policy.
 * The adapter always passes `approval: { mode: "yes" }` (which emits `-y`),
 * so this should NEVER fire. If it does, it indicates an argv-assembly bug
 * or a stale wrapper version — surface it loudly in monitoring.
 */
export function isAmplifierApprovalUnconfiguredError(
  error: AmplifierErrorView,
): boolean {
  return error.code === "approval_unconfigured";
}

/**
 * Bundle failed to mount — typically a stale `$XDG_CACHE_HOME/amplifier-agent`
 * after a foundation/engine version bump. The remediation is to run
 * `amplifier-agent prepare` (or `amplifier-agent cache clear`) on the host.
 * execute.ts surfaces this as `errorCode: "amplifier_bundle_load_failed"` so
 * paperclip can show the actionable hint in the run viewer.
 */
export function isAmplifierBundleLoadFailedError(
  error: AmplifierErrorView,
): boolean {
  return error.code === "bundle_load_failed";
}

// ---------------------------------------------------------------------------
// Human-readable error summary
// ---------------------------------------------------------------------------

/**
 * Pick the best human-readable error string from the structured error and
 * surrounding stderr. Preference order:
 *   1. error.message (from the engine's envelope)
 *   2. first non-empty stderr line
 *   3. generic "amplifier-agent exited with code N"
 *
 * Used by execute.ts to populate `AdapterExecutionResult.errorMessage`.
 */
export function describeAmplifierError(
  error: AmplifierErrorView,
  stderr: string,
  exitCode: number | null,
): string {
  if (error.message && error.message.length > 0) return error.message;
  const firstStderr = firstNonEmptyLine(stderr);
  if (firstStderr) return firstStderr;
  return `amplifier-agent exited with code ${exitCode ?? -1}`;
}

function firstNonEmptyLine(text: string): string {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length > 0) return line;
  }
  return "";
}
