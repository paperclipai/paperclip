import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { issuesApi } from "../api/issues";
import { activityApi } from "../api/activity";
import { queryKeys } from "../lib/queryKeys";
import { useCompany } from "../context/CompanyContext";
import { cn } from "../lib/utils";
import type { Agent, Issue } from "@paperclipai/shared";

const CYCLE_MONITOR_AGENT_ID = "bc38280d-26c3-4097-8427-9e72412ebf7b";
const FACTORY_FM_TITLE_REGEX = /^(FACTORY\/)?FM\d+/i;
const CYCLE_RUN_TITLE_REGEX = /^Cycle Run #\d+$/;
const ACTIVE_AGENT_WINDOW_MS = 15 * 60 * 1000;
const REFRESH_INTERVAL_MS = 60_000;
const BOARD_USER_ID = "local-board";

type SignalTone = "green" | "amber" | "red" | "gray";

function getSignalClasses(tone: SignalTone): string {
  switch (tone) {
    case "green":
      return "bg-emerald-50 text-emerald-900 border-emerald-300 hover:bg-emerald-100";
    case "amber":
      return "bg-amber-50 text-amber-900 border-amber-300 hover:bg-amber-100";
    case "red":
      return "bg-red-50 text-red-900 border-red-300 hover:bg-red-100";
    case "gray":
    default:
      return "bg-muted text-muted-foreground border-border hover:bg-muted/80";
  }
}

export function countFactoryManagementIssues(issues: Issue[]): number {
  return issues.filter((issue) => FACTORY_FM_TITLE_REGEX.test(issue.title.trim())).length;
}

export function getLatestCompletedCycleIssue(issues: Issue[]): Issue | null {
  return issues.find(
    (issue) =>
      CYCLE_RUN_TITLE_REGEX.test(issue.title.trim())
      && (issue.status === "done" || issue.status === "blocked" || issue.status === "cancelled"),
  ) ?? null;
}

export function getBoardAgentIds(agents: Agent[]): Set<string> {
  const boardIds = new Set<string>([BOARD_USER_ID]);
  for (const agent of agents) {
    const metadata = agent.metadata as Record<string, unknown> | null;
    const agentType = typeof metadata?.agentType === "string" ? metadata.agentType : null;
    const role = typeof metadata?.role === "string" ? metadata.role : null;
    if (agentType === "local-board" || role === "local-board" || agent.urlKey === "local-board") {
      boardIds.add(agent.id);
    }
  }
  return boardIds;
}

export function countActiveAgentsInWindow(
  events: { actorType: string; actorId: string; createdAt: string | Date }[],
  agents: Agent[],
  nowMs: number = Date.now(),
): number {
  const threshold = nowMs - ACTIVE_AGENT_WINDOW_MS;
  const boardAgentIds = getBoardAgentIds(agents);
  const activeAgentIds = new Set<string>();

  for (const event of events) {
    if (event.actorType !== "agent") continue;
    if (!event.actorId || boardAgentIds.has(event.actorId)) continue;
    const createdAtMs = new Date(event.createdAt).getTime();
    if (!Number.isFinite(createdAtMs) || createdAtMs <= threshold) continue;
    activeAgentIds.add(event.actorId);
  }

  return activeAgentIds.size;
}

interface FactoryHealthBadgeProps {
  companyId: string;
  agents: Agent[];
}

function SignalPill({
  to,
  title,
  label,
  value,
  tone,
}: {
  to: string;
  title: string;
  label: string;
  value: string;
  tone: SignalTone;
}) {
  return (
    <Link
      to={to}
      title={title}
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        getSignalClasses(tone),
      )}
    >
      <span>{label}</span>
      <span className="font-semibold">{value}</span>
    </Link>
  );
}

export function FactoryHealthBadge({ companyId, agents }: FactoryHealthBadgeProps) {
  const { selectedCompany } = useCompany();
  const prefix = selectedCompany?.issuePrefix ?? "";

  const commonQueryOptions = {
    staleTime: REFRESH_INTERVAL_MS,
    refetchInterval: REFRESH_INTERVAL_MS,
    enabled: Boolean(companyId),
  } as const;

  const { data: fmIssues = [] } = useQuery({
    queryKey: queryKeys.factoryHealth.fmIssues(companyId),
    queryFn: () =>
      issuesApi.list(companyId, {
        status: "todo,in_progress,blocked",
        limit: 500,
      }),
    ...commonQueryOptions,
  });

  const { data: cycleIssues = [] } = useQuery({
    queryKey: queryKeys.factoryHealth.latestCycle(companyId),
    queryFn: () =>
      issuesApi.list(companyId, {
        assigneeAgentId: CYCLE_MONITOR_AGENT_ID,
        q: "Cycle Run",
        limit: 20,
      }),
    ...commonQueryOptions,
  });

  const { data: activityEvents = [] } = useQuery({
    queryKey: queryKeys.factoryHealth.activeAgents(companyId),
    queryFn: () =>
      activityApi.list(companyId, {
        limit: 500,
      }),
    ...commonQueryOptions,
  });

  const fmCount = useMemo(() => countFactoryManagementIssues(fmIssues), [fmIssues]);
  const latestCycle = useMemo(() => getLatestCompletedCycleIssue(cycleIssues), [cycleIssues]);
  const activeAgentsCount = useMemo(
    () => countActiveAgentsInWindow(activityEvents, agents),
    [activityEvents, agents],
  );

  const fmTone: SignalTone = fmCount === 0 ? "green" : fmCount <= 3 ? "amber" : "red";
  const cycleTone: SignalTone = latestCycle
    ? latestCycle.status === "done"
      ? "green"
      : "red"
    : "gray";
  const activeAgentsTone: SignalTone = activeAgentsCount > 0 ? "green" : "gray";

  const cycleIssueRef = latestCycle?.identifier ?? latestCycle?.id;

  return (
    <div className="flex w-full flex-wrap items-center gap-2">
      <SignalPill
        to={`/${prefix}/issues?status=todo,in_progress,blocked`}
        title="Open factory management issues"
        label="Open FM"
        value={String(fmCount)}
        tone={fmTone}
      />
      <SignalPill
        to={cycleIssueRef ? `/${prefix}/issues/${cycleIssueRef}` : `/${prefix}/issues`}
        title="Last completed cycle status"
        label="Last cycle"
        value={latestCycle ? (latestCycle.status === "done" ? "Pass" : "Fail") : "Unknown"}
        tone={cycleTone}
      />
      <SignalPill
        to={`/${prefix}/agents`}
        title="Active agents in last 15 minutes"
        label="Active agents (15m)"
        value={String(activeAgentsCount)}
        tone={activeAgentsTone}
      />
    </div>
  );
}
