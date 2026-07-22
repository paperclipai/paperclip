/**
 * Humanized heartbeat cadence helpers.
 *
 * The heartbeat interval is *stored as seconds* (unchanged wire format). The
 * Schedule & Runs UI presents it as "Every [N] [unit]" with a live
 * consequence preview ("≈ 288 runs/day"). Raw seconds invited 300-vs-3000
 * mistakes (see wireframe 05); the unit select is purely a display
 * convenience and must round-trip back to the exact same seconds.
 */

export type CadenceUnit = "seconds" | "minutes" | "hours";

export interface Cadence {
  value: number;
  unit: CadenceUnit;
}

export const CADENCE_UNIT_SECONDS: Record<CadenceUnit, number> = {
  seconds: 1,
  minutes: 60,
  hours: 3600,
};

export const CADENCE_UNIT_LABELS: Record<CadenceUnit, string> = {
  seconds: "seconds",
  minutes: "minutes",
  hours: "hours",
};

/** Ordered largest-first for choosing the coarsest exact unit. */
const UNITS_LARGEST_FIRST: CadenceUnit[] = ["hours", "minutes", "seconds"];

const SECONDS_PER_DAY = 86_400;

/** Clamp to a sane positive integer number of seconds. */
export function normalizeIntervalSec(seconds: number): number {
  if (!Number.isFinite(seconds)) return 1;
  return Math.max(1, Math.floor(seconds));
}

/**
 * Pick the coarsest unit that represents `seconds` as a whole number, so
 * 300 → 5 minutes, 3600 → 1 hour, and 90 → 90 seconds (not 1.5 minutes).
 */
export function secondsToCadence(seconds: number): Cadence {
  const normalized = normalizeIntervalSec(seconds);
  for (const unit of UNITS_LARGEST_FIRST) {
    const unitSeconds = CADENCE_UNIT_SECONDS[unit];
    if (normalized % unitSeconds === 0) {
      return { value: normalized / unitSeconds, unit };
    }
  }
  return { value: normalized, unit: "seconds" };
}

/** Inverse of {@link secondsToCadence}. Always ≥ 1 second. */
export function cadenceToSeconds(value: number, unit: CadenceUnit): number {
  const safeValue = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  return normalizeIntervalSec(safeValue * CADENCE_UNIT_SECONDS[unit]);
}

/** Runs per day at this interval (float). */
export function runsPerDay(seconds: number): number {
  return SECONDS_PER_DAY / normalizeIntervalSec(seconds);
}

/**
 * Human consequence preview, e.g. "≈ 288 runs/day", "≈ 24 runs/day",
 * "≈ 1 run/day", or "< 1 run/day" for very long intervals.
 */
export function formatRunsPerDay(seconds: number): string {
  const perDay = runsPerDay(seconds);
  if (perDay < 1) return "< 1 run/day";
  // Whole numbers below 100 are exact; larger values round to keep it compact.
  const rounded = perDay >= 100 ? Math.round(perDay) : Math.round(perDay * 10) / 10;
  const display = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `≈ ${display} run${rounded === 1 ? "" : "s"}/day`;
}
