import { memo, useMemo } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import type { Agent, Issue } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import type { TranscriptEntry } from "../adapters";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { cn, agentUrl, relativeTime } from "../lib/utils";
import { ExternalLink } from "lucide-react";
import { AgentIcon } from "./AgentIconPicker";
import { Identity } from "./Identity";
import { RunChatSurface } from "./RunChatSurface";
import { useLiveRunTranscripts } from "./transcript/useLiveRunTranscripts";

const MIN_DASHBOARD_RUNS = 4;
const DASHBOARD_RUN_CARD_LIMIT = 4;
const DASHBOARD_LOG_POLL_INTERVAL_MS = 15_000;
const DASHBOARD_LOG_READ_LIMIT_BYTES = 64_000;
const DASHBOARD_MAX_CHUNKS_PER_RUN = 40;
const EMPTY_TRANSCRIPT: TranscriptEntry[] = [];

function isRunActive(run: LiveRunForIssue): boolean {
  return run.status === "queued" || run.status === "running";
}

type DisplayMode = "runs" | "agents";

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
  displayMode?: DisplayMode;
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
  displayMode = "runs",
}: ActiveAgentsPanelProps) {
  const { data: liveRuns } = useQuery({
    queryKey: [...queryKeys.liveRuns(companyId), queryScope, { minRunCount, fetchLimit }],
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId, { minCount: minRunCount, limit: fetchLimit }),
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: displayMode === "agents",
  });

  const runs = liveRuns ?? [];

  const cards = useMemo<DashboardCard[]>(() => {
    if (displayMode === "agents") {
      return buildAgentCards(agents ?? [], runs);
    }
    return runs.map((run): DashboardCard => ({ kind: "run", id: run.id, run }));
  }, [agents, displayMode, runs]);

  const visibleCards = useMemo(() => cards.slice(0, cardLimit), [cardLimit, cards]);
  const hiddenCardCount = Math.max(0, cards.length - visibleCards.length);

  const visibleRuns = useMemo(
    () => visibleCards.map((card) => card.run).filter((run): run is LiveRunForIssue => run !== undefined),
    [visibleCards],
  );
  const { data: issues } = useQuery({
    queryKey: [...queryKeys.issues.list(companyId), "with-routine-executions"],
    queryFn: () => issuesApi.list(companyId, { includeRoutineExecutions: true }),
    enabled: visibleRuns.length > 0,
  });

  const issueById = useMemo(() => {
    const map = new Map<string, Issue>();
    for (const issue of issues ?? []) {
      map.set(issue.id, issue);
    }
    return map;
  }, [issues]);

  const { transcriptByRun, hasOutputForRun } = useLiveRunTranscripts({
    runs: visibleRuns,
    companyId,
    maxChunksPerRun: DASHBOARD_MAX_CHUNKS_PER_RUN,
    logPollIntervalMs: DASHBOARD_LOG_POLL_INTERVAL_MS,
    logReadLimitBytes: DASHBOARD_LOG_READ_LIMIT_BYTES,
    enableRealtimeUpdates: false,
  });

  const isAgentsLoading = displayMode === "agents" && agents === undefined;

  return (
    <div>
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {visibleCards.length === 0 ? (
        isAgentsLoading ? null : (
          <div className="rounded-xl border border-border p-4">
            <p className="text-sm text-muted-foreground">{emptyMessage}</p>
          </div>
        )
      ) : (
        <div className={cn("grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4", gridClassName)}>
          {visibleCards.map((card) => {
            const cardRun = card.run;
            if (cardRun) {
              return (
                <AgentRunCard
                  key={card.id}
                  companyId={companyId}
                  run={cardRun}
                  issue={cardRun.issueId ? issueById.get(cardRun.issueId) : undefined}
                  transcript={transcriptByRun.get(cardRun.id) ?? EMPTY_TRANSCRIPT}
                  hasOutput={hasOutputForRun(cardRun.id)}
                  isActive={isRunActive(cardRun)}
                  className={cardClassName}
                />
              );
            }
            if (card.kind === "agent") {
              return <AgentIdleCard key={card.id} agent={card.agent} className={cardClassName} />;
            }
            return null;
          })}
        </div>
      )}
      {showMoreLink && hiddenCardCount > 0 && (
        <div className="mt-3 flex justify-end text-xs text-muted-foreground">
          <Link to="/dashboard/live" className="hover:text-foreground hover:underline">
            {hiddenCardCount} more {displayMode === "agents" ? "agent" : "active/recent run"}
            {hiddenCardCount === 1 ? "" : "s"}
          </Link>
        </div>
      )}
    </div>
  );
}

type DashboardCard =
  | { kind: "run"; id: string; run: LiveRunForIssue; agent?: undefined }
  | { kind: "agent"; id: string; agent: Agent; run: LiveRunForIssue | undefined };

function buildAgentCards(agents: Agent[], runs: LiveRunForIssue[]): DashboardCard[] {
  const visibleAgents = agents.filter((agent) => agent.status !== "terminated");
  const latestRunByAgent = new Map<string, LiveRunForIssue>();
  for (const run of runs) {
    const existing = latestRunByAgent.get(run.agentId);
    if (!existing) {
      latestRunByAgent.set(run.agentId, run);
      continue;
    }
    if (isRunActive(run) && !isRunActive(existing)) {
      latestRunByAgent.set(run.agentId, run);
      continue;
    }
    if (isRunActive(run) === isRunActive(existing) && run.createdAt > existing.createdAt) {
      latestRunByAgent.set(run.agentId, run);
    }
  }
  const cards = visibleAgents.map<DashboardCard>((agent) => ({
    kind: "agent",
    id: agent.id,
    agent,
    run: latestRunByAgent.get(agent.id),
  }));
  cards.sort((a, b) => {
    const aActive = a.run && isRunActive(a.run) ? 1 : 0;
    const bActive = b.run && isRunActive(b.run) ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    const aHasRun = a.run ? 1 : 0;
    const bHasRun = b.run ? 1 : 0;
    if (aHasRun !== bHasRun) return bHasRun - aHasRun;
    if (a.run && b.run && a.run.createdAt !== b.run.createdAt) {
      return a.run.createdAt < b.run.createdAt ? 1 : -1;
    }
    return (a.agent?.name ?? "").localeCompare(b.agent?.name ?? "");
  });
  return cards;
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
                <span className="relative flex h-2.5 w-2.5 shrink-0">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-70" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-cyan-500" />
                </span>
              ) : (
                <span className="inline-flex h-2.5 w-2.5 rounded-full bg-muted-foreground/35" />
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

const AgentIdleCard = memo(function AgentIdleCard({
  agent,
  className,
}: {
  agent: Agent;
  className?: string;
}) {
  const idleLabel = agent.lastHeartbeatAt
    ? `Last heartbeat ${relativeTime(agent.lastHeartbeatAt)}`
    : "No recent activity";
  return (
    <div
      className={cn(
        "flex h-[320px] flex-col overflow-hidden rounded-xl border border-border bg-background/70 shadow-sm",
        className,
      )}
    >
      <div className="border-b border-border/60 px-3 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="inline-flex h-2.5 w-2.5 rounded-full bg-muted-foreground/35" />
              <Identity name={agent.name} size="sm" className="[&>span:last-child]:!text-[11px]" />
            </div>
            <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
              <span>{idleLabel}</span>
            </div>
          </div>
          <Link
            to={agentUrl(agent)}
            className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background/70 px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <ExternalLink className="h-2.5 w-2.5" />
          </Link>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-3">
        <div className="flex flex-col items-center gap-2 text-center text-xs text-muted-foreground">
          <AgentIcon icon={agent.icon} className="h-6 w-6 text-muted-foreground/60" />
          <span>Idle — no run in progress.</span>
        </div>
      </div>
    </div>
  );
});
