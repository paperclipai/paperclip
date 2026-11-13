import type { McpAppCallToolResult, McpAppModelContext, McpAppViewDetail, McpAppViewSummary } from "@paperclipai/shared";
import { api } from "./client";

/** MCP Apps views recorded for a task's tool calls. */
export const mcpAppsApi = {
  list: (issueId: string) =>
    api.get<McpAppViewSummary[]>(`/issues/${issueId}/mcp-app-views`, { cache: "no-store" }),
  detail: (issueId: string, viewId: string, signal?: AbortSignal) =>
    api.get<McpAppViewDetail>(`/issues/${issueId}/mcp-app-views/${viewId}`, { cache: "no-store", signal }),
  callTool: (issueId: string, viewId: string, name: string, args: Record<string, unknown>) =>
    api.post<McpAppCallToolResult>(`/issues/${issueId}/mcp-app-views/${viewId}/tool-calls`, { name, arguments: args }),
  /** Stores the view's latest context for the task's next run; null clears it. */
  updateModelContext: (issueId: string, viewId: string, context: McpAppModelContext | null) =>
    api.put<{ updated: boolean }>(`/issues/${issueId}/mcp-app-views/${viewId}/model-context`, context
      ? { ...(context.text ? { content: [{ type: "text", text: context.text }] } : {}), ...(context.structuredContent ? { structuredContent: context.structuredContent } : {}) }
      : {}),
  /** Records that the viewer sent a view's proposed message (sent with this client request id). */
  messageSent: (issueId: string, viewId: string, clientRequestId: string) =>
    api.post<{ commentId: string }>(`/issues/${issueId}/mcp-app-views/${viewId}/messages`, { clientRequestId }),
};
