/**
 * Recurrence support for issues (FUS-660).
 *
 * A recurring issue carries an {@link IssueRecurrence} config plus a `dueAt`.
 * When the issue is completed, the server spawns the next instance with its
 * `dueAt` advanced by one recurrence step (see `computeNextDueDate`).
 */

export const ISSUE_RECURRENCE_FREQUENCIES = ["daily", "weekly", "monthly", "yearly"] as const;

export type IssueRecurrenceFrequency = (typeof ISSUE_RECURRENCE_FREQUENCIES)[number];

export interface IssueRecurrence {
  /** Cadence unit. */
  frequency: IssueRecurrenceFrequency;
  /** Repeat every N units (e.g. interval 2 + weekly = every 2 weeks). >= 1. */
  interval: number;
}

/** Largest interval we accept, to keep date math and UI bounded. */
export const ISSUE_RECURRENCE_MAX_INTERVAL = 365;

export function isIssueRecurrenceFrequency(value: unknown): value is IssueRecurrenceFrequency {
  return (
    typeof value === "string" &&
    (ISSUE_RECURRENCE_FREQUENCIES as readonly string[]).includes(value)
  );
}

/**
 * Advance a date by one recurrence step.
 *
 * Calendar-aware: monthly/yearly steps add months/years (so the day-of-month is
 * preserved where possible) rather than a fixed number of days. Daily/weekly add
 * a fixed number of days. The returned Date is a new instance; the input is not
 * mutated.
 */
export function advanceDate(from: Date, recurrence: IssueRecurrence): Date {
  const interval = normalizeInterval(recurrence.interval);
  const next = new Date(from.getTime());
  switch (recurrence.frequency) {
    case "daily":
      next.setUTCDate(next.getUTCDate() + interval);
      return next;
    case "weekly":
      next.setUTCDate(next.getUTCDate() + interval * 7);
      return next;
    case "monthly":
      addUTCMonths(next, interval);
      return next;
    case "yearly":
      addUTCMonths(next, interval * 12);
      return next;
    default:
      return next;
  }
}

/**
 * Compute the next due date for a recurring issue being completed.
 *
 * Anchors on the issue's current `dueAt` when present so cadence does not drift
 * with completion time; falls back to `completedAt` (now) when no due date is
 * set. Always returns a due date strictly in the future relative to `now` so a
 * task completed late does not immediately re-spawn as already-overdue.
 */
export function computeNextDueDate(
  previousDueAt: Date | null | undefined,
  recurrence: IssueRecurrence,
  now: Date = new Date(),
): Date {
  let next = advanceDate(previousDueAt ?? now, recurrence);
  // If the task was completed well after its due date, keep stepping until the
  // next occurrence is in the future so cadence resumes from "now", not the past.
  let guard = 0;
  while (next.getTime() <= now.getTime() && guard < ISSUE_RECURRENCE_MAX_INTERVAL + 1) {
    next = advanceDate(next, recurrence);
    guard += 1;
  }
  return next;
}

function normalizeInterval(interval: number): number {
  if (!Number.isFinite(interval)) return 1;
  const floored = Math.floor(interval);
  if (floored < 1) return 1;
  if (floored > ISSUE_RECURRENCE_MAX_INTERVAL) return ISSUE_RECURRENCE_MAX_INTERVAL;
  return floored;
}

/** Add whole months in UTC, clamping the day to the target month's length. */
function addUTCMonths(date: Date, months: number): void {
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const daysInTargetMonth = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
  date.setUTCDate(Math.min(day, daysInTargetMonth));
}
