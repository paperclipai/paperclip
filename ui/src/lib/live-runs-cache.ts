import type { LiveRunForIssue } from "../api/heartbeats";

/**
 * Pure cache operations for the company `liveRuns` list so run-lifecycle
 * websocket events can patch it in place instead of invalidating it and
 * triggering a full HTTP refetch. The company live-runs list is observed on
 * almost every page (the sidebar), so its refetch is the most ambient source of
 * live-update churn — event-sourcing it removes that entirely for the common
 * cases (a run finishing, or a status change on a run already in the list).
 *
 * A genuinely new run can't be reconstructed from a status event alone (the
 * list item needs fields the event doesn't carry), so the caller falls back to
 * a single refetch for that case; and a reconnect reconciles any missed events.
 */

/** Remove a run from the list. Returns the same reference if it wasn't present. */
export function removeRunFromList(
  runs: LiveRunForIssue[] | undefined,
  runId: string,
): LiveRunForIssue[] | undefined {
  if (!runs) return runs;
  const next = runs.filter((run) => run.id !== runId);
  return next.length === runs.length ? runs : next;
}

/**
 * Mark a run terminal in place and keep it in the list. Scoped live-run lists
 * (for example the dashboard panel, which pads with recent runs via `minCount`)
 * show finished runs, so they patch the run instead of removing it. Returns the
 * same reference when nothing changed, so a redundant event does not re-render.
 */
export function markRunTerminalInList(
  runs: LiveRunForIssue[] | undefined,
  runId: string,
  status: string,
  finishedAt: string | null,
): LiveRunForIssue[] | undefined {
  if (!runs) return runs;
  let changed = false;
  const next = runs.map((run) => {
    if (run.id !== runId) return run;
    const nextFinishedAt = finishedAt ?? run.finishedAt ?? null;
    if (run.status === status && run.finishedAt === nextFinishedAt) return run;
    changed = true;
    return { ...run, status, finishedAt: nextFinishedAt };
  });
  return changed ? next : runs;
}

/**
 * Update a run's `status` in place. `present` reports whether the run was in the
 * list; when it wasn't, `next` is the original reference and the caller should
 * refetch to pick up the new run.
 */
export function patchRunStatusInList(
  runs: LiveRunForIssue[] | undefined,
  runId: string,
  status: string,
): { next: LiveRunForIssue[] | undefined; present: boolean } {
  if (!runs) return { next: runs, present: false };
  let present = false;
  let changed = false;
  const next = runs.map((run) => {
    if (run.id !== runId) return run;
    present = true;
    if (run.status === status) return run;
    changed = true;
    return { ...run, status };
  });
  // Preserve the original reference when nothing actually changed (run absent,
  // or its status already matched) so redundant events don't trigger re-renders.
  return { next: changed ? next : runs, present };
}

const LIVE_RUN_STATUSES = new Set(["queued", "running"]);
/** Server default for the company live-runs `limit` query param. */
const SERVER_DEFAULT_LIVE_RUNS_LIMIT = 50;

function createdAtMs(run: LiveRunForIssue) {
  return Date.parse(run.createdAt) || 0;
}

function isLiveRun(run: LiveRunForIssue) {
  return LIVE_RUN_STATUSES.has(run.status);
}

/**
 * The number of runs the server pads a scoped live-runs list up to. It mirrors
 * `min(minCount, limit)` in the company live-runs route. The dashboard panel
 * keys its list as `[...liveRuns(companyId), scope, { minRunCount, fetchLimit }]`.
 * A key without `minRunCount` (for example the Agents page) is not padded, so
 * the result is 0.
 */
export function scopedLiveRunsPadTarget(queryKey: readonly unknown[]): number {
  for (const part of queryKey) {
    if (!part || typeof part !== "object" || Array.isArray(part)) continue;
    const { minRunCount, fetchLimit } = part as { minRunCount?: unknown; fetchLimit?: unknown };
    if (typeof minRunCount !== "number" || minRunCount <= 0) continue;
    const limit =
      typeof fetchLimit === "number" && fetchLimit > 0 ? fetchLimit : SERVER_DEFAULT_LIVE_RUNS_LIMIT;
    return Math.min(minRunCount, limit);
  }
  return 0;
}

/**
 * Apply a terminal run event to a scoped live-runs list the same way the server
 * builds it. The server returns live (queued/running) runs first, and adds
 * recently finished runs after them only while the live count is below the
 * pad target. So:
 * - if the remaining live runs still fill the pad target, remove the run;
 * - otherwise keep it, mark it terminal, and move it into the finished section
 *   (newest `createdAt` first), so a finished card never sits ahead of a live one.
 * Returns the same reference when nothing changed.
 */
export function settleTerminalRunInScopedList(
  runs: LiveRunForIssue[] | undefined,
  runId: string,
  status: string,
  finishedAt: string | null,
  padTarget: number,
): LiveRunForIssue[] | undefined {
  if (!runs || !runs.some((run) => run.id === runId)) return runs;
  const marked = markRunTerminalInList(runs, runId, status, finishedAt) ?? runs;
  const live = marked.filter(isLiveRun);
  if (live.length >= padTarget) return removeRunFromList(runs, runId);
  const finished = marked
    .filter((run) => !isLiveRun(run))
    .sort((a, b) => createdAtMs(b) - createdAtMs(a));
  const next = [...live, ...finished];
  return next.every((run, i) => run === runs[i]) ? runs : next;
}
