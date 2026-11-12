import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { McpAppViewSummary } from "@paperclipai/shared";
import { mcpAppsApi } from "@/api/mcpApps";
import { queryKeys } from "@/lib/queryKeys";
import { matchMcpAppView } from "./mcp-app-matching";

/** The task whose chat is showing, so tool rows can find their MCP Apps views. */
const McpAppIssueContext = createContext<string | null>(null);

export function McpAppIssueProvider({ issueId, children }: { issueId: string | null | undefined; children: ReactNode }) {
  return <McpAppIssueContext.Provider value={issueId ?? null}>{children}</McpAppIssueContext.Provider>;
}

export function useMcpAppIssueId(): string | null {
  return useContext(McpAppIssueContext);
}

/** Only rows that came through an MCP connection can have a view. */
function mayHaveView(rawName: string | undefined): boolean {
  return Boolean(rawName && /mcp/i.test(rawName));
}

/**
 * The view recorded for a completed tool row, if its tool declares one. The
 * task's views load once (one request per task) and only when the chat shows
 * an MCP tool row.
 */
export function useMcpAppViewForTool(item: { id: string; rawName?: string; input?: unknown; status: string }): {
  issueId: string | null;
  view: McpAppViewSummary | null;
} {
  const issueId = useMcpAppIssueId();
  const enabled = Boolean(issueId) && item.status === "completed" && mayHaveView(item.rawName);
  const { data, refetch, isFetchedAfterMount } = useQuery({
    queryKey: queryKeys.mcpApps.views(issueId ?? ""),
    queryFn: () => mcpAppsApi.list(issueId!),
    enabled,
    staleTime: 60_000,
  });
  const view = enabled && data ? matchMcpAppView(item, data) : null;
  // A row that completes while the chat is open can be newer than the cached
  // list; look once more before concluding the call has no view.
  const refetched = useRef(false);
  useEffect(() => {
    if (!enabled || !data || view || refetched.current || isFetchedAfterMount) return;
    refetched.current = true;
    void refetch();
  }, [enabled, data, view, isFetchedAfterMount, refetch]);
  return { issueId, view };
}
