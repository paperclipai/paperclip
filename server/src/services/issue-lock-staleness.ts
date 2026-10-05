/**
 * Statuses a heartbeat run can never leave. Re-exported from `issues.ts` for
 * every existing importer; defined here so the staleness predicate below stays
 * free of a service-level dependency.
 */
export const TERMINAL_HEARTBEAT_RUN_STATUSES = new Set([
  "succeeded",
  "interrupted",
  "failed",
  "cancelled",
  "timed_out",
]);

/**
 * How long a `queued` run may sit unstarted before its issue locks stop being
 * a real claim. A queued run needs no process, so the only thing that can still
 * start it is its dispatcher; a run that outlives the window without starting
 * is a lost wake, not pending work.
 */
export const STALE_QUEUED_RUN_GRACE_MS = 15 * 60 * 1000;

export interface HeartbeatRunLockFacts {
  status: string;
  startedAt: Date | string | null;
  scheduledRetryAt: Date | string | null;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
}

const ms = (value: Date | string | null | undefined): number | null => {
  if (value == null) return null;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
};

/**
 * Whether the heartbeat run behind an issue's `checkoutRunId`/`executionRunId`
 * holds no live claim, so the lock columns can be cleared.
 *
 * Terminal and missing runs already qualify. A `queued` run that never started
 * qualifies once nothing can start it any more: either its armed retry is due
 * (past the grace window) or it has no retry armed at all. Anything else —
 * `running`, or a queued run that started — is still live work.
 *
 * The age anchor is the oldest of `createdAt`/`updatedAt`, clamped to `now`, so
 * a single future-dated timestamp (see AUT-5707) cannot pin a dead run's lock
 * forever, and a row whose every timestamp is future-dated stays conservatively
 * locked rather than being reaped on a bogus age.
 */
export function heartbeatRunLockIsStale(
  run: HeartbeatRunLockFacts | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!run) return true;
  if (TERMINAL_HEARTBEAT_RUN_STATUSES.has(run.status)) return true;
  if (run.status !== "queued") return false;
  if (ms(run.startedAt) != null) return false;

  const nowMs = now.getTime();
  const retryAt = ms(run.scheduledRetryAt);
  if (retryAt != null) return retryAt + STALE_QUEUED_RUN_GRACE_MS < nowMs;

  const anchors = [ms(run.createdAt), ms(run.updatedAt)].filter(
    (value): value is number => value != null,
  );
  if (anchors.length === 0) return false;
  const oldest = Math.min(...anchors, nowMs);
  return nowMs - oldest > STALE_QUEUED_RUN_GRACE_MS;
}