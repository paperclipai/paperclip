/**
 * G2 — Run preflight (FUL-6364 / ADR FUL-6348).
 *
 * Pure, dependency-free typed-reason checks evaluated at the claim/start path
 * of a heartbeat run, BEFORE an adapter child process is spawned. The goal is
 * to fail fast and deterministically on conditions a run can never recover from
 * by itself, instead of spawning a child that is guaranteed to fail and then
 * relying on the post-failure retry policy.
 *
 * Two dispositions:
 *  - "hard-fail": configuration / allow-list / secret problems. The run cannot
 *    succeed without operator action -> the issue is set to `blocked` and the
 *    run is NOT retried.
 *  - "soft-defer": transient capacity limits (quota / rate). The run is
 *    rescheduled after a cooldown rather than failed.
 *
 * This module imports nothing from the heartbeat service or the DB layer; the
 * claim/start path constructs a {@link PreflightContext} and calls
 * {@link evaluatePreflight}.
 */

export type PreflightDisposition = "hard-fail" | "soft-defer";

export type PreflightReason =
  | "preflight_adapter_unconfigured"
  | "preflight_model_not_allowed"
  | "preflight_secret_unbound"
  | "preflight_routine_secret_denied"
  | "preflight_quota_cooldown"
  | "preflight_rate_exhausted";

export interface PreflightFinding {
  reason: PreflightReason;
  disposition: PreflightDisposition;
  /** Whether the run may be retried/rescheduled (true only for soft-defer). */
  retryable: boolean;
  /** Whether the issue should be set to `blocked` (true only for hard-fail). */
  block: boolean;
  /** Suggested reschedule delay for soft-defer findings, in ms. */
  deferMs?: number;
  /** Human-readable, secret-free explanation. */
  message: string;
}

export type PreflightResult =
  | { ok: true }
  | ({ ok: false } & PreflightFinding);

/** Input describing the resolved run config at claim time. Secret-free. */
export interface PreflightContext {
  adapterType: string;
  /** False when no usable adapter config could be resolved for the agent. */
  adapterConfigured: boolean;
  /** The model the run intends to use, if any. */
  requestedModel?: string | null;
  /**
   * Allow-list of models for this adapter/role. When null/undefined the
   * allow-list check is skipped (no restriction configured).
   */
  allowedModels?: readonly string[] | null;
  /** Names of secrets the run requires (names only — never values). */
  requiredSecretNames?: readonly string[];
  /** Names of secrets actually bound/available at run time (names only). */
  boundSecretNames?: readonly string[];
  /**
   * Routine context: when a run originates from a routine, the routine may be
   * denied access to specific secret names by policy. Names only.
   */
  routineId?: string | null;
  routineDeniedSecretNames?: readonly string[];
  /** Provider quota state. */
  quota?: { exhausted?: boolean; cooldownMs?: number } | null;
  /** Provider rate-limit state. */
  rate?: { exhausted?: boolean; cooldownMs?: number } | null;
}

const DEFAULT_QUOTA_COOLDOWN_MS = 15 * 60 * 1000; // 15m, aligns with cadence policy
const DEFAULT_RATE_COOLDOWN_MS = 60 * 1000; // 1m

/**
 * Evaluate all preflight checks in priority order and return the first failing
 * finding. Hard-fail conditions are checked before soft-defer conditions so a
 * misconfiguration is surfaced even if the provider is also rate-limited.
 *
 * Pure: returns a value; does not mutate the context or perform I/O.
 */
export function evaluatePreflight(ctx: PreflightContext): PreflightResult {
  const checks: Array<(c: PreflightContext) => PreflightFinding | null> = [
    checkAdapterConfigured,
    checkRoutineSecretDenied,
    checkSecretsBound,
    checkModelAllowed,
    checkQuotaCooldown,
    checkRateExhausted,
  ];
  for (const check of checks) {
    const finding = check(ctx);
    if (finding) return { ok: false, ...finding };
  }
  return { ok: true };
}

function hardFail(
  reason: PreflightReason,
  message: string,
): PreflightFinding {
  return { reason, disposition: "hard-fail", retryable: false, block: true, message };
}

function softDefer(
  reason: PreflightReason,
  message: string,
  deferMs: number,
): PreflightFinding {
  return { reason, disposition: "soft-defer", retryable: true, block: false, deferMs, message };
}

export function checkAdapterConfigured(ctx: PreflightContext): PreflightFinding | null {
  if (ctx.adapterConfigured) return null;
  return hardFail(
    "preflight_adapter_unconfigured",
    `Adapter '${ctx.adapterType}' has no usable configuration; cannot start run.`,
  );
}

export function checkRoutineSecretDenied(ctx: PreflightContext): PreflightFinding | null {
  if (!ctx.routineId) return null;
  const required = ctx.requiredSecretNames ?? [];
  const denied = new Set(ctx.routineDeniedSecretNames ?? []);
  const blockedName = required.find((name) => denied.has(name));
  if (!blockedName) return null;
  return hardFail(
    "preflight_routine_secret_denied",
    `Routine '${ctx.routineId}' is denied access to required secret '${blockedName}'.`,
  );
}

export function checkSecretsBound(ctx: PreflightContext): PreflightFinding | null {
  const required = ctx.requiredSecretNames ?? [];
  if (required.length === 0) return null;
  const bound = new Set(ctx.boundSecretNames ?? []);
  const missing = required.filter((name) => !bound.has(name));
  if (missing.length === 0) return null;
  return hardFail(
    "preflight_secret_unbound",
    `Required secret(s) unbound at run time: ${missing.join(", ")}.`,
  );
}

export function checkModelAllowed(ctx: PreflightContext): PreflightFinding | null {
  const allowed = ctx.allowedModels;
  if (!allowed || allowed.length === 0) return null; // no restriction configured
  if (!ctx.requestedModel) return null; // adapter default; nothing to validate
  if (allowed.includes(ctx.requestedModel)) return null;
  return hardFail(
    "preflight_model_not_allowed",
    `Model '${ctx.requestedModel}' is not in the allow-list for adapter '${ctx.adapterType}'.`,
  );
}

export function checkQuotaCooldown(ctx: PreflightContext): PreflightFinding | null {
  if (!ctx.quota?.exhausted) return null;
  return softDefer(
    "preflight_quota_cooldown",
    `Provider quota exhausted for adapter '${ctx.adapterType}'; deferring run.`,
    ctx.quota.cooldownMs ?? DEFAULT_QUOTA_COOLDOWN_MS,
  );
}

export function checkRateExhausted(ctx: PreflightContext): PreflightFinding | null {
  if (!ctx.rate?.exhausted) return null;
  return softDefer(
    "preflight_rate_exhausted",
    `Provider rate limit reached for adapter '${ctx.adapterType}'; deferring run.`,
    ctx.rate.cooldownMs ?? DEFAULT_RATE_COOLDOWN_MS,
  );
}
