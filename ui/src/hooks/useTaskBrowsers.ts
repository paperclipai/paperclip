import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskBrowser } from "@paperclipai/shared";
import { browserUseApi } from "@/api/browser-use";
export function useTaskBrowsers(issueId?: string) {
  return useQuery({
    queryKey: ["task-browsers", issueId],
    queryFn: () => browserUseApi.list(issueId!),
    enabled: Boolean(issueId),
    refetchInterval: 3000,
    retry: false,
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
