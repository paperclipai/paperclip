import { useEffect, useRef, useState, type ReactNode } from "react";
import type { McpAppViewSummary } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { useMcpAppIssueId, useMcpAppViewsForRun, type McpAppViewsFreshness } from "./McpAppIssueContext";
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
      <NearViewport placeholderLabel={`${view.applicationName}: ${displayName}`}>
        <McpAppView issueId={issueId} view={view} displayName={displayName} />
      </NearViewport>
    </section>
  );
}

/** Views start loading this far before they scroll into view. */
const NEAR_VIEWPORT_MARGIN = "600px";
/** Views shown per run before "Show N more". */
export const MCP_APP_VIEWS_PER_RUN = 5;

/**
 * Mounts its children (and so fetches the view document, up to 4 MB, and starts
 * its iframe) only once the placeholder nears the viewport. A long chat with
 * many recorded views pays only for the ones the reader reaches.
 */
function NearViewport({ children, placeholderLabel }: { children: ReactNode; placeholderLabel: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (near || !ref.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setNear(true);
    }, { rootMargin: NEAR_VIEWPORT_MARGIN });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [near]);
  if (near) return <>{children}</>;
  return <div ref={ref} role="status" aria-label={`${placeholderLabel} (not loaded yet)`} data-testid="mcp-app-view-placeholder" className="h-24 rounded-lg border border-border bg-muted/30" />;
}

/**
 * A run's MCP Apps views, shown with the agent's reply rather than inside the
 * folded tool history, as other MCP Apps hosts do. Keyed by run, so settled
 * history needs no transcript to show them.
 */
export function McpAppTurnViews({ runId, ...freshness }: { runId: string | null | undefined } & McpAppViewsFreshness) {
  // Outside a task chat (or before a run exists) there is nothing to load.
  const issueId = useMcpAppIssueId();
  return issueId && runId ? <RunViews runId={runId} {...freshness} /> : null;
}

/**
 * Refresh key for a live run: its completed MCP tool calls and its status.
 * Tool rows may be nested in activity phases.
 */
export function mcpAppRunRefreshKey(items: readonly unknown[], status?: string | null): string {
  let completed = 0;
  const visit = (list: readonly unknown[]) => {
    for (const entry of list) {
      if (!entry || typeof entry !== "object") continue;
      const item = entry as { kind?: string; status?: string; rawName?: string; name?: string; items?: unknown };
      if (item.kind === "tool" && item.status === "completed" && /mcp/i.test(item.rawName ?? item.name ?? "")) completed += 1;
      else if (Array.isArray(item.items)) visit(item.items);
    }
  };
  visit(items);
  return `${completed}:${status ?? ""}`;
}

function RunViews({ runId, ...freshness }: { runId: string } & McpAppViewsFreshness) {
  const { issueId, views } = useMcpAppViewsForRun(runId, freshness);
  const [showAll, setShowAll] = useState(false);
  if (!issueId || views.length === 0) return null;
  const shown = showAll ? views : views.slice(0, MCP_APP_VIEWS_PER_RUN);
  const hidden = views.length - shown.length;
  return (
    <div className="flex min-w-0 flex-col gap-6 py-4" data-testid="mcp-app-turn-views">
      {shown.map((view) => <McpAppRunView key={view.id} issueId={issueId} view={view} />)}
      {hidden > 0 ? (
        <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => setShowAll(true)}>
          Show {hidden} more
        </Button>
      ) : null}
    </div>
  );
}
