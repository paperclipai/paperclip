import { createContext, useContext, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
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

/**
 * The views a run recorded. A task's views load in one request, shared by
 * every reply of the task, and the list is indexed once by run.
 */
export function useMcpAppViewsForRun(runId: string | null | undefined): {
  issueId: string | null;
  views: McpAppViewSummary[];
} {
  const issueId = useMcpAppIssueId();
  const enabled = Boolean(issueId && runId);
  const { data } = useQuery({
    queryKey: queryKeys.mcpApps.views(issueId ?? ""),
    queryFn: () => mcpAppsApi.list(issueId!),
    enabled,
    staleTime: 30_000,
  });
  const views = enabled && data ? mcpAppViewIndexFor(data).forRun(runId!) : NO_VIEWS;
  return { issueId, views };
}
