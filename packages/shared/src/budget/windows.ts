// Window math for the agent-budgeting policy §5 (rollover) and §4.2 (per-window
// aggregate). This is the TypeScript mirror of the SQL bucket math in migration
// 0099 (cost_events_window_bounds). Both MUST produce identical windowKeys so
// preflight/charge code can read cost_events_window_agg by the same key the
// inline trigger wrote.
//
// All calendar windows are anchored to UTC regardless of session timezone, and
// windowKey is "<window>:<YYYYMMDD>T<HHMMSS>" of the UTC wall-clock bucket start
// (e.g. "day:20260603T000000"), matching Postgres
// to_char(window_start_wall, 'YYYYMMDD"T"HH24MISS').

export const CALENDAR_WINDOWS = ["minute", "hour", "day", "week", "month"] as const;
export type CalendarWindow = (typeof CALENDAR_WINDOWS)[number];

export const ROLLING_WINDOWS = ["rolling_24h", "rolling_7d", "rolling_30d"] as const;
export type RollingWindow = (typeof ROLLING_WINDOWS)[number];

// The full §2.2 window enum (kept in lock-step with `windows.allowed` in
// config/agent-budgeting.yaml and the budget_caps window CHECK).
export const BUDGET_WINDOWS = [...CALENDAR_WINDOWS, ...ROLLING_WINDOWS, "total"] as const;
export type BudgetWindow = (typeof BUDGET_WINDOWS)[number];

export function isCalendarWindow(window: string): window is CalendarWindow {
  return (CALENDAR_WINDOWS as readonly string[]).includes(window);
}

export function isRollingWindow(window: string): window is RollingWindow {
  return (ROLLING_WINDOWS as readonly string[]).includes(window);
}

export interface WindowBounds {
  // Half-open interval [windowStart, windowEnd).
  windowStart: Date;
  windowEnd: Date;
  windowKey: string;
}

const MS = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
} as const;

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

// "<window>:<YYYYMMDD>T<HHMMSS>" from the UTC components of the bucket start.
function windowKey(window: CalendarWindow, start: Date): string {
  const stamp =
    pad(start.getUTCFullYear(), 4) +
    pad(start.getUTCMonth() + 1, 2) +
    pad(start.getUTCDate(), 2) +
    "T" +
    pad(start.getUTCHours(), 2) +
    pad(start.getUTCMinutes(), 2) +
    pad(start.getUTCSeconds(), 2);
  return `${window}:${stamp}`;
}

// UTC-anchored truncation. `week` is Monday-anchored to match Postgres
// date_trunc('week', ...). Returns [start, end) for the calendar bucket `at`
// falls in.
export function calendarWindowBounds(window: CalendarWindow, at: Date): WindowBounds {
  const t = at.getTime();
  let start: Date;
  let end: Date;

  switch (window) {
    case "minute":
    case "hour":
    case "day": {
      const size = MS[window];
      const startMs = Math.floor(t / size) * size;
      start = new Date(startMs);
      end = new Date(startMs + size);
      break;
    }
    case "week": {
      // Monday 00:00:00 UTC of the week containing `at`.
      const dayStartMs = Math.floor(t / MS.day) * MS.day;
      const dayStart = new Date(dayStartMs);
      const daysFromMonday = (dayStart.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
      const startMs = dayStartMs - daysFromMonday * MS.day;
      start = new Date(startMs);
      end = new Date(startMs + 7 * MS.day);
      break;
    }
    case "month": {
      start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1, 0, 0, 0, 0));
      end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1, 0, 0, 0, 0));
      break;
    }
  }

  return { windowStart: start, windowEnd: end, windowKey: windowKey(window, start) };
}

// §5 boundary grace: for `windows.boundaryGraceSeconds` after a boundary tick,
// late writes are still folded into the window that just closed, so the
// *effective current* window stays the previous bucket until the grace elapses.
// Within [boundaryStart, boundaryStart + grace) of the new bucket, returns the
// previous bucket's bounds; otherwise the bucket `now` falls in.
export function currentCalendarWindow(
  window: CalendarWindow,
  now: Date,
  boundaryGraceSeconds = 0,
): WindowBounds {
  const current = calendarWindowBounds(window, now);
  if (boundaryGraceSeconds <= 0) return current;

  const sinceBoundaryMs = now.getTime() - current.windowStart.getTime();
  if (sinceBoundaryMs < boundaryGraceSeconds * 1000) {
    // Step one millisecond before the boundary to land in the prior bucket.
    return calendarWindowBounds(window, new Date(current.windowStart.getTime() - 1));
  }
  return current;
}

const ROLLING_DURATION_MS: Record<RollingWindow, number> = {
  rolling_24h: 24 * MS.hour,
  rolling_7d: 7 * MS.day,
  rolling_30d: 30 * MS.day,
};

export interface RollingBounds {
  windowStart: Date | null; // null == open-ended (`total`, lifetime)
  windowEnd: Date;
}

// Trailing window ending at `now` (§5). `total` is lifetime (open start).
export function rollingWindowBounds(window: RollingWindow | "total", now: Date): RollingBounds {
  if (window === "total") return { windowStart: null, windowEnd: now };
  return { windowStart: new Date(now.getTime() - ROLLING_DURATION_MS[window]), windowEnd: now };
}
