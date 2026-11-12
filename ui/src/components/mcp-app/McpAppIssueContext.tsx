import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { McpAppViewSummary } from "@paperclipai/shared";
import { mcpAppsApi } from "@/api/mcpApps";
import { queryKeys } from "@/lib/queryKeys";
import { mcpAppViewIndexFor } from "./mcp-app-matching";

/** The task whose chat is showing, so a run's replies can find their MCP Apps views. */
const McpAppIssueContext = createContext<string | null>(null);

export function McpAppIssueProvider({ issueId, children }: { issueId: string | null | undefined; children: ReactNode }) {
  return <McpAppIssueContext.Provider value={issueId ?? null}>{children}</McpAppIssueContext.Provider>;
}

export function useMcpAppIssueId(): string | null {
  return useContext(McpAppIssueContext);
}

const NO_VIEWS: McpAppViewSummary[] = [];

export interface McpAppViewsFreshness {
  /**
   * Changes when the run may have recorded a new view: for a live run, the
   * count of its completed MCP tool calls and its status. A change refreshes
   * the task's list once.
   */
  refreshKey?: string;
  /** The reply's time (ms). A list loaded before it may miss the run's views, so it is refreshed once. */
  notBeforeMs?: number;
}

/**
 * The views a run recorded. A task's views load in one request, shared by
 * every reply of the task, and the list is indexed once by run.
 */
export function useMcpAppViewsForRun(runId: string | null | undefined, freshness: McpAppViewsFreshness = {}): {
  issueId: string | null;
  views: McpAppViewSummary[];
} {
  const issueId = useMcpAppIssueId();
  const queryClient = useQueryClient();
  const enabled = Boolean(issueId && runId);
  const queryKey = queryKeys.mcpApps.views(issueId ?? "");
  const { data, dataUpdatedAt, isFetching } = useQuery({
    queryKey,
    queryFn: () => mcpAppsApi.list(issueId!),
    enabled,
    staleTime: 30_000,
  });

  // A run's new tool call can record a view after the list loaded.
  const lastRefreshKey = useRef(freshness.refreshKey);
  useEffect(() => {
    if (!enabled || freshness.refreshKey === undefined || freshness.refreshKey === lastRefreshKey.current) return;
    lastRefreshKey.current = freshness.refreshKey;
    void queryClient.invalidateQueries({ queryKey, exact: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- queryKey is derived from issueId
  }, [enabled, freshness.refreshKey, issueId, queryClient]);

  // A settled reply newer than the loaded list: look once more.
  const refreshedForReply = useRef(false);
  const notBeforeMs = freshness.notBeforeMs;
  useEffect(() => {
    if (!enabled || refreshedForReply.current || !data || isFetching) return;
    if (notBeforeMs === undefined || !Number.isFinite(notBeforeMs) || dataUpdatedAt >= notBeforeMs) return;
    refreshedForReply.current = true;
    void queryClient.invalidateQueries({ queryKey, exact: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- queryKey is derived from issueId
  }, [enabled, data, dataUpdatedAt, isFetching, notBeforeMs, issueId, queryClient]);

  const views = enabled && data ? mcpAppViewIndexFor(data).forRun(runId!) : NO_VIEWS;
  return { issueId, views };
}
