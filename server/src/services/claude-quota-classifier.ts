/**
 * SOF-548 / SOF-550 — classifier for Anthropic Token Plan cap failures.
 *
 * The claude-local adapter collapses plan-cap (HTTP 2056/2062) and real-transient
 * (HTTP 5xx/429 burst) into the single errorCode `claude_transient_upstream`.
 * Operators need to distinguish them: plan-cap failures mean the agent cannot
 * do useful work until the board Token Plan tier is upgraded or the daily
 * window resets; transient failures can succeed on retry.
 *
 * This helper distills the plan-cap pattern from the message body so the
 * heartbeat finalizer can auto-pause the agent instead of looping. The pattern
 * matches the same regex tokens the adapter already uses in
 * `parse.ts:CLAUDE_TRANSIENT_UPSTREAM_RE`, narrowed to the plan-cap subset.
 */

export const CLAUDE_TOKEN_PLAN_CAP_RE =
  /token\s+plan\s+(?:usage\s+)?(?:limit|cap)|usage\s+limit\s+reached|plan\s+(?:rate\s+)?limit\s+reached|5[-\s]?hour\s+limit\s+reached|weekly\s+limit\s+reached|out\s+of\s+extra\s+usage/i;

export function isClaudeTokenPlanCapFailure(
  errorCode: string | null | undefined,
  failureReason: string | null | undefined,
): boolean {
  if (errorCode !== "claude_transient_upstream") return false;
  if (!failureReason) return false;
  return CLAUDE_TOKEN_PLAN_CAP_RE.test(failureReason);
}

/**
 * Cooldown on auto-pause re-fires — protects against a successful probe after a
 * 429 burst immediately flipping the agent back to paused. Five minutes is
 * short enough that the board Tier upgrade (the canonical unblock path on
 * SOF-292) takes effect within one tick, and long enough that a transient
 * burst doesn't lock the agent for the rest of the hour.
 */
export const QUOTA_PAUSE_COOLDOWN_MS = 5 * 60 * 1000;