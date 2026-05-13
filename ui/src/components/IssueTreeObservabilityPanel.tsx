import type {
  IssueTreeObservability,
  IssueTreeObservabilitySeverity,
  IssueTreeObservabilityTimelineEntry,
} from "@paperclipai/shared";
import { Activity, AlertTriangle, GitBranch, TimerReset } from "lucide-react";
import { cn, formatDurationMs, formatTokens, relativeTime } from "../lib/utils";

export interface IssueTreeObservabilityPanelProps {
  observability?: IssueTreeObservability | null;
  isLoading?: boolean;
  isError?: boolean;
}

function dateMs(value: Date | string | null | undefined) {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function formatMoney(cents: number) {
  return (cents / 100).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  });
}

function formatRelative(value: Date | string | null | undefined) {
  if (!dateMs(value) || value === null || value === undefined) return "unknown";
  return relativeTime(value);
}

function safeText(value: string | null | undefined, max = 180) {
  if (!value) return null;
  const redacted = value
    .replace(/Bearer\s+[A-Za-z0-9._:-]+/gi, "Bearer [REDACTED]")
    .replace(/(authorization|api[_-]?key|token|password|secret)(\s*[:=]\s*)(["']?)[^\s"',;)]+/gi, "$1$2$3[REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/gi, "[REDACTED]")
    .replace(/bot\d+:[A-Za-z0-9_-]+/gi, "bot[REDACTED]");
  return redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted;
}

function severityTone(severity: IssueTreeObservabilitySeverity) {
  switch (severity) {
    case "success":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "warning":
      return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "error":
      return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300";
    default:
      return "border-border bg-background text-muted-foreground";
  }
}

function timelineEntryLabel(entry: IssueTreeObservabilityTimelineEntry) {
  const issueLabel = entry.issueIdentifier ?? entry.issueTitle;
  return `${entry.label} · ${issueLabel}`;
}

export function IssueTreeObservabilityPanel({
  observability,
  isLoading = false,
  isError = false,
}: IssueTreeObservabilityPanelProps) {
  if (isLoading && !observability) {
    return (
      <section data-testid="issue-tree-observability-panel" className="space-y-3 rounded-lg border border-border bg-card/40 p-3">
        <div className="h-4 w-44 animate-pulse rounded bg-muted" />
        <div className="grid gap-2 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="h-14 animate-pulse rounded-md bg-muted" />
          ))}
        </div>
      </section>
    );
  }

  if (isError) {
    return (
      <section data-testid="issue-tree-observability-panel" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
        Tree observability is unavailable right now.
      </section>
    );
  }

  if (!observability) return null;

  const { summary } = observability;
  const hasRuntime = summary.runtimeMs > 0;
  const hasCost = summary.costCents > 0 || summary.inputTokens > 0 || summary.outputTokens > 0 || summary.cachedInputTokens > 0;
  const topNodes = [...observability.nodes]
    .sort((a, b) => a.depth - b.depth || dateMs(b.lastActivityAt) - dateMs(a.lastActivityAt) || a.title.localeCompare(b.title))
    .slice(0, 8);
  const timeline = observability.timeline.slice(0, 8);

  return (
    <section data-testid="issue-tree-observability-panel" className="space-y-4 rounded-lg border border-border bg-card/40 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <GitBranch className="h-4 w-4 text-primary" />
            Tree observability
          </h3>
          <p className="text-xs text-muted-foreground">
            Cross-issue timeline, run status, cost, runtime, and error pressure for this issue tree.
          </p>
        </div>
        <span className="rounded-full border border-border bg-background px-2 py-0.5 text-xs text-muted-foreground">
          updated {formatRelative(summary.lastActivityAt ?? observability.generatedAt)}
        </span>
      </div>

      <div className="grid gap-2 text-sm sm:grid-cols-4">
        <div className="rounded-md border border-border/70 bg-background/70 px-3 py-2">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Issues</div>
          <div className="mt-1 text-foreground">
            {summary.issueCount} total · {summary.activeIssueCount} active
          </div>
          {summary.blockedIssueCount > 0 ? (
            <div className="mt-0.5 text-xs text-amber-600 dark:text-amber-300">{summary.blockedIssueCount} blocked</div>
          ) : null}
        </div>
        <div className="rounded-md border border-border/70 bg-background/70 px-3 py-2">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Runs</div>
          <div className="mt-1 text-foreground">
            {summary.runCount} total · {summary.activeRunCount} active
          </div>
          {summary.failedRunCount > 0 ? (
            <div className="mt-0.5 text-xs text-red-600 dark:text-red-300">{summary.failedRunCount} failed</div>
          ) : null}
        </div>
        <div className="rounded-md border border-border/70 bg-background/70 px-3 py-2">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Cost / tokens</div>
          <div className="mt-1 text-foreground">{hasCost ? formatMoney(summary.costCents) : "No spend"}</div>
          {hasCost ? (
            <div className="mt-0.5 text-xs text-muted-foreground">
              Tokens {formatTokens(summary.inputTokens + summary.outputTokens)}
              {summary.cachedInputTokens > 0 ? ` · cached ${formatTokens(summary.cachedInputTokens)}` : ""}
            </div>
          ) : null}
        </div>
        <div className="rounded-md border border-border/70 bg-background/70 px-3 py-2">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Runtime / errors</div>
          <div className="mt-1 flex items-center gap-1 text-foreground">
            <TimerReset className="h-3.5 w-3.5 text-muted-foreground" />
            {hasRuntime ? formatDurationMs(summary.runtimeMs) : "No runtime"}
          </div>
          {summary.errorEventCount > 0 ? (
            <div className="mt-0.5 text-xs text-red-600 dark:text-red-300">{summary.errorEventCount} error events</div>
          ) : null}
        </div>
      </div>

      {topNodes.length > 0 ? (
        <div className="space-y-2">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Issue tree health</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {topNodes.map((node) => (
              <div key={node.id} className="rounded-md border border-border/70 bg-background/70 px-3 py-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-muted-foreground">{node.identifier ?? node.id.slice(0, 8)}</span>
                  <span className="truncate font-medium text-foreground">{node.title}</span>
                  <span className="ml-auto rounded-full border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    {node.status}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
                  <span>depth {node.depth}</span>
                  <span>{node.runCount} runs</span>
                  {node.failedRunCount > 0 ? <span className="text-red-600 dark:text-red-300">{node.failedRunCount} failed</span> : null}
                  {node.errorEventCount > 0 ? <span className="text-red-600 dark:text-red-300">{node.errorEventCount} errors</span> : null}
                  {node.costCents > 0 ? <span>{formatMoney(node.costCents)}</span> : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="space-y-2">
        <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <Activity className="h-3.5 w-3.5" />
          Tree timeline
        </div>
        {timeline.length > 0 ? (
          <div className="space-y-2">
            {timeline.map((entry) => {
              const message = safeText(entry.message);
              return (
                <div key={entry.id} className={cn("rounded-md border px-3 py-2 text-xs", severityTone(entry.severity))}>
                  <div className="flex flex-wrap items-center gap-2">
                    {entry.severity === "error" ? <AlertTriangle className="h-3.5 w-3.5" /> : null}
                    <span className="font-medium">{timelineEntryLabel(entry)}</span>
                    <span className="rounded-full border border-current/20 px-1.5 py-0.5 uppercase tracking-wide">{entry.kind}</span>
                    {entry.costCents !== null ? <span>{formatMoney(entry.costCents)}</span> : null}
                    <span className="ml-auto text-[11px] opacity-80">{formatRelative(entry.timestamp)}</span>
                  </div>
                  {message ? <div className="mt-1 break-words opacity-90">{message}</div> : null}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="rounded-md border border-border/70 bg-background/70 px-3 py-2 text-xs text-muted-foreground">
            No tree timeline events yet.
          </div>
        )}
      </div>
    </section>
  );
}
