import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { backgroundJobsApi } from "@/api/background-jobs";
import type { BackgroundJob, BackgroundJobStatus } from "@paperclipai/shared";

interface BackgroundProcessTrayProps {
  companyId: string;
  /** Max items to show (default 20). */
  maxItems?: number;
  /** Optional single job-type filter (e.g. "export.pdf"). */
  jobTypeFilter?: string;
  className?: string;
}

const TERMINAL_STATUSES = new Set<BackgroundJobStatus>(["succeeded", "failed"]);

function isRunningStatus(status: BackgroundJobStatus): boolean {
  return status === "queued" || status === "running";
}

/**
 * Consolidated tray of background processes for a company.
 *
 * Subscribes to the SSE /events endpoint for live updates and falls back
 * to periodic polling. Shows running jobs at the top, then recently
 * completed ones. Each row has the label, a progress indicator, duration,
 * and the final result/error.
 */
export function BackgroundProcessTray({
  companyId,
  maxItems = 20,
  jobTypeFilter,
  className = "",
}: BackgroundProcessTrayProps) {
  const [jobs, setJobs] = useState<BackgroundJob[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const unmountedRef = useRef(false);

  const listOpts = (): Parameters<typeof backgroundJobsApi.list>[1] => ({
    limit: maxItems,
    ...(jobTypeFilter ? { jobType: jobTypeFilter } : {}),
  });

  const refresh = useCallback(() => {
    backgroundJobsApi.list(companyId, listOpts()).then((list) => {
      if (!unmountedRef.current) setJobs(list);
    }).catch(() => {
      // transient — poller/SSE retries
    });
  }, [companyId, maxItems, jobTypeFilter]);

  // Initial fetch
  useEffect(() => {
    unmountedRef.current = false;
    refresh();
    return () => {
      unmountedRef.current = true;
    };
  }, [refresh]);

  // SSE subscription for live updates
  useEffect(() => {
    try {
      const es = new EventSource(backgroundJobsApi.eventsUrl(companyId));
      eventSourceRef.current = es;

      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as { type?: string };
          if (data.type === "background_job.status") refresh();
        } catch {
          // ignore malformed SSE
        }
      };
      // SSE connected — stop the polling fallback
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }

      es.onerror = () => {
        // SSE dropped — restart polling fallback
        if (!pollTimerRef.current) {
          pollTimerRef.current = setInterval(refresh, 5000);
        }
      };
    } catch {
      // SSE not available — polling fallback below handles it
    }

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [companyId, refresh]);

  // Polling fallback when SSE never connects
  useEffect(() => {
    const timer = setInterval(() => {
      if (!eventSourceRef.current) refresh();
    }, 5000);
    pollTimerRef.current = timer;
    return () => {
      clearInterval(timer);
      pollTimerRef.current = null;
    };
  }, [refresh]);

  const sorted = [...jobs].sort((a, b) => {
    const aRunning = isRunningStatus(a.status);
    const bRunning = isRunningStatus(b.status);
    if (aRunning !== bRunning) return aRunning ? -1 : 1;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  const runningCount = sorted.filter((j) => isRunningStatus(j.status)).length;

  if (sorted.length === 0) return null;

  return (
    <div className={`rounded-lg border border-border bg-card ${className}`}>
      {/* Header */}
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium text-foreground hover:bg-muted/50 transition-colors"
      >
        <span className="flex items-center gap-2">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Background Processes
          </span>
          {runningCount > 0 && (
            <span className="inline-flex h-5 items-center gap-1 rounded-full bg-blue-500/10 px-2 text-xs font-medium text-blue-600 dark:text-blue-400">
              <Loader2 className="h-3 w-3 animate-spin" />
              {runningCount} running
            </span>
          )}
        </span>
        <span className="text-xs text-muted-foreground">{collapsed ? "+" : "−"}</span>
      </button>

      {!collapsed && (
        <div className="divide-y divide-border/50 max-h-[320px] overflow-y-auto">
          {sorted.slice(0, maxItems).map((job) => (
            <JobRow key={job.id} job={job} />
          ))}
        </div>
      )}
    </div>
  );
}

function JobRow({ job }: { job: BackgroundJob }) {
  const isRunning = isRunningStatus(job.status);
  const isTerminal = TERMINAL_STATUSES.has(job.status);

  return (
    <div className="flex items-start gap-2 px-3 py-2 text-sm">
      {/* Status indicator */}
      <span
        className={`mt-0.5 inline-block h-2 w-2 shrink-0 rounded-full ${
          isRunning
            ? "bg-blue-500 animate-pulse"
            : job.status === "succeeded"
              ? "bg-green-500"
              : job.status === "failed"
                ? "bg-red-500"
                : "bg-muted-foreground"
        }`}
        aria-hidden="true"
      />

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-xs">
          <span className="font-medium text-foreground truncate">{jobTypeLabel(job.jobType)}</span>
          <span
            className={`text-xs ${
              job.status === "running"
                ? "text-blue-500"
                : job.status === "queued"
                  ? "text-blue-400"
                  : job.status === "succeeded"
                    ? "text-green-600 dark:text-green-400"
                    : job.status === "failed"
                      ? "text-red-600 dark:text-red-400"
                      : "text-muted-foreground"
            }`}
          >
            {job.status}
          </span>
        </div>

        {/* Progress bar */}
        {isRunning && (
          <div className="mt-1 flex items-center gap-2">
            <div className="h-1 w-full max-w-[120px] rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-blue-500 transition-all duration-500"
                style={{ width: `${Math.min(job.progress, 100)}%` }}
              />
            </div>
            {job.progress > 0 && (
              <span className="text-[10px] tabular-nums text-muted-foreground">{job.progress}%</span>
            )}
          </div>
        )}

        {/* Progress message */}
        {job.progressMessage && (
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{job.progressMessage}</p>
        )}

        {/* Error */}
        {job.error && (
          <p className="mt-0.5 truncate text-[11px] text-red-500" title={job.error}>
            {job.error}
          </p>
        )}

        {/* Timing */}
        {isTerminal && job.durationMs !== null && (
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            {formatDuration(job.durationMs)}
            {job.finishedAt && ` — ${new Date(job.finishedAt).toLocaleTimeString()}`}
          </p>
        )}
      </div>
    </div>
  );
}

function jobTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    "research.activity_search": "Activity Search",
    "research.auto_assess": "Auto-Assessment",
    "research.semantic_search": "Semantic Search",
    "export.pdf": "PDF Export",
    "export.ics": "Calendar Export",
  };
  return labels[type] ?? type.replace(/_/g, " ").replace(/\./g, ": ");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}