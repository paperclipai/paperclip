import type { QueryClient } from "@tanstack/react-query";

export function taskBrowsersQueryKey(issueId: string | undefined) {
  return ["task-browsers", issueId] as const;
}

// One queued follow-up per cached browser list, shared by every caller.
const queuedFollowUps = new WeakMap<object, Set<string>>();

/**
 * Refresh a task's browser list after browser activity on that task.
 *
 * The list stops polling while the live connection is open and no browser can
 * change state, so this activity is its refresh signal. A read already in
 * flight may predate the activity, and a refresh that joined it could keep an
 * older empty list. In that case one follow-up read runs after it settles.
 * Invalidation also marks a list that no view observes as stale, so a view
 * that opens the task again reads it.
 */
export function refreshTaskBrowsers(queryClient: QueryClient, issueId: string): void {
  refreshTaskBrowserList(queryClient, taskBrowsersQueryKey(issueId));
}

/**
 * Queue a follow-up for every browser list with a read in flight when the live
 * connection opens. Events missed while it was closed are not replayed, and
 * the connection-open reconcile can join a read that started before the
 * missed activity. Lists without a read in flight are left to that reconcile.
 */
export function refreshPendingTaskBrowserReads(queryClient: QueryClient): void {
  for (const query of queryClient.getQueryCache().findAll({ queryKey: ["task-browsers"] })) {
    if (query.state.fetchStatus === "fetching") refreshTaskBrowserList(queryClient, query.queryKey);
  }
}

function refreshTaskBrowserList(queryClient: QueryClient, queryKey: readonly unknown[]): void {
  const cache = queryClient.getQueryCache();
  const query = cache.find({ queryKey, exact: true });
  if (!query) return;
  const invalidate = () => queryClient.invalidateQueries({ queryKey, exact: true });
  const pending = query.state.fetchStatus === "fetching" ? query.promise : undefined;
  if (!pending) {
    void invalidate();
    return;
  }
  const queued = queuedFollowUps.get(cache) ?? new Set<string>();
  queuedFollowUps.set(cache, queued);
  const id = JSON.stringify(queryKey);
  if (queued.has(id)) return;
  queued.add(id);
  void pending.catch(() => undefined).then(() => {
    queued.delete(id);
    return invalidate();
  });
}
