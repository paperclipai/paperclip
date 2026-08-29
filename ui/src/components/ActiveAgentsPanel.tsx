import { memo, useMemo, type ReactNode } from "react";
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
import { usePublishSharedQueryData, useSharedPollingQuery } from "../hooks/useSharedPolling";
import { Badge } from "@/components/ui/badge";

function RunCardRecoveryChip({ action }: { action: IssueRecoveryAction }) {
  const state = deriveActiveRecoveryDisplayState(action);
  if (!state) return null;
  const tone = RECOVERY_CHIP_DEFAULT_TONE[state];
  const Icon = tone.icon;
  return (
    <Badge variant="outline"
      data-testid="active-agent-run-recovery-indicator"
      data-recovery-state={state}
      role="status"
      aria-label={tone.label}
      title={`${tone.label} — open the source task to act.`}
      className={cn(
        "gap-0.5 px-1.5 text-(length:--text-nano)",
        tone.className,
      )}
    >
      <Icon className="h-2.5 w-2.5" aria-hidden />
      {tone.label}
    </Badge>
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
  headerExtra?: ReactNode;
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
  headerExtra,
}: ActiveAgentsPanelProps) {
  const liveRunsQueryKey = [...queryKeys.liveRuns(companyId), queryScope, { minRunCount, fetchLimit }] as const;
  const sharedLiveRuns = useSharedPollingQuery({
    companyId,
    resourceKey: `live-runs:${queryScope}:${minRunCount}:${fetchLimit ?? "default"}`,
    queryKey: liveRunsQueryKey,
    enabled: !!companyId,
    leaderOnly: true,
  });
  const { data: liveRuns, dataUpdatedAt: liveRunsUpdatedAt } = useQuery({
    queryKey: liveRunsQueryKey,
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId, { minCount: minRunCount, limit: fetchLimit }),
    enabled: sharedLiveRuns.enabled,
  });
  usePublishSharedQueryData(sharedLiveRuns, liveRuns, liveRunsUpdatedAt);

  const runs = liveRuns ?? [];
  const visibleRuns = useMemo(() => runs.slice(0, cardLimit), [cardLimit, runs]);
  const hiddenRunCount = Math.max(0, runs.length - visibleRuns.length);
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
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="dashboard-section-title">
          {title}
        </h3>
        {headerExtra}
      </div>
      {runs.length === 0 ? (
        <div className="dashboard-subtle-panel rounded-xl border p-4">
          <p className="text-sm text-muted-foreground">{emptyMessage}</p>
        </div>
      ) : (
        <div className={cn("grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4", gridClassName)}>
          {visibleRuns.map((run) => (
            <AgentRunCard
              key={run.id}
              companyId={companyId}
              run={run}
              issue={run.issueId ? issueById.get(run.issueId) : undefined}
              transcript={transcriptByRun.get(run.id) ?? EMPTY_TRANSCRIPT}
              hasOutput={hasOutputForRun(run.id)}
              isActive={isRunActive(run)}
              className={cardClassName}
            />
          ))}
        </div>
      )}
      {showMoreLink && hiddenRunCount > 0 && (
        <div className="mt-3 flex justify-end text-xs text-muted-foreground">
          <Link to="/dashboard/live" className="hover:text-foreground hover:underline">
            {hiddenRunCount} more active/recent run{hiddenRunCount === 1 ? "" : "s"}
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
      "flex h-(--sz-320px) flex-col overflow-hidden rounded-xl border",
      isActive
        ? "dashboard-live-card dashboard-surface-dotted"
        : "dashboard-surface dashboard-surface-dotted",
      className,
    )}>
      <div className="dashboard-divider border-b px-3 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {isActive ? (
                <span className="relative flex h-2.5 w-2.5 shrink-0">
                  <span className="dashboard-live-indicator absolute inline-flex h-full w-full motion-safe:animate-ping rounded-full opacity-70" />
                  <span className="dashboard-live-indicator relative inline-flex h-2.5 w-2.5 rounded-full" />
                </span>
              ) : (
                <span className="dashboard-neutral-indicator inline-flex h-2.5 w-2.5 rounded-full" />
              )}
              <Identity name={run.agentName} size="sm" className="[&>span:last-child]:!text-(length:--text-micro)" />
            </div>
            <div className="mt-2 flex items-center gap-2 text-(length:--text-micro) text-muted-foreground">
              <span>{isActive ? "Live now" : run.finishedAt ? `Finished ${relativeTime(run.finishedAt)}` : `Started ${relativeTime(run.createdAt)}`}</span>
            </div>
          </div>

          <Link
            to={`/agents/${run.agentId}/runs/${run.id}`}
            className="dashboard-surface-interactive inline-flex items-center gap-1 rounded-full border px-2 py-1 text-(length:--text-nano) text-muted-foreground"
          >
            <ExternalLink className="h-2.5 w-2.5" />
          </Link>
        </div>

        {run.issueId && (
          <div className="dashboard-subtle-panel mt-3 rounded-lg border px-2.5 py-2 text-xs">
            {issue?.project?.name ? (
              <Link
                to={`/projects/${issue.projectId ?? issue.project.id}`}
                className="mb-1 block truncate dashboard-eyebrow text-muted-foreground/80 hover:text-foreground hover:underline"
                title={issue.project.name}
              >
                {issue.project.name}
              </Link>
            ) : null}
            <Link
              to={`/issues/${issue?.identifier ?? run.issueId}`}
              className={cn(
                "line-clamp-2 hover:underline",
                isActive ? "dashboard-link" : "text-muted-foreground hover:text-foreground",
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
