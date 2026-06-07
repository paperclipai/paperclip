import { memo, useId, useMemo } from "react";
import { Link } from "@/lib/router";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { Issue, IssueRecoveryAction } from "@paperclipai/shared";
import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import type { TranscriptEntry } from "../adapters";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";
import {
  deriveActiveRecoveryDisplayState,
  RECOVERY_CHIP_DEFAULT_TONE,
} from "../lib/recovery-display";
import { ExternalLink } from "lucide-react";
import { Identity } from "./Identity";
import { RunChatSurface } from "./RunChatSurface";
import { useLiveRunTranscripts } from "./transcript/useLiveRunTranscripts";

function RunCardRecoveryChip({ action }: { action: IssueRecoveryAction }) {
  const state = deriveActiveRecoveryDisplayState(action);
  if (!state) return null;
  const tone = RECOVERY_CHIP_DEFAULT_TONE[state];
  const Icon = tone.icon;
  return (
    <span
      data-testid="active-agent-run-recovery-indicator"
      data-recovery-state={state}
      role="status"
      aria-label={tone.label}
      title={`${tone.label} — open the source task to act.`}
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
        tone.className,
      )}
    >
      <Icon className="h-2.5 w-2.5" aria-hidden />
      {tone.label}
    </span>
  );
}

const MIN_DASHBOARD_RUNS = 4;
const DASHBOARD_RUN_CARD_LIMIT = 4;
const DASHBOARD_LOG_POLL_INTERVAL_MS = 15_000;
const DASHBOARD_LOG_READ_LIMIT_BYTES = 64_000;
const DASHBOARD_MAX_CHUNKS_PER_RUN = 40;
const EMPTY_TRANSCRIPT: TranscriptEntry[] = [];

function isRunActive(run: LiveRunForIssue): boolean {
  return run.status === "queued" || run.status === "running";
}

interface ActiveAgentsPanelProps {
  companyId: string;
  title?: string;
  minRunCount?: number;
  fetchLimit?: number;
  cardLimit?: number;
  gridClassName?: string;
  cardClassName?: string;
  emptyMessage?: string;
  queryScope?: string;
  showMoreLink?: boolean;
}

export function ActiveAgentsPanel({
  companyId,
  title = "Agents",
  minRunCount = MIN_DASHBOARD_RUNS,
  fetchLimit,
  cardLimit = DASHBOARD_RUN_CARD_LIMIT,
  gridClassName,
  cardClassName,
  emptyMessage = "No recent agent runs.",
  queryScope = "dashboard",
  showMoreLink = true,
}: ActiveAgentsPanelProps) {
  const liveHeadingId = useId();
  const recentHeadingId = useId();
  const liveFetchLimit = fetchLimit;
  const { data: liveRuns } = useQuery({
    queryKey: [...queryKeys.liveRuns(companyId), queryScope, "live", { liveFetchLimit }],
    queryFn: () => heartbeatsApi.liveRunsForCompany(
      companyId,
      liveFetchLimit ? { limit: liveFetchLimit } : undefined,
    ),
  });

  const { data: paddedRuns } = useQuery({
    queryKey: [...queryKeys.liveRuns(companyId), queryScope, "recent", { minRunCount, fetchLimit }],
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId, { minCount: minRunCount, limit: fetchLimit }),
    enabled: minRunCount > 0,
  });

  const liveOnlyRuns = useMemo(() => (liveRuns ?? []).filter(isRunActive), [liveRuns]);
  const recentOnlyRuns = useMemo(
    () => (paddedRuns ?? []).filter((run) => !isRunActive(run)),
    [paddedRuns],
  );
  const visibleLiveRuns = useMemo(() => liveOnlyRuns.slice(0, cardLimit), [cardLimit, liveOnlyRuns]);
  const recentCardLimit = Math.max(0, cardLimit - visibleLiveRuns.length);
  const visibleRecentRuns = useMemo(
    () => recentOnlyRuns.slice(0, recentCardLimit),
    [recentCardLimit, recentOnlyRuns],
  );
  const visibleRuns = useMemo(
    () => [...visibleLiveRuns, ...visibleRecentRuns],
    [visibleLiveRuns, visibleRecentRuns],
  );
  const hiddenRunCount = Math.max(
    0,
    liveOnlyRuns.length + recentOnlyRuns.length - visibleRuns.length,
  );
  const visibleIssueIds = useMemo(
    () => [...new Set(visibleRuns.map((run) => run.issueId).filter((issueId): issueId is string => Boolean(issueId)))],
    [visibleRuns],
  );

  const issueQueries = useQueries({
    queries: visibleIssueIds.map((issueId) => ({
      queryKey: queryKeys.issues.detail(issueId),
      queryFn: () => issuesApi.get(issueId),
      staleTime: 30_000,
      retry: false,
    })),
  });

  const issueById = useMemo(() => {
    const map = new Map<string, Issue>();
    for (const query of issueQueries) {
      const issue = query.data;
      if (issue) map.set(issue.id, issue);
    }
    return map;
  }, [issueQueries]);

  const { transcriptByRun, hasOutputForRun } = useLiveRunTranscripts({
    runs: visibleRuns,
    companyId,
    maxChunksPerRun: DASHBOARD_MAX_CHUNKS_PER_RUN,
    logPollIntervalMs: DASHBOARD_LOG_POLL_INTERVAL_MS,
    logReadLimitBytes: DASHBOARD_LOG_READ_LIMIT_BYTES,
    enableRealtimeUpdates: false,
  });

  return (
    <div>
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {visibleRuns.length === 0 ? (
        <div className="rounded-xl border border-border p-4">
          <p className="text-sm text-muted-foreground">{emptyMessage}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {visibleLiveRuns.length > 0 && (
            <section aria-labelledby={liveHeadingId}>
              <h4 id={liveHeadingId} className="sr-only">Live agent runs</h4>
              <div className={cn("grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4", gridClassName)}>
                {visibleLiveRuns.map((run) => (
                  <AgentRunCard
                    key={run.id}
                    companyId={companyId}
                    run={run}
                    issue={run.issueId ? issueById.get(run.issueId) : undefined}
                    transcript={transcriptByRun.get(run.id) ?? EMPTY_TRANSCRIPT}
                    hasOutput={hasOutputForRun(run.id)}
                    isActive
                    className={cardClassName}
                  />
                ))}
              </div>
            </section>
          )}

          {visibleRecentRuns.length > 0 && (
            <section aria-labelledby={recentHeadingId}>
              <h4 id={recentHeadingId} className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Recent runs
              </h4>
              <div className={cn("grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4", gridClassName)}>
                {visibleRecentRuns.map((run) => (
                  <AgentRunCard
                    key={run.id}
                    companyId={companyId}
                    run={run}
                    issue={run.issueId ? issueById.get(run.issueId) : undefined}
                    transcript={transcriptByRun.get(run.id) ?? EMPTY_TRANSCRIPT}
                    hasOutput={hasOutputForRun(run.id)}
                    isActive={false}
                    className={cardClassName}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
      {showMoreLink && hiddenRunCount > 0 && (
        <div className="mt-3 flex justify-end text-xs text-muted-foreground">
          <Link to="/dashboard/live" className="hover:text-foreground hover:underline" aria-label={`Open ${hiddenRunCount} more live or recent agent runs`}>
            {hiddenRunCount} more live/recent run{hiddenRunCount === 1 ? "" : "s"}
          </Link>
        </div>
      )}
    </div>
  );
}

const AgentRunCard = memo(function AgentRunCard({
  companyId,
  run,
  issue,
  transcript,
  hasOutput,
  isActive,
  className,
}: {
  companyId: string;
  run: LiveRunForIssue;
  issue?: Issue;
  transcript: TranscriptEntry[];
  hasOutput: boolean;
  isActive: boolean;
  className?: string;
}) {
  return (
    <div className={cn(
      "flex h-[320px] flex-col overflow-hidden rounded-xl border shadow-sm",
      isActive
        ? "border-cyan-500/25 bg-cyan-500/[0.04] shadow-[0_16px_40px_rgba(6,182,212,0.08)]"
        : "border-border bg-background/70",
      className,
    )}>
      <div className="border-b border-border/60 px-3 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {isActive ? (
                <span className="relative flex h-2.5 w-2.5 shrink-0" role="status" aria-label="Live run">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-70 motion-safe:animate-ping" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-cyan-500" aria-hidden />
                </span>
              ) : (
                <span className="inline-flex h-2.5 w-2.5 rounded-full bg-muted-foreground/35" aria-hidden />
              )}
              <Identity name={run.agentName} size="sm" className="[&>span:last-child]:!text-[11px]" />
            </div>
            <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
              <span>{isActive ? "Live now" : run.finishedAt ? `Finished ${relativeTime(run.finishedAt)}` : `Started ${relativeTime(run.createdAt)}`}</span>
            </div>
          </div>

          <Link
            to={`/agents/${run.agentId}/runs/${run.id}`}
            className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background/70 px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
            aria-label={`Open ${run.agentName} run ${run.id.slice(0, 8)}`}
            title={`Open ${run.agentName} run`}
          >
            <ExternalLink className="h-2.5 w-2.5" aria-hidden />
          </Link>
        </div>

        {run.issueId && (
          <div className="mt-3 rounded-lg border border-border/60 bg-background/60 px-2.5 py-2 text-xs">
            <Link
              to={`/issues/${issue?.identifier ?? run.issueId}`}
              className={cn(
                "line-clamp-2 hover:underline",
                isActive ? "text-cyan-700 dark:text-cyan-300" : "text-muted-foreground hover:text-foreground",
              )}
              title={issue?.title ? `${issue?.identifier ?? run.issueId.slice(0, 8)} - ${issue.title}` : issue?.identifier ?? run.issueId.slice(0, 8)}
            >
              {issue?.identifier ?? run.issueId.slice(0, 8)}
              {issue?.title ? ` - ${issue.title}` : ""}
            </Link>
            {issue?.activeRecoveryAction ? (
              <div className="mt-1.5">
                <RunCardRecoveryChip action={issue.activeRecoveryAction} />
              </div>
            ) : null}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <RunChatSurface
          run={run}
          transcript={transcript}
          hasOutput={hasOutput}
          companyId={companyId}
        />
      </div>
    </div>
  );
});
