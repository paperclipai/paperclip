// ---------------------------------------------------------------------------
// Inference-failure classification
//
// When an agent run's completion call fails at the inference provider, the
// distinct causes (an invalid-key 401, an exhausted budget, a cold/unavailable
// model, a 429, a generic 5xx) all collapse into one opaque "adapter failed"
// outcome: the run is retried blindly, the raw error is shown, and the real
// cause is lost. This module classifies the upstream/adapter failure into a
// small, stable enum so retry behaviour can be correct and the user-facing
// message can be plain and actionable.
//
// It is intentionally provider-shaped (OpenAI-compatible error payloads,
// including gateways such as Bifrost, LiteLLM, or OpenRouter) and side-effect
// free so adapters, the run scheduler, and the UI can all share one source of
// truth.
// ---------------------------------------------------------------------------

import type { AdapterExecutionErrorFamily } from "./types.js";

export type InferenceFailureCode =
  | "AUTH_INVALID"
  | "OUT_OF_CREDITS"
  | "MODEL_UNAVAILABLE"
  | "RATE_LIMITED"
  | "UPSTREAM_ERROR"
  | "UNKNOWN";

export interface InferenceFailureClassification {
  code: InferenceFailureCode;
  /**
   * The concrete upstream marker text we matched on, retained for support and
   * telemetry. Only the matched excerpt is kept, never the full
   * errorMessage/stdout/stderr, so credential material in surrounding output
   * (relevant for AUTH_INVALID) is not carried into telemetry.
   */
  cause: string;
}

export interface InferenceFailureRetryPolicy {
  /** Whether this class should be retried at all. */
  retry: boolean;
  /** Explicit, bounded attempt cap so a permanent failure cannot burn time. */
  maxAttempts: number;
  /**
   * The recovery family the run scheduler keys retries off. Only transient
   * classes carry "transient_upstream"; permanent classes carry null so the run
   * fails fast.
   */
  family: AdapterExecutionErrorFamily | null;
}

export interface InferenceFailureDescription {
  /** Short, plain message shown to the user (house style, no em/en dashes). */
  message: string;
  /** The single suggested next action. */
  action: string;
  /**
   * True when the raw upstream detail must not be surfaced as the primary
   * message (e.g. auth errors, which are an operator-side configuration
   * problem and may reference key material).
   */
  internal: boolean;
}

export interface InferenceFailureInput {
  errorMessage?: string | null;
  stdout?: string | null;
  stderr?: string | null;
  exitCode?: number | null;
}

const ERROR_CODE_BY_CLASS: Record<InferenceFailureCode, string> = {
  AUTH_INVALID: "inference_auth_invalid",
  OUT_OF_CREDITS: "inference_out_of_credits",
  MODEL_UNAVAILABLE: "inference_model_unavailable",
  RATE_LIMITED: "inference_rate_limited",
  UPSTREAM_ERROR: "inference_upstream_error",
  UNKNOWN: "inference_unknown",
};

const CLASS_BY_ERROR_CODE: Record<string, InferenceFailureCode> = Object.fromEntries(
  Object.entries(ERROR_CODE_BY_CLASS).map(([code, errorCode]) => [errorCode, code as InferenceFailureCode]),
) as Record<string, InferenceFailureCode>;

// Does the text look like an inference/model failure at all? Gates the whole
// classifier so unrelated failures (git, workspace, filesystem) stay untouched.
const INFERENCE_CONTEXT_RE =
  /(?:virtual_key_not_found|budget\s+has\s+been\s+exceeded|max\s+budget|out\s+of\s+(?:inference\s+)?credits|insufficient\s+(?:credits|balance|funds)|payment\s+required|\b40[123]\b|\b429\b|\b5\d{2}\b|\bhttp\s*000\b|rate[-\s]?limit|too\s+many\s+requests|throttl|unauthorized|invalid[\s_]+api[\s_]?key|authentication[\s_]error|unexpected\s+server\s+error|service\s+unavailable|gateway\s+timeout|timed?\s*out|no\s+healthy\s+upstream|model\b|completion|chat\/completions|provider|upstream\s+error|bifrost|litellm|openrouter)/i;

// Order matters: the most specific / most permanent classes are tested first so
// a budget error that also carries a 4xx code resolves to OUT_OF_CREDITS.
const OUT_OF_CREDITS_RE =
  /(?:budget\s+has\s+been\s+exceeded|max\s+budget|out\s+of\s+(?:inference\s+)?credits|insufficient\s+(?:credits|balance|funds)|payment\s+required|\b402\b|exceeded\s+your\s+(?:monthly\s+)?(?:credit|spend|budget))/i;
const AUTH_INVALID_RE =
  /(?:virtual_key_not_found|invalid[\s_]+api[\s_]?key|invalid_request_error[\s\S]*?\b401\b|authentication[\s_]error|unauthorized|\b401\b|\b403\b|forbidden|api\s+key\s+(?:is\s+)?(?:invalid|not\s+found|missing))/i;
const RATE_LIMITED_RE =
  /(?:\b429\b|rate[-\s]?limit(?:ed)?|rate_limit_error|too\s+many\s+requests|throttl(?:ed|ing)?)/i;
const MODEL_UNAVAILABLE_RE =
  /(?:\bhttp\s*000\b|\b504\b|gateway\s+timeout|timed?\s*out|no\s+healthy\s+upstream|model\s+(?:is\s+)?(?:temporarily\s+)?(?:unavailable|not\s+(?:found|served|available)|cold|overloaded)|(?:not\s+served|no\s+provider)\s+for\s+model)/i;
// Connection-level failures ("connection refused", ECONNRESET) are only an
// unavailable model when the text also names an inference-shaped component;
// on their own they are just as likely a database or webhook failure, so they
// must not flip to a retryable MODEL_UNAVAILABLE without that context.
const MODEL_CONNECTION_FAILURE_RE =
  /(?:connection\s+(?:refused|reset)|econnrefused|econnreset)/i;
const MODEL_CONNECTION_CONTEXT_RE =
  /(?:model\b|provider|inference|completion|chat\/completions|bifrost|litellm|openrouter)/i;
const UPSTREAM_ERROR_RE =
  /(?:\b50[023]\b|\b5\d{2}\b|internal\s+server\s+error|bad\s+gateway|service\s+unavailable|upstream\s+error|unexpected\s+server\s+error)/i;

function buildHaystack(input: InferenceFailureInput): string {
  return [input.errorMessage, input.stderr, input.stdout]
    .map((part) => (typeof part === "string" ? part : ""))
    .filter((part) => part.trim().length > 0)
    .join("\n")
    .trim();
}

/**
 * Classify an upstream/adapter inference failure into a stable enum.
 *
 * Returns null when the text shows no recognizable inference-failure signal, so
 * callers only override genuine inference failures and leave other failures
 * (git, workspace, etc.) classified as before.
 */
export function classifyInferenceFailure(
  input: InferenceFailureInput,
): InferenceFailureClassification | null {
  const haystack = buildHaystack(input);
  if (!haystack) return null;
  const contextMatch = INFERENCE_CONTEXT_RE.exec(haystack);
  if (!contextMatch) return null;

  const creditsMatch = OUT_OF_CREDITS_RE.exec(haystack);
  if (creditsMatch) return { code: "OUT_OF_CREDITS", cause: creditsMatch[0] };
  const authMatch = AUTH_INVALID_RE.exec(haystack);
  if (authMatch) return { code: "AUTH_INVALID", cause: authMatch[0] };
  const rateMatch = RATE_LIMITED_RE.exec(haystack);
  if (rateMatch) return { code: "RATE_LIMITED", cause: rateMatch[0] };
  const modelMatch = MODEL_UNAVAILABLE_RE.exec(haystack);
  if (modelMatch) return { code: "MODEL_UNAVAILABLE", cause: modelMatch[0] };
  const connectionMatch = MODEL_CONNECTION_FAILURE_RE.exec(haystack);
  if (connectionMatch && MODEL_CONNECTION_CONTEXT_RE.test(haystack)) {
    return { code: "MODEL_UNAVAILABLE", cause: connectionMatch[0] };
  }
  const upstreamMatch = UPSTREAM_ERROR_RE.exec(haystack);
  if (upstreamMatch) return { code: "UPSTREAM_ERROR", cause: upstreamMatch[0] };
  return { code: "UNKNOWN", cause: contextMatch[0] };
}

const RETRY_POLICY_BY_CLASS: Record<InferenceFailureCode, InferenceFailureRetryPolicy> = {
  // Permanent for this run: a bad key or an empty budget will not fix itself.
  AUTH_INVALID: { retry: false, maxAttempts: 0, family: null },
  OUT_OF_CREDITS: { retry: false, maxAttempts: 0, family: null },
  // Transient: a cold/unavailable model usually recovers, but cap it tight so a
  // genuinely dead model does not hang.
  MODEL_UNAVAILABLE: { retry: true, maxAttempts: 2, family: "transient_upstream" },
  // Transient: backoff is exactly the right response.
  RATE_LIMITED: { retry: true, maxAttempts: 3, family: "transient_upstream" },
  UPSTREAM_ERROR: { retry: true, maxAttempts: 3, family: "transient_upstream" },
  // Ambiguous: fail fast rather than burn time on a cause we cannot confirm
  // is transient.
  UNKNOWN: { retry: false, maxAttempts: 0, family: null },
};

export function inferenceFailureRetryPolicy(
  code: InferenceFailureCode,
): InferenceFailureRetryPolicy {
  return RETRY_POLICY_BY_CLASS[code];
}

/** The stable snake_case run errorCode persisted for a classified failure. */
export function inferenceFailureErrorCode(code: InferenceFailureCode): string {
  return ERROR_CODE_BY_CLASS[code];
}

function normalizeToClass(
  value: string | null | undefined,
): InferenceFailureCode | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed in ERROR_CODE_BY_CLASS) return trimmed as InferenceFailureCode;
  return CLASS_BY_ERROR_CODE[trimmed] ?? null;
}

const DESCRIPTION_BY_CLASS: Record<InferenceFailureCode, InferenceFailureDescription> = {
  AUTH_INVALID: {
    message: "The inference provider rejected the configured credentials.",
    action: "Check the inference key configured for this agent.",
    internal: true,
  },
  OUT_OF_CREDITS: {
    message: "The inference account is out of credits.",
    action: "Add credits to the inference provider account to continue.",
    internal: false,
  },
  MODEL_UNAVAILABLE: {
    message: "The model is temporarily unavailable.",
    action: "This run will retry shortly. No action needed.",
    internal: false,
  },
  RATE_LIMITED: {
    message: "The inference service is busy right now.",
    action: "This run will retry shortly. No action needed.",
    internal: false,
  },
  UPSTREAM_ERROR: {
    message: "The inference service hit a temporary error.",
    action: "This run will retry shortly. No action needed.",
    internal: false,
  },
  UNKNOWN: {
    message: "This run could not complete because of an inference error.",
    action: "Try again. If it keeps happening, contact support.",
    internal: false,
  },
};

/**
 * Map a persisted run errorCode (or an InferenceFailureCode) to a short, plain,
 * user-facing message and suggested action. Returns null for any code that is
 * not an inference-failure code, so callers can fall back to existing display.
 */
export function describeRunFailure(
  errorCodeOrClass: string | null | undefined,
): InferenceFailureDescription | null {
  const code = normalizeToClass(errorCodeOrClass);
  if (!code) return null;
  return DESCRIPTION_BY_CLASS[code];
}
