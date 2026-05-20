/**
 * Phase E2 escalation backstop helper.
 *
 * Given a routing tier that just failed, return the next tier up the
 * MODEL_MENU ladder (more capable, typically more expensive) — or null
 * if there is no next tier (i.e. the heavy tier already failed and we
 * cannot escalate further).
 *
 * Tier order (cheapest → most expensive, locked in MODEL_MENU.md):
 *   local → fast → default → heavy → (cap)
 *
 * Used by the heartbeat dispatcher in services/heartbeat.ts: after an
 * adapter.execute call returns a "failed" outcome (exit code != 0, not
 * cancelled, not timed-out), the dispatcher consults this helper to
 * decide whether to retry once with the escalated tier. The retry uses
 * the same heartbeat_run record (no new run is created); heartbeat_runs.
 * escalation_count is incremented to 1 to mark the retry. Per the
 * routing-layer design, only one escalation is allowed per task.
 *
 * Pure functional: no DB reads, no env reads, no side effects.
 */
import type { RoutingTier } from "@paperclipai/shared";

/**
 * Ordered tier ladder. Index in this array is the canonical tier rank;
 * `escalateOneTier(t)` returns `TIER_LADDER[index(t) + 1]` or null at
 * the cap.
 */
export const TIER_LADDER: readonly RoutingTier[] = [
  "local",
  "fast",
  "default",
  "heavy",
] as const;

/**
 * Returns the next tier up the ladder, or null if `tier` is already the
 * highest (heavy). Useful to determine whether escalation is possible
 * before deciding to retry an adapter call.
 */
export function escalateOneTier(tier: RoutingTier): RoutingTier | null {
  const idx = TIER_LADDER.indexOf(tier);
  if (idx < 0) return null;
  const next = TIER_LADDER[idx + 1];
  return next ?? null;
}
