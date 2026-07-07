import { memo, useMemo } from "react";
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
import { StatusBadge } from "./StatusBadge";
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
const DASHBOARD_RUN_REFRESH_INTERVAL_MS = 5_000;
const DASHBOARD_LOG_POLL_INTERVAL_MS = 15_000;
const DASHBOARD_LOG_READ_LIMIT_BYTES = 64_000;
const DASHBOARD_MAX_CHUNKS_PER_RUN = 40;
const EMPTY_TRANSCRIPT: TranscriptEntry[] = [];

function isRunActive(run: LiveRunForIssue): boolean {
  return run.status === "queued" || run.status === "running";
}

function runStatusLabel(run: LiveRunForIssue, issue?: Issue): string {
  if (issue?.status === "blocked") return "blocked";
  if (run.status === "succeeded") return "done";
  if (run.status === "failed" || run.status === "timed_out") return "error";
  return run.status;
}

function lastActivityAt(run: LiveRunForIssue): string | Date {
  return run.lastOutputAt ?? run.lastUsefulActionAt ?? run.finishedAt ?? run.startedAt ?? run.createdAt;
}

function lastActivityLabel(run: LiveRunForIssue): string {
  const activityAt = lastActivityAt(run);
  if (run.lastOutputAt) return `Output ${relativeTime(activityAt)}`;
  if (run.lastUsefulActionAt) return `Progress ${relativeTime(activityAt)}`;
  if (run.finishedAt) return `Finished ${relativeTime(activityAt)}`;
  if (run.startedAt) return `Started ${relativeTime(activityAt)}`;
  return `Created ${relativeTime(activityAt)}`;
}

function recentActivityText(run: LiveRunForIssue): string {
  if (run.nextAction) return run.nextAction;
  if (run.livenessReason) return run.livenessReason;
  if (run.lastOutputAt) return `Last output ${relativeTime(run.lastOutputAt)}`;
  if (run.finishedAt) return `Run ${run.status.replace(/_/g, " ")} ${relativeTime(run.finishedAt)}`;
  return "Waiting for run activity.";
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
  const { data: liveRuns } = useQuery({
    queryKey: [...queryKeys.liveRuns(companyId), queryScope, { minRunCount, fetchLimit }],
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId, { minCount: minRunCount, limit: fetchLimit }),
    refetchInterval: DASHBOARD_RUN_REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: true,
  });

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
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {runs.length === 0 ? (
        <div className="rounded-xl border border-border p-4">
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
      "flex h-[320px] flex-col overflow-hidden rounded-xl border shadow-sm",
      isActive
        ? "border-cyan-500/25 bg-cyan-500/[0.04] shadow-[0_16px_40px_rgba(6,182,212,0.08)]"
        : "border-border bg-background/70",
      className,
    )}>
      <div className="border-b border-border/60 px-3 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2 pr-1">
              {isActive ? (
                <span className="relative flex h-2.5 w-2.5 shrink-0">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-70" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-cyan-500" />
                </span>
              ) : (
                <span className="inline-flex h-2.5 w-2.5 rounded-full bg-muted-foreground/35" />
              )}
              <Identity name={run.agentName} size="sm" className="[&>span:last-child]:!text-[11px]" />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              <StatusBadge status={runStatusLabel(run, issue)} />
              <span>{isActive ? "Live now" : run.finishedAt ? `Finished ${relativeTime(run.finishedAt)}` : `Started ${relativeTime(run.createdAt)}`}</span>
              <span className="text-muted-foreground/50">·</span>
              <span>{lastActivityLabel(run)}</span>
            </div>
          </div>

          <Link
            to={`/agents/${run.agentId}/runs/${run.id}`}
            className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background/70 px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <ExternalLink className="h-2.5 w-2.5" />
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
        <div className="mt-2 rounded-lg border border-border/50 bg-background/45 px-2.5 py-2">
          <p className="line-clamp-2 text-[11px] leading-4 text-muted-foreground" title={recentActivityText(run)}>
            {recentActivityText(run)}
          </p>
        </div>
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
