/**
 * G3 — Retry suppression policy (FUL-6364 / ADR FUL-6348).
 *
 * Pure, dependency-free classification of heartbeat-run failures into a retry
 * disposition. Deterministic failure classes (bad config, auth, unsupported
 * model, missing secret) can never be fixed by retrying the same run, so they
 * are suppressed and the issue is blocked after the FIRST failure. This
 * generalizes the FUL-5634 quota-quarantine behavior to all deterministic
 * adapter/model/secret failures.
 *
 * This module imports nothing from the heartbeat service or the DB layer on
 * purpose: it is unit-testable in isolation and the heartbeat failure path
 * wires into it (see heartbeat.ts adapter-failure handler).
 */

/** Action the run lifecycle should take after a failure. */
export type RetryAction = "retry" | "suppress-block" | "defer";

/**
 * Normalized failure class. Deterministic classes are not retryable; transient
 * classes are; cooldown classes are deferred (rescheduled) rather than failed.
 */
export type FailureErrorClass =
  | "config" // adapter misconfigured (e.g. unconfigured adapter, bad endpoint)
  | "auth" // credentials present but rejected by provider
  | "unsupported-model" // requested model not allowed / unknown for adapter
  | "missing-secret" // a required secret is unbound at run time
  | "quota" // provider quota exhausted for the billing window
  | "rate-limit" // provider rate-limited this request
  | "transient" // network blip / 5xx / timeout
  | "process-lost" // local child process disappeared
  | "unknown"; // unclassified failure

export interface RetryClassification {
  /** What the lifecycle should do. */
  action: RetryAction;
  /** The normalized class the decision was based on. */
  errorClass: FailureErrorClass;
  /** Typed reason code, suitable for run metadata / events. */
  reason: string;
  /** Convenience: action === "retry". */
  retryable: boolean;
  /** Whether the issue should be set to `blocked` as a result of this failure. */
  block: boolean;
}

/** Deterministic classes: retrying the identical run cannot succeed. */
const DETERMINISTIC_CLASSES: ReadonlySet<FailureErrorClass> = new Set([
  "config",
  "auth",
  "unsupported-model",
  "missing-secret",
]);

/** Classes that should be deferred (rescheduled after a cooldown), not failed. */
const COOLDOWN_CLASSES: ReadonlySet<FailureErrorClass> = new Set([
  "quota",
  "rate-limit",
]);

/**
 * Classify whether a failed run should be retried, suppressed (blocked), or
 * deferred. Pure and deterministic.
 *
 * @param adapterType  adapter the run used (recorded in the reason; reserved
 *                     for future per-adapter policy overrides)
 * @param model        model the run used (recorded in the reason)
 * @param errorClass   normalized failure class (see {@link classifyErrorClass})
 */
export function classifyFailureRetryability(
  adapterType: string,
  model: string | null | undefined,
  errorClass: FailureErrorClass,
): RetryClassification {
  const modelTag = model ? `:${model}` : "";
  const scope = `${adapterType}${modelTag}`;

  if (DETERMINISTIC_CLASSES.has(errorClass)) {
    return {
      action: "suppress-block",
      errorClass,
      reason: `retry_suppressed_${errorClass.replace(/-/g, "_")}:${scope}`,
      retryable: false,
      block: true,
    };
  }

  if (COOLDOWN_CLASSES.has(errorClass)) {
    return {
      action: "defer",
      errorClass,
      reason: `retry_deferred_${errorClass.replace(/-/g, "_")}:${scope}`,
      retryable: false,
      block: false,
    };
  }

  // transient | process-lost | unknown — safe to retry (bounded elsewhere).
  return {
    action: "retry",
    errorClass,
    reason: `retry_allowed_${errorClass.replace(/-/g, "_")}:${scope}`,
    retryable: true,
    block: false,
  };
}

const AUTH_PATTERNS = [
  /\b401\b/,
  /\b403\b/,
  /unauthorized/i,
  /forbidden/i,
  /invalid[_\s-]?api[_\s-]?key/i,
  /authentication/i,
  /permission denied/i,
];
const QUOTA_PATTERNS = [
  /quota/i,
  /insufficient[_\s-]?quota/i,
  /billing/i,
  /credit/i,
];
const RATE_PATTERNS = [/\b429\b/, /rate[_\s-]?limit/i, /too many requests/i];
const UNSUPPORTED_MODEL_PATTERNS = [
  /model[_\s-]?not[_\s-]?(found|allowed|supported)/i,
  /unsupported model/i,
  /unknown model/i,
  /does not support/i,
];
const MISSING_SECRET_PATTERNS = [
  /missing[_\s-]?secret/i,
  /secret[_\s-]?unbound/i,
  /no api key/i,
  /api key not (set|configured|provided)/i,
  /credential(s)? (missing|not configured)/i,
];
const CONFIG_PATTERNS = [
  /adapter[_\s-]?unconfigured/i,
  /not configured/i,
  /misconfigur/i,
  /enoent/i,
  /command not found/i,
];
const TRANSIENT_PATTERNS = [
  /\b5\d\d\b/,
  /timeout/i,
  /timed out/i,
  /econnreset/i,
  /econnrefused/i,
  /socket hang up/i,
  /network/i,
  /temporarily unavailable/i,
];

/**
 * Best-effort mapping from a raw error code + message to a normalized class.
 * Deterministic and pattern-based so the wiring layer can call it without any
 * provider-specific knowledge. Order matters: the most actionable / specific
 * deterministic classes are checked before transient ones.
 */
export function classifyErrorClass(
  errorCode: string | null | undefined,
  message: string | null | undefined,
): FailureErrorClass {
  const code = (errorCode ?? "").toLowerCase();
  const text = `${errorCode ?? ""} ${message ?? ""}`;

  if (code === "process_lost") return "process-lost";

  const matches = (patterns: RegExp[]) => patterns.some((p) => p.test(text));

  // Deterministic, most-specific first.
  if (code.includes("missing_secret") || code.includes("secret_unbound") || matches(MISSING_SECRET_PATTERNS)) {
    return "missing-secret";
  }
  if (code.includes("unsupported_model") || code.includes("model_not_allowed") || matches(UNSUPPORTED_MODEL_PATTERNS)) {
    return "unsupported-model";
  }
  if (code.includes("auth") || matches(AUTH_PATTERNS)) return "auth";
  if (code.includes("quota") || matches(QUOTA_PATTERNS)) return "quota";
  if (code.includes("rate") || matches(RATE_PATTERNS)) return "rate-limit";
  if (code.includes("unconfigured") || code.includes("config") || matches(CONFIG_PATTERNS)) {
    return "config";
  }
  if (matches(TRANSIENT_PATTERNS)) return "transient";

  return "unknown";
}

/**
 * G1 — process-loss retry classification (reaper robustness).
 *
 * A `running` run whose local child process can no longer be found should be
 * retried exactly once when it belongs to a local-child-process adapter and
 * either (a) a pid/pgid was persisted, or (b) it had started (`startedAt` set)
 * but was killed before the pid/pgid was ever persisted — the "early-start kill
 * window". Both are bounded by `processLossRetryCount < 1`.
 *
 * Ancestry cap: the reaper retries at most once per run, but a flapping host can
 * cause the reconciler to create fresh continuation runs after each exhausted
 * reaper pair. `processLossChainCount` is propagated through the contextSnapshot
 * across both the reaper and the reconciler so that the total number of
 * process-loss failures in a chain is bounded by `PROCESS_LOSS_CHAIN_CAP`
 * regardless of which subsystem spawned each run.
 */

/** Maximum number of process-loss failures across the entire retry ancestry. */
export const PROCESS_LOSS_CHAIN_CAP = 5;

export interface ProcessLossRetryInput {
  tracksLocalChild: boolean;
  processPid: number | null | undefined;
  processGroupId: number | null | undefined;
  /** Set once the run actually began executing. */
  startedAt: Date | string | null | undefined;
  processLossRetryCount: number | null | undefined;
  /**
   * Total number of process-loss failures across the entire `retryOfRunId`
   * ancestry for this issue, propagated via contextSnapshot. When this reaches
   * `PROCESS_LOSS_CHAIN_CAP` no further retries are allowed regardless of the
   * per-run `processLossRetryCount`.
   */
  processLossChainCount?: number | null | undefined;
}

export function shouldRetryProcessLoss(input: ProcessLossRetryInput): boolean {
  if (!input.tracksLocalChild) return false;
  if ((input.processLossRetryCount ?? 0) >= 1) return false;
  // Ancestry cap: suppress if the chain has already seen too many losses.
  if ((input.processLossChainCount ?? 0) >= PROCESS_LOSS_CHAIN_CAP) return false;
  const hasTrackedHandle = !!input.processPid || !!input.processGroupId;
  // Early-start kill window: process was started but died before pid/pgid was
  // ever persisted, so there is no handle to observe — still a once-retryable
  // process loss rather than a permanent failure.
  const earlyStartKillWindow = !hasTrackedHandle && input.startedAt != null;
  return hasTrackedHandle || earlyStartKillWindow;
}
