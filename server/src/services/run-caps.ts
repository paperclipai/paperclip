import {
  type AgentRunCaps,
  type AgentRole,
  AGENT_DEFAULT_RUN_CAPS,
  CODER_AGENT_RUN_CAPS,
  CODER_AGENT_ROLES,
} from "@paperclipai/shared";

/**
 * Deterministic run-rate / no-progress cap evaluator (WEI-209/WEI-210).
 *
 * This module is intentionally PURE (no DB, no clock, no side effects) so the
 * cap logic is trivially and deterministically unit-testable. The DB query +
 * pause + notification wiring lives in the run lifecycle gate in
 * `heartbeat.ts`; this file owns only the decision.
 */

/** Reason kinds for an auto-pause decision. */
export type RunCapPauseKind = "run_rate_hour" | "run_rate_day" | "no_progress";

/** A terminal heartbeat run, reduced to the fields the no-progress check needs. */
export interface RunCapRunRecord {
  /** Issue the run was working (heartbeat_runs.context_snapshot ->> 'issueId'). */
  issueId: string | null;
  /** When concrete useful action evidence was last recorded for the run. */
  lastUsefulActionAt: Date | null;
}

export interface EvaluateRunCapsInput {
  caps: AgentRunCaps;
  /** Issue the run that is about to start is working on (may be null). */
  currentIssueId: string | null;
  /**
   * Count of this agent's heartbeat runs created within the last rolling hour,
   * INCLUDING the current run that is about to start.
   */
  runsLastHour: number;
  /** Count within the last rolling 24h, INCLUDING the current run. */
  runsLastDay: number;
  /**
   * The agent's most recent TERMINAL runs (excluding the current one),
   * newest-first. Used for the no-progress streak check.
   */
  recentRuns: RunCapRunRecord[];
}

export interface RunCapDecision {
  shouldPause: boolean;
  /** Pause kind, or null when no cap is exceeded. */
  kind: RunCapPauseKind | null;
  /**
   * `pause_reason` string in the `auto:<grund> (<wert>)` format required by the
   * plan, or null when no cap is exceeded.
   */
  reason: string | null;
}

const NO_PAUSE: RunCapDecision = { shouldPause: false, kind: null, reason: null };

/**
 * Resolve the effective caps for an agent: a role-based base (coder vs standard)
 * with a merge-safe per-agent override from `adapter_config.runCaps`. Only the
 * three known keys are read; no other adapterConfig fields are touched.
 */
export function resolveRunCaps(
  role: AgentRole | string | null | undefined,
  adapterConfig: Record<string, unknown> | null | undefined,
): AgentRunCaps {
  const base = role && (CODER_AGENT_ROLES as readonly string[]).includes(role)
    ? CODER_AGENT_RUN_CAPS
    : AGENT_DEFAULT_RUN_CAPS;

  const override = adapterConfig && typeof adapterConfig.runCaps === "object" && adapterConfig.runCaps !== null
    ? (adapterConfig.runCaps as Record<string, unknown>)
    : null;

  const pick = (key: keyof AgentRunCaps, fallback: number): number => {
    const value = override?.[key];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
  };

  return {
    perHour: pick("perHour", base.perHour),
    perDay: pick("perDay", base.perDay),
    maxConsecutiveRuns: pick("maxConsecutiveRuns", base.maxConsecutiveRuns),
  };
}

/**
 * Decide whether the agent should be auto-paused before its next run starts.
 *
 * Run-rate: pause when the rolling-window run count (including the current run)
 * exceeds the cap — i.e. caps.perHour runs are allowed and the next is blocked.
 *
 * No-progress: pause when the last `maxConsecutiveRuns` terminal runs are all on
 * the same issue as the current run AND none of them advanced
 * `last_useful_action_at` beyond the value at the start of the streak. Because
 * `last_useful_action_at` is only set when a run produces concrete evidence
 * (issue status change, comment, commit, plan revision, …), this captures the
 * WEI-65 pattern of repeated runs that change nothing, with no false positives
 * on agents that are genuinely making progress each run.
 */
export function evaluateRunCaps(input: EvaluateRunCapsInput): RunCapDecision {
  const { caps, currentIssueId, runsLastHour, runsLastDay, recentRuns } = input;

  if (runsLastHour > caps.perHour) {
    return { shouldPause: true, kind: "run_rate_hour", reason: `auto:run_rate_hour (${runsLastHour})` };
  }
  if (runsLastDay > caps.perDay) {
    return { shouldPause: true, kind: "run_rate_day", reason: `auto:run_rate_day (${runsLastDay})` };
  }

  // No-progress streak. Needs a known issue and enough history.
  if (!currentIssueId) return NO_PAUSE;
  if (caps.maxConsecutiveRuns <= 0) return NO_PAUSE;
  if (recentRuns.length < caps.maxConsecutiveRuns) return NO_PAUSE;

  const streak = recentRuns.slice(0, caps.maxConsecutiveRuns); // newest-first

  // Every run in the streak must be on the same issue as the current run.
  if (!streak.every((run) => run.issueId === currentIssueId)) return NO_PAUSE;

  // Progress = any run in the streak advanced last_useful_action_at beyond the
  // baseline (the value at the start of the streak — its oldest run). All-null
  // or non-advancing => no progress => pause.
  const oldest = streak[streak.length - 1];
  const baseline = oldest.lastUsefulActionAt ? oldest.lastUsefulActionAt.getTime() : null;
  const advanced = streak.some((run) => {
    if (!run.lastUsefulActionAt) return false;
    const ts = run.lastUsefulActionAt.getTime();
    return baseline === null ? true : ts > baseline;
  });
  if (advanced) return NO_PAUSE;

  return {
    shouldPause: true,
    kind: "no_progress",
    reason: `auto:no_progress (${caps.maxConsecutiveRuns})`,
  };
}
