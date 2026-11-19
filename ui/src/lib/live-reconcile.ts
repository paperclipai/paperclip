import type { Query, QueryClient, QueryKey } from "@tanstack/react-query";
import { queryKeys } from "./queryKeys";

/**
 * Instance- and person-level reads that no company live event updates.
 *
 * `LiveUpdatesProvider` closes its socket while the tab is hidden, and events
 * are not replayed, so it invalidates every active query when the socket opens
 * and when the tab returns. That reconcile recovers missed events. These reads
 * have no events to miss: they change only through this person's own
 * mutations, which invalidate them directly, or through an instance setting.
 * Reconciling them only adds requests to every tab return.
 *
 * Session, health, board access and the company list are not here. They
 * detect sign-out, reconnects and company changes, and keep the reconcile.
 */
export const LIVE_EVENT_FREE_QUERY_KEYS: readonly QueryKey[] = [
  queryKeys.instance.settings,
  queryKeys.instance.generalSettings,
  queryKeys.instance.experimentalSettings,
  queryKeys.plugins.uiContributions,
  ["workspace-preferences"],
  ["sidebar-preferences"],
];

/** How long the reads above stay fresh. A window-focus refetch runs at most this often. */
export const LIVE_EVENT_FREE_STALE_TIME_MS = 5 * 60_000;

function startsWith(key: QueryKey, prefix: QueryKey) {
  return prefix.length <= key.length && prefix.every((part, index) => part === key[index]);
}

/** Whether a socket reconcile should refresh this query. */
export function isLiveReconciledQuery(query: Pick<Query, "queryKey">) {
  return !LIVE_EVENT_FREE_QUERY_KEYS.some((prefix) => startsWith(query.queryKey, prefix));
}

/** Gives the event-free reads a longer stale time, so tab focus does not refetch them each time. */
export function applyLiveEventFreeQueryDefaults(client: QueryClient) {
  for (const queryKey of LIVE_EVENT_FREE_QUERY_KEYS) {
    client.setQueryDefaults(queryKey, { staleTime: LIVE_EVENT_FREE_STALE_TIME_MS });
  }
}
