// Continuation-retry circuit-breaker (shadow-mode first).
//
// Prevents the "zero-cost `process_lost` storm" class: a transient subprocess startup loss
// produces a `process_lost` run with null usage / zero cost, and the unbounded
// `issue_continuation_needed` auto-retry re-wakes it immediately with no backoff — amplifying
// one transient loss into dozens of wasted runs (observed: 64 retries in 2h on a single issue).
//
// This module is a PURE decision layer. It computes, from run history, a per-issue streak of
// consecutive zero-cost `process_lost` runs and decides whether the scheduler should back off
// (streak < N) or trip the breaker (streak >= N). It performs NO scheduling and NO I/O — the
// caller (recovery service) applies the verdict.
//
// Rollout is shadow-first: in `shadow` mode the caller LOGS the verdict and changes nothing;
// only `enforce` mode acts. Default mode is `shadow`, so landing this is behavior-neutral until
// the zero-false-trip gate passes and the mode is flipped.

/** Config for the continuation-retry circuit-breaker. Defaults are behavior-neutral (shadow). */
export interface ContinuationBreakerConfig {
  /** Matcher + streak run and log even in shadow; `mode` gates the *action*. */
  enabled: boolean;
  /** `shadow` = observe/log only (no behavior change). `enforce` = act on the verdict. */
  mode: "shadow" | "enforce";
  /** Trip threshold: streak >= N trips the breaker. */
  N: number;
  /** Exponential backoff base for streak < N. */
  baseDelayMs: number;
  /** Backoff cap. */
  capMs: number;
  /** Optional auto-probe cooldown after a trip (0 disables). Consumed by the enforce-stage follow-up. */
  probeCooldownMs: number;
}

export const CONTINUATION_BREAKER_DEFAULTS: ContinuationBreakerConfig = {
  enabled: true,
  mode: "shadow",
  N: 4,
  baseDelayMs: 30_000,
  capMs: 300_000, // 5m
  probeCooldownMs: 900_000, // 15m
};

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

/**
 * Resolve the effective config from env overrides layered on the defaults. Env-based config
 * mirrors the existing recovery-service knobs (e.g. STRANDED_RECENT_PROGRESS_EXEMPTION_MS) and
 * keeps the shadow-first PR free of a settings-schema migration. Instance-settings wiring is a
 * Stage-2 follow-up once shadow data validates the matcher.
 */
export function resolveContinuationBreakerConfig(
  overrides: Partial<ContinuationBreakerConfig> = {},
): ContinuationBreakerConfig {
  const envMode = process.env.CONTINUATION_BREAKER_MODE;
  return {
    enabled: process.env.CONTINUATION_BREAKER_ENABLED === "false"
      ? false
      : overrides.enabled ?? CONTINUATION_BREAKER_DEFAULTS.enabled,
    mode: envMode === "enforce" || envMode === "shadow"
      ? envMode
      : overrides.mode ?? CONTINUATION_BREAKER_DEFAULTS.mode,
    N: readEnvInt("CONTINUATION_BREAKER_N", overrides.N ?? CONTINUATION_BREAKER_DEFAULTS.N),
    baseDelayMs: readEnvInt(
      "CONTINUATION_BREAKER_BASE_DELAY_MS",
      overrides.baseDelayMs ?? CONTINUATION_BREAKER_DEFAULTS.baseDelayMs,
    ),
    capMs: readEnvInt("CONTINUATION_BREAKER_CAP_MS", overrides.capMs ?? CONTINUATION_BREAKER_DEFAULTS.capMs),
    probeCooldownMs: readEnvInt(
      "CONTINUATION_BREAKER_PROBE_COOLDOWN_MS",
      overrides.probeCooldownMs ?? CONTINUATION_BREAKER_DEFAULTS.probeCooldownMs,
    ),
  };
}

/** Minimal secret-manifest entry shape the matcher inspects. */
export interface BreakerSecretManifestEntry {
  outcome: "success" | "failure";
}

/**
 * Minimal run shape the matcher needs. Field mapping to `heartbeat_runs` (reconciled against HEAD):
 * - `stopReason == process_lost`  ==  `status === "failed" && errorCode === "process_lost"`
 *   (equivalently `resultJson.stopReason === "process_lost"`; see heartbeat-stop-metadata.ts).
 * - `usageJson == null`  ==  zero-cost startup loss (no usage recorded => no cost). There is no
 *   separate `costCents` column; a null usage row is definitionally zero-cost, so the design's
 *   `costCents in {0,null}` guard collapses into the usage guard.
 * - secret manifest lives at `contextSnapshot.paperclipSecrets.manifest[]` with `.outcome`.
 */
export interface BreakerRun {
  status: string | null | undefined;
  errorCode: string | null | undefined;
  usageJson: Record<string, unknown> | null | undefined;
  secretManifest?: readonly BreakerSecretManifestEntry[] | null;
  // True when a secret manifest was expected but could not be read (a present-but-malformed
  // contextSnapshot, or a `paperclipSecrets` block whose `manifest` is not an array). We cannot
  // then confirm the absence of a failed secret, so — conservatively — such a run is NOT treated
  // as a clean startup loss. This keeps the load-bearing "never false-trip" guarantee: an
  // unreadable manifest resets the streak instead of counting as clean.
  secretManifestUnreadable?: boolean;
}

/**
 * The clean trip-wire signature (plan §2). Load-bearing guard: a paid run (non-null usage) can
 * NEVER match — this is the CEO hard constraint that the breaker must not fire on normal retries.
 */
export function isZeroCostProcessLost(run: BreakerRun): boolean {
  if (!(run.status === "failed" && run.errorCode === "process_lost")) return false;
  if (run.usageJson != null) return false; // paid / usage-bearing run can never match
  if (run.secretManifestUnreadable) return false; // cannot confirm no auth defect => not clean
  const manifest = run.secretManifest;
  if (manifest && manifest.length > 0) {
    if (!manifest.every((entry) => entry.outcome === "success")) return false;
  }
  return true;
}

/**
 * Extract the matcher inputs from a raw heartbeat_runs-shaped row (+ parsed contextSnapshot).
 * `contextSnapshot.paperclipSecrets.manifest` is written at run start (heartbeat.ts).
 */
export function breakerRunFromRow(row: {
  status: string | null | undefined;
  errorCode: string | null | undefined;
  usageJson: Record<string, unknown> | null | undefined;
  contextSnapshot: unknown;
}): BreakerRun {
  const { manifest, unreadable } = readSecretManifest(row.contextSnapshot);
  return {
    status: row.status,
    errorCode: row.errorCode,
    usageJson: row.usageJson,
    secretManifest: manifest,
    secretManifestUnreadable: unreadable,
  };
}

/**
 * Resolve the secret manifest from a run's contextSnapshot, distinguishing three cases:
 * - **Absent** (`manifest: null, unreadable: false`): no run-scoped secrets recorded. The platform
 *   only writes `contextSnapshot.paperclipSecrets` when secrets exist, so its absence is a positive
 *   "no secrets" signal — a clean startup loss can legitimately match.
 * - **Readable** (`manifest: Entry[], unreadable: false`): each entry's outcome is inspected;
 *   any non-`success` (including a malformed entry) is treated as a `failure`, never dropped.
 * - **Unreadable** (`manifest: null, unreadable: true`): the contextSnapshot is present but not an
 *   inspectable object, or `paperclipSecrets` exists but its `manifest` is not an array. We cannot
 *   confirm the absence of a failed secret, so the caller must not count the run as clean.
 */
function readSecretManifest(
  contextSnapshot: unknown,
): { manifest: BreakerSecretManifestEntry[] | null; unreadable: boolean } {
  if (contextSnapshot == null) return { manifest: null, unreadable: false };
  if (typeof contextSnapshot !== "object") return { manifest: null, unreadable: true };
  const secrets = (contextSnapshot as Record<string, unknown>).paperclipSecrets;
  if (secrets == null) return { manifest: null, unreadable: false };
  if (typeof secrets !== "object") return { manifest: null, unreadable: true };
  const manifest = (secrets as Record<string, unknown>).manifest;
  if (!Array.isArray(manifest)) return { manifest: null, unreadable: true };
  return {
    manifest: manifest.map((entry): BreakerSecretManifestEntry => ({
      outcome:
        entry != null &&
        typeof entry === "object" &&
        (entry as Record<string, unknown>).outcome === "success"
          ? "success"
          : "failure",
    })),
    unreadable: false,
  };
}

/**
 * Count the streak of consecutive zero-cost `process_lost` runs at the head of run history.
 * `runs` MUST be ordered newest-first. Any non-matching run (paid, non-`process_lost` stop,
 * failed-secret manifest) terminates the streak — mirroring the reset rule in plan §3 and the
 * existing `summarizeRecentContinuationRetries` walk.
 */
export function zcplStreakFromRuns(runs: readonly BreakerRun[]): number {
  let streak = 0;
  for (const run of runs) {
    if (!isZeroCostProcessLost(run)) break;
    streak += 1;
  }
  return streak;
}

export type ContinuationBreakerVerdict = "would-backoff" | "would-trip";

export interface ContinuationBreakerDecision {
  streak: number;
  tripped: boolean;
  verdict: ContinuationBreakerVerdict;
  /** Backoff delay for a `would-backoff` verdict; 0 for `would-trip`. */
  wouldDelayMs: number;
}

/**
 * Decide the breaker action for a given streak (plan §4). Pure math — the caller applies it
 * (logs it in shadow, acts on it in enforce). For streak 0 the breaker is inert (`would-backoff`,
 * 0ms) — there is nothing to back off from.
 */
export function decideContinuationBreaker(
  streak: number,
  cfg: ContinuationBreakerConfig,
): ContinuationBreakerDecision {
  const safeStreak = Math.max(0, Math.floor(streak));
  if (safeStreak >= cfg.N) {
    return { streak: safeStreak, tripped: true, verdict: "would-trip", wouldDelayMs: 0 };
  }
  // s >= 1 here for a meaningful backoff; s == 0 yields base>>-1 handled by the max/exponent floor.
  const exponent = Math.max(0, safeStreak - 1);
  const wouldDelayMs = safeStreak === 0
    ? 0
    : Math.min(cfg.baseDelayMs * 2 ** exponent, cfg.capMs);
  return { streak: safeStreak, tripped: false, verdict: "would-backoff", wouldDelayMs };
}
