import type { IssuePriority, IssueStatus } from "../constants.js";
import type { IssueBlockerAttention } from "./issue.js";

export interface DashboardRunActivityDay {
  date: string;
  succeeded: number;
  failed: number;
  other: number;
  total: number;
}

export interface DashboardIssueActivityDay {
  date: string;
  byPriority: Record<IssuePriority, number>;
  byStatus: Record<IssueStatus, number>;
  total: number;
}

export type DashboardSourceStatus = "complete" | "partial";

export type DashboardPartialErrorSource =
  | "agents"
  | "tasks"
  | "approvals"
  | "costs"
  | "budgets"
  | "runActivity"
  | "issueActivity"
  | "recentIssues";

export interface DashboardPartialError {
  source: DashboardPartialErrorSource;
  message: string;
}

export interface DashboardRecentIssue {
  id: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  blockerAttention?: IssueBlockerAttention | null;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardSummary {
  companyId: string;
  generatedAt: string;
  sourceStatus: DashboardSourceStatus;
  partialErrors: DashboardPartialError[];
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
  };
  pendingApprovals: number;
  budgets: {
    activeIncidents: number;
    pendingApprovals: number;
    pausedAgents: number;
    pausedProjects: number;
  };
  runActivity: DashboardRunActivityDay[];
  issueActivity: DashboardIssueActivityDay[];
  recentIssues: DashboardRecentIssue[];
}
