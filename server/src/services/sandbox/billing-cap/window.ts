/**
 * Phase 4A-S4 B2 (LET-367): UTC day/month window boundaries.
 *
 * Counters reset at UTC midnight (day) and 00:00 UTC on the first of each
 * month (month). The monitor calls these helpers on every tick so the
 * persisted window markers stay in sync with wall-clock progression.
 */

export interface UtcWindowBounds {
  /** Inclusive lower bound at UTC midnight (or first-of-month 00:00Z). */
  start: Date;
  /** Exclusive upper bound: next-day midnight UTC (or first of next month). */
  end: Date;
}

export function utcDayBounds(at: Date): UtcWindowBounds {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), 0, 0, 0, 0));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}

export function utcMonthBounds(at: Date): UtcWindowBounds {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1, 0, 0, 0, 0));
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  return { start, end };
}

export function isSameUtcDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

export function isSameUtcMonth(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth();
}
