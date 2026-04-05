import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { heartbeatsApi } from "../../api/heartbeats";
import { queryKeys } from "../../lib/queryKeys";
import { formatTokens, cn } from "../../lib/utils";
import { runMetrics, runStatusIcons } from "./agent-detail-utils";
import { StatusBadge } from "../StatusBadge";
import {
  Clock,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  DollarSign,
} from "lucide-react";
import type { HeartbeatRun, HeartbeatRunEvent } from "@ironworksai/shared";

/* ── Helpers ── */

function durationLabel(startMs: number, endMs: number): string {
  const diffMs = endMs - startMs;
  if (diffMs < 1000) return `${diffMs}ms`;
  if (diffMs < 60_000) return `${(diffMs / 1000).toFixed(1)}s`;
  const mins = Math.floor(diffMs / 60_000);
  const secs = Math.round((diffMs % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

function formatTimestamp(date: Date | string): string {
  const d = new Date(date);
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

const EVENT_TYPE_COLORS: Record<string, string> = {
  tool_call: "border-l-blue-500",
  tool_result: "border-l-blue-400",
  llm_request: "border-l-violet-500",
  llm_response: "border-l-violet-400",
  error: "border-l-red-500",
  system: "border-l-gray-400",
};

const EVENT_TYPE_LABELS: Record<string, string> = {
  tool_call: "Tool Call",
  tool_result: "Tool Result",
  llm_request: "LLM Request",
  llm_response: "LLM Response",
  error: "Error",
  system: "System",
  message: "Message",
  completion: "Completion",
};

/* ── Token usage breakdown ── */

function TokenUsageBreakdown({ run }: { run: HeartbeatRun }) {
  const metrics = runMetrics(run);
  if (metrics.totalTokens === 0 && metrics.cost === 0) return null;

  const inputPct =
    metrics.totalTokens > 0
      ? Math.round((metrics.input / metrics.totalTokens) * 100)
      : 0;
  const outputPct = 100 - inputPct;

  return (
    <div className="border border-border rounded-lg p-4 space-y-3">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Token Usage
      </h4>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 tabular-nums text-sm">
        <div>
          <span className="text-xs text-muted-foreground block">Input</span>
          <span className="font-semibold">{formatTokens(metrics.input)}</span>
        </div>
        <div>
          <span className="text-xs text-muted-foreground block">Output</span>
          <span className="font-semibold">{formatTokens(metrics.output)}</span>
        </div>
        {metrics.cached > 0 && (
          <div>
            <span className="text-xs text-muted-foreground block">Cached</span>
            <span className="font-semibold">{formatTokens(metrics.cached)}</span>
          </div>
        )}
        <div>
          <span className="text-xs text-muted-foreground block flex items-center gap-1">
            <DollarSign className="h-3 w-3" /> Cost
          </span>
          <span className="font-semibold">
            {metrics.cost > 0 ? `$${metrics.cost.toFixed(4)}` : "-"}
          </span>
        </div>
      </div>
      {metrics.totalTokens > 0 && (
        <div className="space-y-1">
          <div className="flex h-2 rounded-full overflow-hidden bg-muted">
            <div
              className="bg-blue-500 transition-[width]"
              style={{ width: `${inputPct}%` }}
              title={`Input: ${inputPct}%`}
            />
            <div
              className="bg-violet-500 transition-[width]"
              style={{ width: `${outputPct}%` }}
              title={`Output: ${outputPct}%`}
            />
          </div>
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-full bg-blue-500" /> Input {inputPct}%
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-full bg-violet-500" /> Output {outputPct}%
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Error stack trace viewer ── */

function ErrorStackTrace({ run }: { run: HeartbeatRun }) {
  if (!run.error) return null;

  return (
    <div className="border border-red-500/30 bg-red-500/5 rounded-lg p-4 space-y-2">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-red-500 shrink-0" />
        <h4 className="text-xs font-semibold uppercase tracking-wide text-red-500">
          Error
        </h4>
        {run.errorCode && (
          <span className="text-[10px] font-mono text-red-400 bg-red-500/10 px-1.5 py-0.5 rounded">
            {run.errorCode}
          </span>
        )}
      </div>
      <pre className="text-xs font-mono text-red-400 whitespace-pre-wrap break-words bg-black/20 rounded p-3 overflow-x-auto max-h-64 overflow-y-auto">
        {run.error}
      </pre>
      {run.stderrExcerpt && run.stderrExcerpt !== run.error && (
        <details className="text-xs">
          <summary className="text-muted-foreground cursor-pointer hover:text-foreground">
            stderr excerpt
          </summary>
          <pre className="font-mono text-red-400/80 whitespace-pre-wrap break-words bg-black/10 rounded p-2 mt-1 overflow-x-auto max-h-48 overflow-y-auto">
            {run.stderrExcerpt}
          </pre>
        </details>
      )}
    </div>
  );
}

/* ── Cost per run display ── */

function CostPerRunDisplay({ run }: { run: HeartbeatRun }) {
  const metrics = runMetrics(run);
  if (metrics.cost <= 0) return null;

  const durationMs =
    run.startedAt && run.finishedAt
      ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()
      : null;

  return (
    <div className="flex items-center gap-4 text-xs tabular-nums">
      <span className="flex items-center gap-1">
        <DollarSign className="h-3 w-3 text-muted-foreground" />
        <span className="font-medium">${metrics.cost.toFixed(4)}</span>
      </span>
      {durationMs != null && durationMs > 0 && (
        <span className="text-muted-foreground">
          ${((metrics.cost / durationMs) * 60_000).toFixed(4)}/min
        </span>
      )}
    </div>
  );
}

/* ── Event timeline item ── */

function TimelineEvent({ event }: { event: HeartbeatRunEvent }) {
  const [expanded, setExpanded] = useState(false);
  const typeLabel = EVENT_TYPE_LABELS[event.eventType] ?? event.eventType;
  const borderColor = EVENT_TYPE_COLORS[event.eventType] ?? "border-l-gray-400";
  const isError = event.level === "error" || event.eventType === "error";
  const payload = event.payload;
  const hasPayload = payload && Object.keys(payload).length > 0;
  const toolName =
    payload && typeof payload.tool === "string" ? payload.tool : null;

  return (
    <div
      className={cn(
        "border-l-2 pl-3 py-1.5 group",
        borderColor,
        isError && "bg-red-500/5",
      )}
    >
      <div
        className={cn(
          "flex items-center gap-2 text-xs",
          hasPayload && "cursor-pointer",
        )}
        onClick={() => hasPayload && setExpanded((v) => !v)}
      >
        {hasPayload ? (
          expanded ? (
            <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
          )
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span className="text-muted-foreground font-mono shrink-0">
          {formatTimestamp(event.createdAt)}
        </span>
        <span
          className={cn(
            "font-medium",
            isError ? "text-red-500" : "text-foreground",
          )}
        >
          {typeLabel}
        </span>
        {toolName && (
          <span className="text-muted-foreground font-mono text-[10px] bg-muted px-1 py-0.5 rounded">
            {toolName}
          </span>
        )}
        {event.message && (
          <span className="text-muted-foreground truncate flex-1 min-w-0">
            {event.message.slice(0, 120)}
          </span>
        )}
      </div>
      {expanded && payload && (
        <pre className="mt-1 ml-5 text-[11px] font-mono text-muted-foreground bg-muted/50 rounded p-2 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap break-words">
          {JSON.stringify(payload, null, 2)}
        </pre>
      )}
    </div>
  );
}

/* ── Main trace timeline ── */

interface RunTraceTimelineProps {
  run: HeartbeatRun;
}

export function RunTraceTimeline({ run }: RunTraceTimelineProps) {
  const { data: events, isLoading } = useQuery({
    queryKey: [...queryKeys.runDetail(run.id), "events"],
    queryFn: () => heartbeatsApi.events(run.id, 0, 500),
    enabled: Boolean(run.id),
    staleTime: run.status === "running" ? 5_000 : 120_000,
  });

  const sortedEvents = useMemo(
    () =>
      events
        ? [...events].sort(
            (a, b) =>
              new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
          )
        : [],
    [events],
  );

  const duration =
    run.startedAt && run.finishedAt
      ? durationLabel(
          new Date(run.startedAt).getTime(),
          new Date(run.finishedAt).getTime(),
        )
      : run.startedAt
        ? durationLabel(new Date(run.startedAt).getTime(), Date.now())
        : null;

  const statusInfo = runStatusIcons[run.status] ?? {
    icon: Clock,
    color: "text-neutral-400",
  };
  const StatusIcon = statusInfo.icon;

  return (
    <div className="space-y-4">
      {/* Run header */}
      <div className="border border-border rounded-lg p-4 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <StatusIcon
            className={cn(
              "h-4 w-4",
              statusInfo.color,
              run.status === "running" && "animate-spin",
            )}
          />
          <StatusBadge status={run.status} />
          <span className="font-mono text-xs text-muted-foreground">
            {run.id.slice(0, 8)}
          </span>
          {duration && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground ml-auto">
              <Clock className="h-3 w-3" />
              {duration}
            </span>
          )}
        </div>
        <CostPerRunDisplay run={run} />
      </div>

      {/* Token usage */}
      <TokenUsageBreakdown run={run} />

      {/* Error stack trace */}
      <ErrorStackTrace run={run} />

      {/* Event timeline */}
      <div className="space-y-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Event Timeline ({sortedEvents.length})
        </h4>
        {isLoading ? (
          <div className="text-xs text-muted-foreground py-4 text-center">
            Loading events...
          </div>
        ) : sortedEvents.length === 0 ? (
          <div className="text-xs text-muted-foreground py-4 text-center">
            No events recorded for this run.
          </div>
        ) : (
          <div className="border border-border rounded-lg overflow-hidden divide-y divide-border">
            {sortedEvents.map((event) => (
              <TimelineEvent key={event.id} event={event} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
