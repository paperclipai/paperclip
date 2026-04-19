import type { CostWorkValueSummary } from "./cost.js";

export interface DashboardStaleIssueSummary {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  staleReason: "blocked" | "inactive";
  updatedAt: Date;
  latestCommentAt: Date | null;
  latestActivityAt: Date | null;
  lastMovementAt: Date;
  activeRunId: string | null;
}

export interface DashboardRecentActivitySummary {
  id: string;
  companyId: string;
  actorType: "agent" | "user" | "system";
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  agentId: string | null;
  runId: string | null;
  details: Record<string, unknown> | null;
  createdAt: Date;
  issueIdentifier: string | null;
  issueTitle: string | null;
}

export interface DashboardLiveRunSummary {
  id: string;
  status: string;
  invocationSource: string;
  triggerDetail: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  agentId: string;
  agentName: string;
  adapterType: string;
  issueId: string | null;
}

export interface DashboardSummary {
  companyId: string;
  agents: {
    active: number;
    running: number;
    paused: number;
    error: number;
  };
  tasks: {
    open: number;
    inProgress: number;
    blocked: number;
    done: number;
  };
  costs: {
    monthSpendCents: number;
    monthBudgetCents: number;
    monthUtilizationPercent: number;
    workValue: CostWorkValueSummary;
  };
  pendingApprovals: number;
  budgets: {
    activeIncidents: number;
    pendingApprovals: number;
    pausedAgents: number;
    pausedProjects: number;
  };
  staleIssues?: DashboardStaleIssueSummary[];
  recentActivity?: DashboardRecentActivitySummary[];
  liveRuns?: DashboardLiveRunSummary[];
}
