import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import type { McpAppCallToolResult, McpAppViewDetail, McpAppViewSummary } from "@paperclipai/shared";
import { mcpAppsApi } from "@/api/mcpApps";
import { ApiError } from "@/api/client";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { McpAppFrame } from "./McpAppFrame";
import { mcpAppNavigationGuardSupported } from "./mcp-app-host";

const UNSUPPORTED_BROWSER_MESSAGE = "This browser can't show this app's widget safely. The tool result is still in the activity.";

export interface McpAppViewContentProps {
  detail: McpAppViewDetail | undefined;
  status: "loading" | "error" | "ready";
  errorMessage?: string | null;
  callTool: (name: string, args: Record<string, unknown>) => Promise<McpAppCallToolResult>;
  displayName: string;
}

/** Presentational shell, shared by the live view and its stories. */
export function McpAppViewContent({ detail, status, errorMessage, callTool, displayName }: McpAppViewContentProps) {
  const unsupported = !mcpAppNavigationGuardSupported();
  if (status === "error" || unsupported) {
    return (
      <div role="status" data-testid="mcp-app-view-error" className="ml-1.5 mt-0.5 border-l-2 border-border py-1 pl-2.5 text-(length:--text-micro) text-muted-foreground">
        {unsupported ? UNSUPPORTED_BROWSER_MESSAGE : errorMessage ?? "This app's view could not be shown."}
      </div>
    );
  }
  return (
    <div
      data-testid="mcp-app-view"
      className={cn(
        "min-w-0 max-w-full overflow-hidden",
        detail?.resource.prefersBorder !== false && "rounded-lg border border-border bg-card p-3",
      )}
    >
      {status === "loading" || !detail ? (
        <div role="status" aria-label={`Loading ${detail?.applicationName ?? "app"} view`} className="h-24 animate-pulse bg-muted/40" />
      ) : (
        <McpAppFrame
          title={`${detail.applicationName}: ${displayName}`}
          viewId={detail.id}
          toolName={detail.upstreamToolName}
          resource={detail.resource}
          toolInput={detail.toolInput}
          toolResult={detail.toolResult}
          callTool={callTool}
        />
      )}
    </div>
  );
}

function viewErrorMessage(error: unknown, applicationName: string): string {
  if (error instanceof ApiError && error.status === 404) return `This ${applicationName} view is no longer available.`;
  return `${applicationName} could not show this view. The tool result is still in the row above.`;
}

/** Loads a recorded view and renders it under its tool row. */
export function McpAppView({ issueId, view, displayName }: { issueId: string; view: McpAppViewSummary; displayName: string }) {
  const query = useQuery({
    queryKey: queryKeys.mcpApps.detail(issueId, view.id),
    queryFn: ({ signal }) => mcpAppsApi.detail(issueId, view.id, signal),
    // No document download where the view cannot be shown safely.
    enabled: mcpAppNavigationGuardSupported(),
    staleTime: 5 * 60_000,
    retry: 1,
  });
  const callTool = useCallback(
    (name: string, args: Record<string, unknown>) => mcpAppsApi.callTool(issueId, view.id, name, args),
    [issueId, view.id],
  );
  return (
    <McpAppViewContent
      detail={query.data}
      status={query.data ? "ready" : query.error ? "error" : "loading"}
      errorMessage={!query.data && query.error ? viewErrorMessage(query.error, view.applicationName) : null}
      callTool={callTool}
      displayName={displayName}
    />
  );
}
