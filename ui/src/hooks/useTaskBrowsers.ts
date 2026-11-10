import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskBrowser } from "@paperclipai/shared";
import { browserUseApi } from "@/api/browser-use";
import { retryTransientOnly } from "@/lib/query-client";
import { useCompanyLiveEvent, useHasCompanyLiveConnection } from "@/context/LiveUpdatesProvider";
export const TASK_BROWSERS_REFETCH_MS = 3000;

/**
 * Poll while the company live connection is closed, and while any browser can
 * still change state. With the connection open, every browser lifecycle step
 * (`browser.started`, `browser.ready`, `browser.run_finished`, `browser.closed`
 * and controls) logs task activity. `useTaskBrowsers` reads the list again on
 * that activity and on each new connection.
 */
export function taskBrowsersRefetchInterval(
  connected: boolean,
  state: { status: "pending" | "error" | "success"; data: TaskBrowser[] | undefined },
): number | false {
  if (!connected || state.status !== "success" || !Array.isArray(state.data)) return TASK_BROWSERS_REFETCH_MS;
  return state.data.some(browser => browser.status !== "closed" && browser.status !== "failed")
    ? TASK_BROWSERS_REFETCH_MS
    : false;
}

export function taskBrowsersQueryKey(issueId: string | undefined) {
  return ["task-browsers", issueId] as const;
}

/**
 * Read the browser list again after any read already in flight. A refresh that
 * only joined an older read could keep a list from before the browser started,
 * and an empty list stops polling while connected.
 */
function refreshTaskBrowsers(queryClient: QueryClient, issueId: string, owner: { active: boolean }) {
  const queryKey = taskBrowsersQueryKey(issueId);
  const query = queryClient.getQueryCache().find({ queryKey, exact: true });
  const pending = query?.state.fetchStatus === "fetching" ? query.promise : undefined;
  const refresh = () => owner.active
    ? queryClient.invalidateQueries({ queryKey, exact: true }, { cancelRefetch: false })
    : undefined;
  void (pending ? pending.catch(() => undefined).then(refresh) : refresh());
}

export function useTaskBrowsers(issueId?: string, companyId?: string | null) {
  const connected = useHasCompanyLiveConnection(companyId);
  const queryClient = useQueryClient();
  const enabled = Boolean(issueId) && !issueId?.startsWith("chat:");
  const owner = useRef({ active: true });
  useEffect(() => {
    const current = { active: true };
    owner.current = current;
    return () => { current.active = false; };
  }, [issueId]);
  // Events while the connection was closed are not replayed. Polling stops on
  // an empty list once connected, so reconcile on each new connection.
  const wasConnected = useRef(connected);
  useEffect(() => {
    const opened = connected && !wasConnected.current;
    wasConnected.current = connected;
    if (opened && enabled && issueId) refreshTaskBrowsers(queryClient, issueId, owner.current);
  }, [connected, enabled, issueId, queryClient]);
  useCompanyLiveEvent((event) => {
    if (!enabled || !issueId || event.type !== "activity.logged") return;
    const payload = event.payload ?? {};
    if (payload.entityType !== "issue" || payload.entityId !== issueId) return;
    if (typeof payload.action !== "string" || !payload.action.startsWith("browser.")) return;
    refreshTaskBrowsers(queryClient, issueId, owner.current);
  });
  return useQuery({
    queryKey: taskBrowsersQueryKey(issueId),
    queryFn: () => browserUseApi.list(issueId!),
    enabled,
    refetchInterval: (query) => taskBrowsersRefetchInterval(connected, query.state),
    // The 3s poll cadence already retries reads; stacking the shared backoff
    // inside a tick only adds duplicate requests. The next tick refetches anyway.

    retry: retryTransientOnly(0),
  });
}

/** Queue every arrival; claim it only after the panel acknowledges selection. */
export function useBrowserArrivals(accountScope: string, issueId: string | undefined, browsers?: TaskBrowser[]) {
  const scope = JSON.stringify([accountScope, issueId]);
  const [request, setRequest] = useState<{ scope: string; browserId: string; sessionId?: string } | null>(null);
  const acknowledged = useRef(new Set<string>());
  const key = useCallback((sessionId: string) =>
    `paperclip:browser-arrival:v2:${accountScope}:${issueId}:${sessionId}`, [accountScope, issueId]);
  const current = request?.scope === scope ? request : null;
  useEffect(() => {
    if (!issueId || current) return;
    const next = browsers?.find(browser => {
      if (browser.status !== "running" && browser.status !== "idle") return false;
      const storageKey = key(browser.sessionId);
      if (acknowledged.current.has(storageKey)) return false;
      try { return !sessionStorage.getItem(storageKey); } catch { return true; }
    });
    if (next) setRequest({ scope, browserId: next.id, sessionId: next.sessionId });
  }, [browsers, current, issueId, key, scope]);
  const acknowledgeBrowserOpened = useCallback(() => {
    if (!current) return;
    if (current.sessionId) {
      const storageKey = key(current.sessionId);
      acknowledged.current.add(storageKey);
      try { sessionStorage.setItem(storageKey, "1"); } catch { /* In-memory acknowledgement still prevents focus stealing. */ }
    }
    setRequest(previous => previous === current ? null : previous);
  }, [current, key]);
  const openBrowser = useCallback((browserId: string) => {
    setRequest({ scope, browserId, sessionId: browsers?.find(b => b.id === browserId)?.sessionId });
  }, [browsers, scope]);
  return { openBrowserId: current?.browserId ?? null, openBrowser, acknowledgeBrowserOpened };
}
