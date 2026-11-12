import type { McpAppViewSummary } from "@paperclipai/shared";
import { useMcpAppIssueId, useMcpAppViewsForRun } from "./McpAppIssueContext";
import { McpAppView } from "./McpAppView";

/** "DisplayMeetings" → "Display meetings". */
export function mcpAppToolDisplayName(toolName: string): string {
  const words = toolName.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").trim().toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : toolName;
}

function McpAppRunView({ issueId, view }: { issueId: string; view: McpAppViewSummary }) {
  const displayName = mcpAppToolDisplayName(view.upstreamToolName);
  return (
    <section data-testid="mcp-app-turn-view" aria-label={`${view.applicationName}: ${displayName}`} className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-baseline gap-2 text-xs">
        <span className="text-muted-foreground">Widget from {view.applicationName}</span>
        <span className="truncate font-medium text-foreground">{displayName}</span>
      </div>
      <McpAppView issueId={issueId} view={view} displayName={displayName} />
    </section>
  );
}

/**
 * A run's MCP Apps views, shown with the agent's reply rather than inside the
 * folded tool history, as other MCP Apps hosts do. Keyed by run, so settled
 * history needs no transcript to show them.
 */
export function McpAppTurnViews({ runId }: { runId: string | null | undefined }) {
  // Outside a task chat (or before a run exists) there is nothing to load.
  const issueId = useMcpAppIssueId();
  return issueId && runId ? <RunViews runId={runId} /> : null;
}

function RunViews({ runId }: { runId: string }) {
  const { issueId, views } = useMcpAppViewsForRun(runId);
  if (!issueId || views.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-6 py-4" data-testid="mcp-app-turn-views">
      {views.map((view) => <McpAppRunView key={view.id} issueId={issueId} view={view} />)}
    </div>
  );
}
