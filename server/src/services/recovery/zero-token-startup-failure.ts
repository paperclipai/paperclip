// Pre-model startup failures: a run that fails before the agent does any
// model work. `context_overflow` / `context_length_exceeded` mean the session
// was already too large to prime the model; `startup_error_pre_model` covers
// other crashes that happen before the first model turn. When such a run also
// burned zero tokens (input + output), the wedge is *structural* — a poisoned
// or oversized session DB, or a model-config mismatch — and re-running it
// inherits the exact same failure mode.
//
// A `stranded_issue_recovery` wrapper is only useful when the failure is
// *transient* (rate limit, network, MCP timeout): a wrapper re-invokes the
// same wedged session, so for this family it just produces another zero-token
// failed run and loops. Observed concretely on BLO-5378 → wrapper BLO-5676 →
// productivity review BLO-5678: 9 consecutive zero-token failed runs in ~1h
// before a human cancelled the wrapper. See BLO-5681.
export const ZERO_TOKEN_STARTUP_FAILURE_ERROR_CODES = new Set<string>([
  "context_overflow",
  "context_length_exceeded",
  "startup_error_pre_model",
]);

// Heartbeat-run terminal statuses that represent an unsuccessful outcome.
// Mirrors UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES in heartbeat.ts /
// recovery/service.ts; kept local so this module stays a dependency-free
// pure classifier that can be unit-tested in isolation.
const UNSUCCESSFUL_TERMINAL_STATUSES = new Set<string>([
  "failed",
  "cancelled",
  "timed_out",
]);

export type ZeroTokenStartupFailureRunInput =
  | {
    status?: string | null;
    errorCode?: string | null;
    usageJson?: Record<string, unknown> | null;
  }
  | null
  | undefined;

// Read a token count from a heartbeat-run `usage_json` blob. Adapters write
// either camelCase (`inputTokens`) or snake_case (`input_tokens`) — see the
// coalesce in services/activity.ts — so both spellings are accepted. A missing
// or non-finite value counts as 0, so an absent usage blob reads as zero work.
function readTokenCount(
  usage: Record<string, unknown> | null | undefined,
  keys: readonly string[],
): number {
  if (!usage) return 0;
  for (const key of keys) {
    const raw = usage[key];
    const value = typeof raw === "string" ? Number(raw) : raw;
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

// Extract input/output token counts from a heartbeat-run `usage_json` blob,
// tolerating both camelCase and snake_case key spellings.
export function runUsageTokenCounts(
  usage: Record<string, unknown> | null | undefined,
): { inputTokens: number; outputTokens: number } {
  return {
    inputTokens: readTokenCount(usage, ["inputTokens", "input_tokens"]),
    outputTokens: readTokenCount(usage, ["outputTokens", "output_tokens"]),
  };
}

// True when a run's most recent terminal failure is a structural, pre-model
// startup wedge that produced zero token usage. The recovery sweep uses this
// to gate `stranded_issue_recovery` wrapper creation: for this family the
// source issue is escalated straight to `blocked` instead of spawning a
// wrapper that would re-run the same wedged session.
export function isZeroTokenStartupFailureRun(
  run: ZeroTokenStartupFailureRunInput,
): boolean {
  if (!run) return false;
  if (!run.status || !UNSUCCESSFUL_TERMINAL_STATUSES.has(run.status)) return false;
  const errorCode = typeof run.errorCode === "string" ? run.errorCode.trim() : "";
  if (!errorCode || !ZERO_TOKEN_STARTUP_FAILURE_ERROR_CODES.has(errorCode)) return false;
  const { inputTokens, outputTokens } = runUsageTokenCounts(run.usageJson);
  return inputTokens === 0 && outputTokens === 0;
}
