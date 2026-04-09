import { useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { heartbeatsApi, type ActiveRunForIssue, type LiveRunForIssue } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";
import { formatDateTime } from "../lib/utils";
import { ExternalLink, Square } from "lucide-react";
import { Identity } from "./Identity";
import { RunChatSurface } from "./RunChatSurface";
import { StatusBadge } from "./StatusBadge";
import { useLiveRunTranscripts } from "./transcript/useLiveRunTranscripts";

interface LiveRunWidgetProps {
  issueId: string;
  companyId?: string | null;
  liveRunsData?: LiveRunForIssue[];
  activeRunData?: ActiveRunForIssue | null;
}

function toIsoString(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.toISOString();
}

function isRunActive(status: string): boolean {
  return status === "queued" || status === "running";
}

export function LiveRunWidget({
  issueId,
  companyId,
  liveRunsData,
  activeRunData,
}: LiveRunWidgetProps) {
  const queryClient = useQueryClient();
  const [cancellingRunIds, setCancellingRunIds] = useState(new Set<string>());
  const shouldFetchLiveRuns = liveRunsData === undefined;
  const shouldFetchActiveRun = activeRunData === undefined;

  const { data: fetchedLiveRuns } = useQuery({
    queryKey: queryKeys.issues.liveRuns(issueId),
    queryFn: () => heartbeatsApi.liveRunsForIssue(issueId),
    enabled: !!issueId && shouldFetchLiveRuns,
    refetchInterval: 3000,
  });

  const { data: fetchedActiveRun } = useQuery({
    queryKey: queryKeys.issues.activeRun(issueId),
    queryFn: () => heartbeatsApi.activeRunForIssue(issueId),
    enabled: !!issueId && shouldFetchActiveRun,
    refetchInterval: 3000,
  });

  const liveRuns = liveRunsData ?? fetchedLiveRuns;
  const activeRun = activeRunData ?? fetchedActiveRun;

  const runs = useMemo(() => {
    const deduped = new Map<string, LiveRunForIssue>();
    for (const run of liveRuns ?? []) {
      deduped.set(run.id, run);
    }
    if (activeRun) {
      deduped.set(activeRun.id, {
        id: activeRun.id,
        status: activeRun.status,
        invocationSource: activeRun.invocationSource,
        triggerDetail: activeRun.triggerDetail,
        startedAt: toIsoString(activeRun.startedAt),
        finishedAt: toIsoString(activeRun.finishedAt),
        createdAt: toIsoString(activeRun.createdAt) ?? new Date().toISOString(),
        agentId: activeRun.agentId,
        agentName: activeRun.agentName,
        adapterType: activeRun.adapterType,
        issueId,
      });
    }
    return [...deduped.values()].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }, [activeRun, issueId, liveRuns]);

  const { transcriptByRun, hasOutputForRun } = useLiveRunTranscripts({ runs, companyId });

  const handleCancelRun = async (runId: string) => {
    setCancellingRunIds((prev) => new Set(prev).add(runId));
    try {
      await heartbeatsApi.cancel(runId);
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.liveRuns(issueId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.activeRun(issueId) });
    } finally {
      setCancellingRunIds((prev) => {
        const next = new Set(prev);
        next.delete(runId);
        return next;
      });
    }
  };

  if (runs.length === 0) return null;

  return (
    <div className="overflow-hidden rounded-xl border border-cyan-500/25 bg-background/80 shadow-[0_18px_50px_rgba(6,182,212,0.08)]">
      <div className="border-b border-border/60 bg-cyan-500/[0.04] px-4 py-3">
        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-700 dark:text-cyan-300">
          Live Runs
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          Uses the shared chat-style run surface from issue activity.
        </div>
      </div>

      <div className="divide-y divide-border/60">
        {runs.map((run) => {
          const isActive = isRunActive(run.status);
          const transcript = transcriptByRun.get(run.id) ?? [];
          return (
            <section key={run.id} className="px-4 py-4">
              <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <Link to={`/agents/${run.agentId}`} className="inline-flex hover:underline">
                    <Identity name={run.agentName} size="sm" />
                  </Link>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Link
                      to={`/agents/${run.agentId}/runs/${run.id}`}
                      className="inline-flex items-center rounded-full border border-border/70 bg-background/70 px-2 py-1 font-mono hover:border-cyan-500/30 hover:text-foreground"
                    >
                      {run.id.slice(0, 8)}
                    </Link>
                    <StatusBadge status={run.status} />
                    <span>{formatDateTime(run.startedAt ?? run.createdAt)}</span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {isActive && (
                    <button
                      onClick={() => handleCancelRun(run.id)}
                      disabled={cancellingRunIds.has(run.id)}
                      className="inline-flex items-center gap-1 rounded-full border border-red-500/20 bg-red-500/[0.06] px-2.5 py-1 text-[11px] font-medium text-red-700 transition-colors hover:bg-red-500/[0.12] dark:text-red-300 disabled:opacity-50"
                    >
                      <Square className="h-2.5 w-2.5" fill="currentColor" />
                      {cancellingRunIds.has(run.id) ? "Stopping…" : "Stop"}
                    </button>
                  )}
                  <Link
                    to={`/agents/${run.agentId}/runs/${run.id}`}
                    className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background/70 px-2.5 py-1 text-[11px] font-medium text-cyan-700 transition-colors hover:border-cyan-500/30 hover:text-cyan-600 dark:text-cyan-300"
                  >
                    Open run
                    <ExternalLink className="h-3 w-3" />
                  </Link>
                </div>
              </div>

              <div className="max-h-[320px] overflow-y-auto pr-1">
                <RunChatSurface
                  run={run}
                  transcript={transcript}
                  hasOutput={hasOutputForRun(run.id)}
                  companyId={companyId}
                />
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
