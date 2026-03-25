import { useEffect, useState, useMemo } from "react";
import { Link } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { heartbeatsApi } from "../api/heartbeats";
import { activityApi } from "../api/activity";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { runMetrics } from "../lib/run-utils";
import { StatusBadge } from "./StatusBadge";
import { invocationSourceLabel, invocationSourceBadge, invocationSourceBadgeDefault } from "../lib/status-colors";
import { cn, relativeTime, formatTokens, agentRouteRef } from "../lib/utils";
import { Button } from "@/components/ui/button";
import {
  RotateCcw,
  ExternalLink,
  ChevronRight,
} from "lucide-react";
import type { HeartbeatRun, Agent } from "@paperclipai/shared";

interface RunDetailPanelProps {
  run: HeartbeatRun;
  agent?: Agent;
  onClose?: () => void;
}

export function RunDetailPanel({ run: initialRun, agent, onClose }: RunDetailPanelProps) {
  const queryClient = useQueryClient();
  const { data: hydratedRun } = useQuery({
    queryKey: queryKeys.runDetail(initialRun.id),
    queryFn: () => heartbeatsApi.get(initialRun.id),
    enabled: Boolean(initialRun.id),
    refetchInterval: initialRun.status === "running" || initialRun.status === "queued" ? 3000 : false,
  });
  const run = hydratedRun ?? initialRun;
  const metrics = runMetrics(run);

  const cancelRun = useMutation({
    mutationFn: () => heartbeatsApi.cancel(run.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(run.companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.runDetail(run.id) });
    },
  });

  const { data: touchedIssues } = useQuery({
    queryKey: queryKeys.runIssues(run.id),
    queryFn: () => activityApi.issuesForRun(run.id),
  });

  const isRunning = run.status === "running" && !!run.startedAt && !run.finishedAt;
  const [elapsedSec, setElapsedSec] = useState<number>(() => {
    if (!run.startedAt) return 0;
    return Math.max(0, Math.round((Date.now() - new Date(run.startedAt).getTime()) / 1000));
  });

  useEffect(() => {
    if (!isRunning || !run.startedAt) return;
    const startMs = new Date(run.startedAt).getTime();
    setElapsedSec(Math.max(0, Math.round((Date.now() - startMs) / 1000)));
    const id = setInterval(() => {
      setElapsedSec(Math.max(0, Math.round((Date.now() - startMs) / 1000)));
    }, 1000);
    return () => clearInterval(id);
  }, [isRunning, run.startedAt]);

  const timeFormat: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false };
  const startTime = run.startedAt ? new Date(run.startedAt).toLocaleTimeString("en-US", timeFormat) : null;
  const endTime = run.finishedAt ? new Date(run.finishedAt).toLocaleTimeString("en-US", timeFormat) : null;
  const durationSec = run.startedAt && run.finishedAt
    ? Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)
    : null;
  const displayDurationSec = durationSec ?? (isRunning ? elapsedSec : null);
  const hasMetrics = metrics.input > 0 || metrics.output > 0 || metrics.cached > 0 || metrics.cost > 0;

  const agentRef = agent ? agentRouteRef(agent) : run.agentId;
  const fullDetailUrl = `/agents/${agentRef}/runs/${run.id}`;

  return (
    <div className="space-y-4 min-w-0">
      {/* Header with agent name + link to full detail */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {agent && (
            <Link
              to={`/agents/${agentRef}`}
              className="text-sm font-medium text-foreground hover:underline no-underline truncate"
            >
              {agent.name}
            </Link>
          )}
          <span className="font-mono text-xs text-muted-foreground">{run.id.slice(0, 8)}</span>
        </div>
        <Link
          to={fullDetailUrl}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors no-underline shrink-0"
        >
          Full detail
          <ExternalLink className="h-3 w-3" />
        </Link>
      </div>

      {/* Summary card */}
      <div className="border border-border rounded-lg overflow-hidden">
        <div className="flex flex-col sm:flex-row">
          <div className="flex-1 p-4 space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <StatusBadge status={run.status} />
              <span
                className={cn(
                  "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium shrink-0",
                  invocationSourceBadge[run.invocationSource] ?? invocationSourceBadgeDefault,
                )}
              >
                {invocationSourceLabel[run.invocationSource] ?? run.invocationSource}
              </span>
              {(run.status === "running" || run.status === "queued") && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive text-xs h-6 px-2"
                  onClick={() => cancelRun.mutate()}
                  disabled={cancelRun.isPending}
                >
                  {cancelRun.isPending ? "Cancelling…" : "Cancel"}
                </Button>
              )}
            </div>

            {startTime && (
              <div className="space-y-0.5">
                <div className="text-sm font-mono tabular-nums">
                  {startTime}
                  {endTime && <span className="text-muted-foreground"> &rarr; </span>}
                  {endTime}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {relativeTime(run.startedAt!)}
                  {run.finishedAt && <> &rarr; {relativeTime(run.finishedAt)}</>}
                </div>
                {displayDurationSec !== null && (
                  <div className="text-xs text-muted-foreground tabular-nums">
                    Duration: {displayDurationSec >= 60 ? `${Math.floor(displayDurationSec / 60)}m ${displayDurationSec % 60}s` : `${displayDurationSec}s`}
                    {isRunning && (
                      <span className="ml-2 inline-flex items-center gap-1 text-cyan-500">
                        <span className="relative flex h-1.5 w-1.5">
                          <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
                          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-cyan-400" />
                        </span>
                        live
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}

            {run.error && (
              <div className="text-xs">
                <span className="text-red-600 dark:text-red-400">{run.error}</span>
                {run.errorCode && <span className="text-muted-foreground ml-1">({run.errorCode})</span>}
              </div>
            )}

            {run.exitCode !== null && run.exitCode !== 0 && (
              <div className="text-xs text-red-600 dark:text-red-400">
                Exit code {run.exitCode}
                {run.signal && <span className="text-muted-foreground ml-1">(signal: {run.signal})</span>}
              </div>
            )}
          </div>

          {hasMetrics && (
            <div className="border-t sm:border-t-0 sm:border-l border-border p-4 grid grid-cols-2 gap-x-4 sm:gap-x-8 gap-y-3 content-center tabular-nums">
              <div>
                <div className="text-xs text-muted-foreground">Input</div>
                <div className="text-sm font-medium font-mono">{formatTokens(metrics.input)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Output</div>
                <div className="text-sm font-medium font-mono">{formatTokens(metrics.output)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Cached</div>
                <div className="text-sm font-medium font-mono">{formatTokens(metrics.cached)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Cost</div>
                <div className="text-sm font-medium font-mono">{metrics.cost > 0 ? `$${metrics.cost.toFixed(4)}` : "-"}</div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* stderr excerpt */}
      {run.stderrExcerpt && (
        <div className="space-y-1">
          <span className="text-xs font-medium text-red-600 dark:text-red-400">stderr</span>
          <pre className="bg-neutral-100 dark:bg-neutral-950 rounded-md p-3 text-xs font-mono text-red-700 dark:text-red-300 overflow-x-auto whitespace-pre-wrap max-h-48 overflow-y-auto">
            {run.stderrExcerpt}
          </pre>
        </div>
      )}

      {/* Issues touched */}
      {touchedIssues && touchedIssues.length > 0 && (
        <div className="space-y-2">
          <span className="text-xs font-medium text-muted-foreground">Issues ({touchedIssues.length})</span>
          <div className="border border-border rounded-lg divide-y divide-border">
            {touchedIssues.map((issue) => (
              <Link
                key={issue.issueId}
                to={`/issues/${issue.identifier ?? issue.issueId}`}
                className="flex items-center justify-between w-full px-3 py-2 text-xs hover:bg-accent/20 transition-colors text-left no-underline text-inherit"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <StatusBadge status={issue.status} />
                  <span className="truncate">{issue.title}</span>
                </div>
                <span className="font-mono text-muted-foreground shrink-0 ml-2">
                  {issue.identifier ?? issue.issueId.slice(0, 8)}
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* CTA to full detail */}
      <Link
        to={fullDetailUrl}
        className="flex items-center justify-center gap-2 w-full py-2.5 px-4 text-sm font-medium border border-border rounded-lg hover:bg-accent/30 transition-colors no-underline text-foreground"
      >
        View full log &amp; transcript
        <ChevronRight className="h-4 w-4" />
      </Link>
    </div>
  );
}
