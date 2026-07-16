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
