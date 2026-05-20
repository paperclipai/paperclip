import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "@/api/agents";
import { issuesApi } from "@/api/issues";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import type { Agent, Issue, IssuePriority, IssueStatus } from "@paperclipai/shared";

// LET-484 shared command-center telemetry. The Hyperagents/Multica-style
// shell needs a small, truthful summary of the live mission/agent state to
// replace the previous all-placeholder landing. The data comes from existing
// read endpoints (`issuesApi.list`, `agentsApi.list`) which the Missions
// thin slice already wires; the Command Center reuses the same shape so the
// shell stays a single read model rather than diverging stub views.

export interface MissionTelemetryCounts {
  readonly active: number;
  readonly inReview: number;
  readonly blocked: number;
  readonly queued: number;
  readonly done: number;
  readonly cancelled: number;
  readonly total: number;
}

export interface AgentRosterSummary {
  readonly total: number;
  readonly active: number;
  readonly executing: number;
}

export interface MissionTelemetry {
  readonly missions: readonly Issue[];
  readonly counts: MissionTelemetryCounts;
  readonly criticalAttention: number;
  readonly highPriority: number;
  readonly recent: readonly Issue[];
  readonly recentlyCompleted: readonly Issue[];
  // LET-503 round-5: per-rail buckets so the dashboard can render
  // Running / Blocked / In review as separate Linear-style state rails.
  readonly running: readonly Issue[];
  readonly blocked: readonly Issue[];
  readonly inReview: readonly Issue[];
  readonly agents: AgentRosterSummary;
  readonly companyScoped: boolean;
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly refetch: () => void;
}

const ACTIVE_STATUSES = new Set<IssueStatus>(["in_progress"]);
const REVIEW_STATUSES = new Set<IssueStatus>(["in_review"]);
const QUEUED_STATUSES = new Set<IssueStatus>(["todo", "backlog"]);
const BLOCKED_STATUSES = new Set<IssueStatus>(["blocked"]);
const DONE_STATUSES = new Set<IssueStatus>(["done"]);
const CANCELLED_STATUSES = new Set<IssueStatus>(["cancelled"]);
const ATTENTION_STATUSES = new Set<IssueStatus>(["blocked", "in_review"]);
const PRIORITY_HIGH = new Set<IssuePriority>(["critical", "high"]);

function activityMs(issue: Issue): number {
  const value = issue.lastActivityAt ?? issue.updatedAt ?? issue.createdAt;
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  const parsed = new Date(value as unknown as string).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function countMissions(missions: readonly Issue[]): MissionTelemetryCounts {
  const counts = {
    active: 0,
    inReview: 0,
    blocked: 0,
    queued: 0,
    done: 0,
    cancelled: 0,
    total: missions.length,
  };
  for (const issue of missions) {
    if (ACTIVE_STATUSES.has(issue.status)) counts.active += 1;
    else if (REVIEW_STATUSES.has(issue.status)) counts.inReview += 1;
    else if (BLOCKED_STATUSES.has(issue.status)) counts.blocked += 1;
    else if (QUEUED_STATUSES.has(issue.status)) counts.queued += 1;
    else if (DONE_STATUSES.has(issue.status)) counts.done += 1;
    else if (CANCELLED_STATUSES.has(issue.status)) counts.cancelled += 1;
  }
  return counts;
}

function summarizeAgents(agents: readonly Agent[]): AgentRosterSummary {
  let active = 0;
  let executing = 0;
  for (const agent of agents) {
    if (agent.status === "active" || agent.status === "idle" || agent.status === "running") active += 1;
    if (agent.status === "running") executing += 1;
  }
  return { total: agents.length, active, executing };
}

export interface UseMissionTelemetryOptions {
  // Cap how many issues the landing pulls. The Missions list slice uses 50;
  // the Command Center landing only needs enough to summarize state + show a
  // short recent-activity list, so 75 is enough headroom without spiking the
  // read API.
  readonly pageLimit?: number;
}

export function useMissionTelemetry({ pageLimit = 75 }: UseMissionTelemetryOptions = {}): MissionTelemetry {
  const { selectedCompanyId } = useCompany();

  const issuesQuery = useQuery({
    queryKey: [
      ...(selectedCompanyId ? queryKeys.issues.list(selectedCompanyId) : ["issues", "__no-company__"]),
      "command-center-telemetry",
      pageLimit,
    ],
    queryFn: () => issuesApi.list(selectedCompanyId!, { limit: pageLimit }),
    enabled: !!selectedCompanyId,
    staleTime: 30_000,
  });

  const agentsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.agents.list(selectedCompanyId) : ["agents", "__no-company__"],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 60_000,
  });

  return useMemo<MissionTelemetry>(() => {
    const missions = issuesQuery.data ?? [];
    const counts = countMissions(missions);
    const criticalAttention = missions.filter((issue) => ATTENTION_STATUSES.has(issue.status)).length;
    const highPriority = missions.filter(
      (issue) => PRIORITY_HIGH.has(issue.priority) && issue.status !== "done" && issue.status !== "cancelled",
    ).length;
    const sortedByActivity = [...missions].sort((a, b) => activityMs(b) - activityMs(a));
    const recent = sortedByActivity
      .filter((issue) => issue.status !== "done" && issue.status !== "cancelled")
      .slice(0, 5);
    const recentlyCompleted = sortedByActivity
      .filter((issue) => issue.status === "done")
      .slice(0, 3);
    const running = sortedByActivity.filter((issue) => ACTIVE_STATUSES.has(issue.status)).slice(0, 5);
    const blocked = sortedByActivity.filter((issue) => BLOCKED_STATUSES.has(issue.status)).slice(0, 5);
    const inReview = sortedByActivity.filter((issue) => REVIEW_STATUSES.has(issue.status)).slice(0, 5);
    const agents = summarizeAgents(agentsQuery.data ?? []);
    return {
      missions,
      counts,
      criticalAttention,
      highPriority,
      recent,
      recentlyCompleted,
      running,
      blocked,
      inReview,
      agents,
      companyScoped: !!selectedCompanyId,
      isLoading: !!selectedCompanyId && issuesQuery.isLoading,
      isError: issuesQuery.isError,
      refetch: () => {
        void issuesQuery.refetch();
        void agentsQuery.refetch();
      },
    };
  }, [
    issuesQuery.data,
    issuesQuery.isLoading,
    issuesQuery.isError,
    issuesQuery.refetch,
    agentsQuery.data,
    agentsQuery.refetch,
    selectedCompanyId,
  ]);
}

export const MISSION_TELEMETRY_TEST_HELPERS = {
  countMissions,
  summarizeAgents,
  activityMs,
};
