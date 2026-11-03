// Run error-family classification.
//
// This module is the single source of truth for "which error family did this
// run die in?". It lives in its own file (rather than inside `heartbeat.ts`)
// so that control-plane services which must classify a run - the
// productivity-review detector in particular - can do so WITHOUT importing
// `heartbeat.ts`.
//
// The cycle matters: `heartbeat.ts` imports the productivity-review service,
// so if the detector imported `heartbeat.ts` back we would have a service
// cycle that ESM resolves only by luck of module evaluation order.

import { parseObject } from "../adapters/utils.js";
import { CONTEXT_OVERFLOW_ERROR_CODE } from "@paperclipai/adapter-utils/acpx-engine/context-overflow";

export type HeartbeatRunErrorFamily = "provider_quota" | "transient_upstream" | string;

export type ErrorFamilyRun = {
  errorCode: string | null;
  error: string | null;
  resultJson: unknown;
};

/**
 * The flattened view of a run's error evidence.
 *
 * The detector projects only the columns it needs out of `result_json`
 * instead of pulling the whole (potentially large) JSON blob, so the
 * classifier has to accept both shapes.
 */
export type FlattenedErrorFamilyRun = {
  errorCode: string | null;
  error: string | null;
  errorFamily: string | null;
  errorMessage: string | null;
  resultMessage: string | null;
};

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

// Rate-limit (429) detection for generic adapter failures. Local adapters
// surface an upstream provider throttle as a plain `adapter_failed` run whose
// only evidence is the human-readable error text (e.g. OpenCode Zen free-tier
// returns "Rate limit exceeded. Please try again later." / a FreeUsageLimit
// error). Those runs carry no structured `errorFamily`, so without this
// classifier the quota-backoff enqueue gate never engages and every automatic
// wake is a doomed probe that re-amplifies the failure storm (the ~150
// adapter_failed/day we saw in TON-458). Only tight, unambiguous throttle
// signals are treated as `provider_quota`; a broad pattern would wrongly
// quarantine a genuinely broken adapter for hours.
const RATE_LIMIT_ERROR_PATTERNS: ReadonlyArray<RegExp> = [
  /rate[\s_-]*limit/i,
  /too many requests/i,
  /\b429\b/,
  /quota\s+(?:exceeded|exhausted|hit)/i,
  /usage\s+limit/i,
  /free\s+usage\s+limit/i,
  /exceeded\s+(?:your\s+)?(?:daily\s+)?(?:usage|quota)/i,
];

export function isProviderQuotaRateLimitMessage(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (!text) return false;
  return RATE_LIMIT_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Classify a run's terminal error into a family.
 *
 * - `provider_quota`: the upstream provider refused the request (HTTP 429 /
 *   token-plan exhaustion). The run never really started, so it cannot have
 *   commented on anything.
 * - `transient_upstream`: the request was refused upstream but a retry can
 *   recover (dropped SSE stream, context-window overflow, ...).
 */
export function readHeartbeatRunErrorFamily(run: ErrorFamilyRun): HeartbeatRunErrorFamily | null {
  const resultJson = parseObject(run.resultJson);
  return classifyErrorFamily({
    errorCode: run.errorCode,
    error: run.error,
    errorFamily: readNonEmptyString(resultJson.errorFamily),
    errorMessage: readNonEmptyString(resultJson.errorMessage),
    resultMessage: readNonEmptyString(resultJson.message),
  });
}

/**
 * The classification core, over already-flattened error evidence.
 *
 * Both `readHeartbeatRunErrorFamily` (full row) and the detector (projected
 * columns) funnel through here, so the two can never disagree about whether
 * a run died on a quota refusal.
 */
function classifyErrorFamily(run: FlattenedErrorFamilyRun): HeartbeatRunErrorFamily | null {
  if (run.errorFamily) return run.errorFamily;

  if (run.errorCode === "provider_quota") {
    return "provider_quota";
  }
  if (run.errorCode === "codex_transient_upstream" || run.errorCode === "claude_transient_upstream") {
    return "transient_upstream";
  }
  // ACPX turn failures caused by an upstream transport interruption (dropped
  // SSE stream, reset socket) are transient, not deterministic protocol
  // faults. Without this the bounded retry ladder never engages and one
  // dropped connection kills the run outright (TON-639).
  if (run.errorCode === "acpx_transient_upstream") {
    return "transient_upstream";
  }
  // A context-window overflow carries its own code (`acpx_transient_upsert`)
  // but stays in the transient_upstream FAMILY: the request was refused
  // upstream and a retry CAN recover - but only if the retry re-seeds the
  // prompt with a bounded context. The family keeps the bounded retry ladder
  // engaged; the CODE is what selects the re-seed path (TON-868).
  if (run.errorCode === CONTEXT_OVERFLOW_ERROR_CODE) {
    return "transient_upstream";
  }
  // Generic adapter failures that are actually an upstream rate-limit refusal
  // (the adapter returned `adapter_failed` with "Rate limit exceeded" text and
  // no structured family). Classifying them here lets the quota-backoff enqueue
  // gate and the scheduled-retry ladder engage, which is what actually breaks
  // the self-amplifying 429 storm (TON-458).
  if (
    isProviderQuotaRateLimitMessage(run.errorCode) ||
    isProviderQuotaRateLimitMessage(run.error) ||
    isProviderQuotaRateLimitMessage(run.errorMessage) ||
    isProviderQuotaRateLimitMessage(run.resultMessage)
  ) {
    return "provider_quota";
  }
  return null;
}

/**
 * True when the run died because the provider refused to serve it.
 *
 * Such a run never started work: it produced no output, no comment and no
 * next action. Any productivity metric that counts it as a "completed run the
 * agent stayed silent on" is measuring the outage, not the agent (TON-981).
 */
export function isProviderQuotaFailedRun(run: ErrorFamilyRun): boolean {
  return readHeartbeatRunErrorFamily(run) === "provider_quota";
}

/**
 * The same check over already-flattened error evidence (see
 * `FlattenedErrorFamilyRun`).
 */
export function isFlattenedProviderQuotaFailedRun(run: FlattenedErrorFamilyRun): boolean {
  return classifyErrorFamily(run) === "provider_quota";
}
