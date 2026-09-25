/**
 * Query-parameter clamps for the run-listing routes.
 *
 * A run list endpoint with no default limit returns every run the company has
 * ever recorded — for a long-lived agent that is tens of thousands of rows,
 * each with jsonb projections evaluated per row. Every such route reads its
 * row budget through `readRunQueryInt`, so "unbounded" is not reachable by
 * omitting a parameter.
 */

/** Rows returned by `GET /companies/:id/heartbeat-runs` when no limit is given. */
export const HEARTBEAT_RUN_LIST_DEFAULT_LIMIT = 200;
/** Ceiling a caller may raise that list to. */
export const HEARTBEAT_RUN_LIST_MAX_LIMIT = 1000;

/**
 * Read a positive integer query parameter, clamped to `max`. A missing,
 * non-numeric or non-positive value falls back to `fallback`.
 */
export function readRunQueryInt(value: unknown, max: number, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed <= 0) return fallback;
  return Math.min(max, Math.trunc(parsed));
}
