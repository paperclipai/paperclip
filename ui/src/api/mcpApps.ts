import type { McpAppCallToolResult, McpAppViewDetail, McpAppViewSummary } from "@paperclipai/shared";
import { api } from "./client";

/** MCP Apps views recorded for a task's tool calls. */
export const mcpAppsApi = {
  list: (issueId: string) =>
    api.get<McpAppViewSummary[]>(`/issues/${issueId}/mcp-app-views`, { cache: "no-store" }),
  detail: (issueId: string, viewId: string, signal?: AbortSignal) =>
    api.get<McpAppViewDetail>(`/issues/${issueId}/mcp-app-views/${viewId}`, { cache: "no-store", signal }),
  callTool: (issueId: string, viewId: string, name: string, args: Record<string, unknown>) =>
    api.post<McpAppCallToolResult>(`/issues/${issueId}/mcp-app-views/${viewId}/tool-calls`, { name, arguments: args }),
};
