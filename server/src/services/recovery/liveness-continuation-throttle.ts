// Layer C of the adapter retry-storm hardening: bounded backoff for liveness
// continuations plus a per-issue rolling-window ceiling for upstream-throttle
// exits. Per-source-run attempt counters reset whenever a fresh wake starts a
// new source run, so per-run caps alone cannot bound the loop — the ceiling
// here spans source runs for the same issue.
//
// This module is intentionally dependency-free (structural input types only)
// so it can be unit-tested without the db or server wiring. All behavior is
// gated by PAPERCLIP_LIVENESS_CONTINUATION_THROTTLE_MODE: "off" | "shadow"
// (default; log-only, zero behavior change) | "enforce".

export type LivenessContinuationThrottleMode = "off" | "shadow" | "enforce";

export interface LivenessContinuationThrottleConfig {
  mode: LivenessContinuationThrottleMode;
  backoffBaseMs: number;
  backoffMaxMs: number;
  backoffJitterRatio: number;
  ceilingConsecutiveRuns: number;
  ceilingWindowMs: number;
}

export const LIVENESS_CONTINUATION_RETRY_REASON = "run_liveness_continuation";
export const UPSTREAM_THROTTLE_CEILING_PAUSE_REASON = "upstream_throttle_ceiling";
export const UPSTREAM_THROTTLE_LIVENESS_STATE = "upstream_throttled";

const UPSTREAM_THROTTLE_ERROR_FAMILIES = new Set(["transient_upstream", "upstream_throttled"]);
const UPSTREAM_THROTTLE_ERROR_CODES = new Set([
  "codex_transient_upstream",
  "claude_transient_upstream",
]);

export const DEFAULT_LIVENESS_CONTINUATION_THROTTLE_CONFIG: LivenessContinuationThrottleConfig = {
  mode: "shadow",
  backoffBaseMs: 60 * 1000,
  backoffMaxMs: 10 * 60 * 1000,
  backoffJitterRatio: 0.25,
  ceilingConsecutiveRuns: 5,
  ceilingWindowMs: 60 * 60 * 1000,
};

function readPositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveLivenessContinuationThrottleConfig(
  env: Record<string, string | undefined> = {},
): LivenessContinuationThrottleConfig {
  const defaults = DEFAULT_LIVENESS_CONTINUATION_THROTTLE_CONFIG;
  const rawMode = (env.PAPERCLIP_LIVENESS_CONTINUATION_THROTTLE_MODE ?? "").trim().toLowerCase();
  const mode: LivenessContinuationThrottleMode =
    rawMode === "off" || rawMode === "shadow" || rawMode === "enforce" ? rawMode : defaults.mode;
  const backoffBaseMs = readPositiveInteger(
    env.PAPERCLIP_LIVENESS_CONTINUATION_BACKOFF_BASE_MS,
    defaults.backoffBaseMs,
  );
  const backoffMaxMs = Math.max(
    backoffBaseMs,
    readPositiveInteger(env.PAPERCLIP_LIVENESS_CONTINUATION_BACKOFF_MAX_MS, defaults.backoffMaxMs),
  );
  return {
    mode,
    backoffBaseMs,
    backoffMaxMs,
    backoffJitterRatio: defaults.backoffJitterRatio,
    ceilingConsecutiveRuns: readPositiveInteger(
      env.PAPERCLIP_UPSTREAM_THROTTLE_CEILING_RUNS,
      defaults.ceilingConsecutiveRuns,
    ),
    ceilingWindowMs: readPositiveInteger(
      env.PAPERCLIP_UPSTREAM_THROTTLE_WINDOW_MS,
      defaults.ceilingWindowMs,
    ),
  };
}

export interface LivenessContinuationBackoffSchedule {
  attempt: number;
  baseDelayMs: number;
  delayMs: number;
  dueAt: Date;
}

export function computeLivenessContinuationBackoff(input: {
  attempt: number;
  config: LivenessContinuationThrottleConfig;
  now?: Date;
  random?: () => number;
}): LivenessContinuationBackoffSchedule | null {
  const { config } = input;
  if (!Number.isInteger(input.attempt) || input.attempt <= 0) return null;
  const now = input.now ?? new Date();
  const random = input.random ?? Math.random;
  const exponent = Math.min(input.attempt - 1, 16);
  const baseDelayMs = Math.min(config.backoffBaseMs * 2 ** exponent, config.backoffMaxMs);
  const sample = Math.min(1, Math.max(0, random()));
  const jitterMultiplier = 1 + (((sample * 2) - 1) * config.backoffJitterRatio);
  const delayMs = Math.min(
    config.backoffMaxMs,
    Math.max(1_000, Math.round(baseDelayMs * jitterMultiplier)),
  );
  return {
    attempt: input.attempt,
    baseDelayMs,
    delayMs,
    dueAt: new Date(now.getTime() + delayMs),
  };
}

export interface ThrottleExitRunLike {
  status?: string | null;
  errorCode?: string | null;
  livenessState?: string | null;
  resultJson?: unknown;
  finishedAt?: Date | string | null;
  createdAt?: Date | string | null;
}

function parseResultObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function readRunTimestamp(run: ThrottleExitRunLike): Date | null {
  for (const value of [run.finishedAt, run.createdAt]) {
    if (!value) continue;
    const parsed = value instanceof Date ? value : new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

// A run counts as an upstream-throttle exit when any signal in the adapter
// recovery contract marks it: the persisted errorFamily, the adapter error
// code (Layer A), or the upstream_throttled liveness state (Layer B). The
// liveness-state check is a string comparison on purpose so this module does
// not depend on the state having landed in the shared RunLivenessState union.
export function isUpstreamThrottleExitRun(run: ThrottleExitRunLike): boolean {
  if (run.errorCode && UPSTREAM_THROTTLE_ERROR_CODES.has(run.errorCode)) return true;
  if (run.livenessState === UPSTREAM_THROTTLE_LIVENESS_STATE) return true;
  const resultJson = parseResultObject(run.resultJson);
  const errorFamily = typeof resultJson.errorFamily === "string" ? resultJson.errorFamily : null;
  return errorFamily != null && UPSTREAM_THROTTLE_ERROR_FAMILIES.has(errorFamily);
}

export interface UpstreamThrottleStreak {
  streak: number;
  windowStart: Date;
  firstThrottleAt: Date | null;
  lastThrottleAt: Date | null;
}

// Statuses that count as evidence for streak purposes. Cancelled runs are
// deliberately absent on both sides of the streak: a cancellation is neither
// a throttle exit nor evidence the upstream recovered, so it neither extends
// nor breaks a streak (callers' SQL also filters them out; this guard keeps
// the pure function honest about whatever it is handed).
const STREAK_TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "timed_out"]);

// Counts consecutive throttle exits walking back from the most recent
// terminal run, stopping at the first non-throttle run or the first run
// outside the rolling window. Consecutive-within-window is what closes the
// new-source-run reset hole: the streak survives fresh wakes but any
// productive (non-throttle) run resets it.
export function summarizeUpstreamThrottleStreak(input: {
  runs: ThrottleExitRunLike[];
  now?: Date;
  windowMs: number;
}): UpstreamThrottleStreak {
  const now = input.now ?? new Date();
  const windowStart = new Date(now.getTime() - Math.max(0, input.windowMs));
  const ordered = input.runs
    .filter((run) => run.status == null || STREAK_TERMINAL_RUN_STATUSES.has(run.status))
    .map((run) => ({ run, at: readRunTimestamp(run) }))
    .filter((entry): entry is { run: ThrottleExitRunLike; at: Date } => entry.at != null)
    .sort((a, b) => b.at.getTime() - a.at.getTime());

  let streak = 0;
  let firstThrottleAt: Date | null = null;
  let lastThrottleAt: Date | null = null;
  for (const entry of ordered) {
    if (entry.at.getTime() < windowStart.getTime()) break;
    if (!isUpstreamThrottleExitRun(entry.run)) break;
    streak += 1;
    lastThrottleAt = lastThrottleAt ?? entry.at;
    firstThrottleAt = entry.at;
  }
  return { streak, windowStart, firstThrottleAt, lastThrottleAt };
}

export type UpstreamThrottleCeilingDecision =
  | { action: "none"; reason: string }
  | {
      action: "ceiling_reached";
      mode: LivenessContinuationThrottleMode;
      pauseAgent: boolean;
      streak: number;
      ceilingConsecutiveRuns: number;
      ceilingWindowMs: number;
      noticeMarker: string;
      noticeBody: string;
    };

export function buildUpstreamThrottleCeilingNoticeMarker(issueId: string) {
  return `upstream-throttle-ceiling:${issueId}`;
}

export function decideUpstreamThrottleCeiling(input: {
  streak: UpstreamThrottleStreak;
  config: LivenessContinuationThrottleConfig;
  issue: { id: string; identifier?: string | null; title?: string | null };
  agentId: string;
}): UpstreamThrottleCeilingDecision {
  const { streak, config, issue } = input;
  if (config.mode === "off") {
    return { action: "none", reason: "throttle ceiling disabled" };
  }
  if (streak.streak < config.ceilingConsecutiveRuns) {
    return {
      action: "none",
      reason: `streak ${streak.streak} below ceiling ${config.ceilingConsecutiveRuns}`,
    };
  }
  const windowMinutes = Math.round(config.ceilingWindowMs / 60_000);
  const label = issue.identifier ?? issue.id;
  return {
    action: "ceiling_reached",
    mode: config.mode,
    pauseAgent: config.mode === "enforce",
    streak: streak.streak,
    ceilingConsecutiveRuns: config.ceilingConsecutiveRuns,
    ceilingWindowMs: config.ceilingWindowMs,
    noticeMarker: buildUpstreamThrottleCeilingNoticeMarker(issue.id),
    noticeBody: [
      `Upstream throttle ceiling reached for ${label}`,
      "",
      `- Consecutive upstream-throttle exits: ${streak.streak} (ceiling ${config.ceilingConsecutiveRuns} within ${windowMinutes}m)`,
      `- First throttle exit in streak: ${streak.firstThrottleAt?.toISOString() ?? "unknown"}`,
      `- Latest throttle exit: ${streak.lastThrottleAt?.toISOString() ?? "unknown"}`,
      "- The real blocker is upstream provider capacity (rate limit / quota), not the task. Automatic retries for this issue are suspended; the assignee agent has been paused to stop the retry burst.",
      "- Next action: a human or manager should confirm the provider quota/rate-limit has recovered (or raise it), then unpause the agent to resume work.",
      "",
      `<!-- ${buildUpstreamThrottleCeilingNoticeMarker(issue.id)} -->`,
    ].join("\n"),
  };
}
