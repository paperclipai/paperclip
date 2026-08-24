import { useEffect, useRef, useState } from "react";
import type { BackgroundJob, BackgroundJobStatus } from "@paperclipai/shared";
import { backgroundJobsApi } from "../api/background-jobs";

const TERMINAL_STATUSES: readonly BackgroundJobStatus[] = ["succeeded", "failed"];
const POLL_INTERVAL_MS = 2000;

export interface UseJobStatusOptions {
  /** Polling interval in ms (default 2000). */
  pollInterval?: number;
  /** If true, attempts SSE for live updates (falls back to polling). */
  useSSE?: boolean;
}

export interface UseJobStatusResult {
  job: BackgroundJob | null;
  status: BackgroundJobStatus | "idle" | "loading";
  progress: number;
  progressMessage: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  isRunning: boolean;
  isDone: boolean;
  startedAt: string | null;
  finishedAt: string | null;
}

const IDLE: UseJobStatusResult = {
  job: null,
  status: "idle",
  progress: 0,
  progressMessage: null,
  result: null,
  error: null,
  isRunning: false,
  isDone: false,
  startedAt: null,
  finishedAt: null,
};

function statusToResult(
  job: BackgroundJob | null,
): UseJobStatusResult {
  if (!job) return IDLE;
  const status = job.status;
  const isTerminal = TERMINAL_STATUSES.includes(job.status);
  return {
    job,
    status,
    progress: job.progress,
    progressMessage: job.progressMessage,
    result: job.result,
    error: job.error,
    isRunning: status === "queued" || status === "running",
    isDone: isTerminal,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

/**
 * Hook to track the status of a background job.
 *
 * Polls the job status endpoint while the job is non-terminal.
 * Optionally subscribes to SSE for live updates (with polling as fallback).
 */
export function useJobStatus(
  companyId: string | undefined,
  jobId: string | undefined | null,
  options?: UseJobStatusOptions,
): UseJobStatusResult {
  const pollInterval = options?.pollInterval ?? POLL_INTERVAL_MS;
  const [result, setResult] = useState<UseJobStatusResult>(IDLE);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const unmountedRef = useRef(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Cleanup function
  const cleanup = () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  };

  useEffect(() => {
    unmountedRef.current = false;
    if (!companyId || !jobId) {
      setResult(IDLE);
      cleanup();
      return;
    }

    // Initial fetch
    backgroundJobsApi.get(companyId, jobId).then((job) => {
      if (!unmountedRef.current) setResult(statusToResult(job));
    }).catch(() => {
      // ignore — will retry via polling
    });

    // Poll while non-terminal
    intervalRef.current = setInterval(async () => {
      try {
        const job = await backgroundJobsApi.get(companyId, jobId);
        if (unmountedRef.current) return;
        setResult(statusToResult(job));

        if (TERMINAL_STATUSES.includes(job.status)) {
          cleanup();
        }
      } catch {
        // transient — keep polling
      }
    }, pollInterval);

    // SSE subscription (best-effort)
    if (options?.useSSE) {
      try {
        const url = backgroundJobsApi.eventsUrl(companyId);
        const es = new EventSource(url);
        eventSourceRef.current = es;

        es.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data) as {
              payload?: { jobId?: string; status?: BackgroundJobStatus };
            };
            if (data.payload?.jobId === jobId && data.payload?.status) {
              // Trigger an immediate fetch
              backgroundJobsApi.get(companyId, jobId).then((job) => {
                if (!unmountedRef.current) setResult(statusToResult(job));
              }).catch(() => {});
            }
          } catch {
            // ignore malformed SSE
          }
        };

        es.onerror = () => {
          // SSE disconnected — polling handles it
        };
      } catch {
        // SSE not available — polling is sufficient
      }
    }

    return () => {
      unmountedRef.current = true;
      cleanup();
    };
  }, [companyId, jobId, pollInterval, options?.useSSE]);

  return result;
}