/**
 * Quiet hours window enforcement per AGENT-INFRA §3.9.
 *
 * Hard rule: no approval pings between 9pm-6:30am local (Pacific) time.
 * Decisions queue silently for the morning brief.
 *
 * This module is the deterministic gate; no LLM involved.
 */

import { QUIET_HOURS_START_HOUR, QUIET_HOURS_END_HOUR } from "./types.js";

/**
 * Returns true if the current moment is within US equity market hours:
 * 9:30am–4:00pm ET, Monday–Friday.
 *
 * Tier 3 (time-critical) trade approvals ONLY fire during market hours per
 * AGENT-INFRA §3.9 Phase 1B spec.
 */
export function isMarketHours(now: Date = new Date()): boolean {
  // Convert to ET using Intl.DateTimeFormat
  const etParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hour12: false,
  }).formatToParts(now);

  const get = (type: string) => etParts.find((p) => p.type === type)?.value ?? "";
  const weekday = get("weekday"); // Mon, Tue, Wed, Thu, Fri, Sat, Sun
  const hour = parseInt(get("hour"), 10);
  const minute = parseInt(get("minute"), 10);

  // Weekdays only
  if (weekday === "Sat" || weekday === "Sun") return false;

  const minuteOfDay = hour * 60 + minute;
  const marketOpen = 9 * 60 + 30;  // 9:30 AM ET
  const marketClose = 16 * 60;     // 4:00 PM ET
  return minuteOfDay >= marketOpen && minuteOfDay < marketClose;
}

/**
 * Returns true if the given moment is inside the quiet-hours window.
 * Window is [21:00, 06:30) in local time, wrapping midnight.
 */
export function isQuietHours(now: Date = new Date()): boolean {
  const hourFloat = now.getHours() + now.getMinutes() / 60;
  // Window wraps midnight: hour >= 21 OR hour < 6.5
  return hourFloat >= QUIET_HOURS_START_HOUR || hourFloat < QUIET_HOURS_END_HOUR;
}

/**
 * Approval tier per AGENT-INFRA §3.9. The bridge consults this to decide
 * whether to surface a Tier 3 (time-critical) approval immediately or queue
 * for the morning batch.
 */
export type ApprovalTier = "auto-decide" | "morning-batch" | "time-critical" | "hard-blocked";

/**
 * Returns true if this approval is allowed to fire now.
 *
 * - Tier 1 (auto-decide): always allowed (no human in loop anyway).
 * - Tier 2 (morning-batch): always defers to morning brief; never fires real-time.
 * - Tier 3 (time-critical): allowed ONLY outside quiet hours. If quiet hours,
 *   the firing is suppressed AND logged as a gate-mistuning signal.
 * - Tier 4 (hard-blocked): no approval flow exists; never fires.
 */
export function canFireApprovalNow(
  tier: ApprovalTier,
  now: Date = new Date(),
): { fire: boolean; reason: string } {
  switch (tier) {
    case "auto-decide":
      return { fire: true, reason: "auto-decide tier always fires immediately" };
    case "morning-batch":
      return { fire: false, reason: "Tier 2 morning-batch defers to 6:30am brief" };
    case "time-critical":
      if (isQuietHours(now)) {
        return {
          fire: false,
          reason: "Tier 3 time-critical suppressed during quiet hours; logged as mistuning signal",
        };
      }
      return { fire: true, reason: "Tier 3 time-critical fires real-time outside quiet hours" };
    case "hard-blocked":
      return { fire: false, reason: "Tier 4 hard-blocked: no approval flow exists" };
  }
}
