/**
 * The most recent agent runs on the work under a responsibility (experimental,
 * `enableResponsibilities`): runs on its tasks (filed directly or through a
 * linked project) and on the tasks its routines created, newest first.
 */

/** How many runs the read returns without `limit`. */
export const RESPONSIBILITY_RECENT_RUNS_DEFAULT_LIMIT = 8;
/** The most runs one read returns. */
export const RESPONSIBILITY_RECENT_RUNS_MAX_LIMIT = 20;

export interface ResponsibilityRecentRun {
  /** The heartbeat run's id. */
  id: string;
  agentId: string;
  /** queued, running, succeeded, failed, cancelled or timed_out. */
  status: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** The task it ran on. */
  issue: { id: string; identifier: string | null; title: string };
  /** The routine whose run created that task, when it came from one under this responsibility. */
  routineId: string | null;
}

/** `GET /api/responsibilities/:id/runs`. */
export interface ResponsibilityRecentRuns {
  responsibilityId: string;
  /** Newest first, at most `limit`. */
  runs: ResponsibilityRecentRun[];
  limit: number;
}
