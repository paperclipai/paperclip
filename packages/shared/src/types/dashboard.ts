import type { IssuePriority, IssueStatus } from "../constants.js";

export interface DashboardRunActivityDay {
  date: string;
  succeeded: number;
  failed: number;
  other: number;
  total: number;
}

/**
 * Daily breakdown of issues bucketed by their `createdAt` day. `byPriority`
 * and `byStatus` reflect each issue's *current* priority/status against the
 * day it was created — they are not historical state-on-day-X. Producer
 * zero-fills every enum key, so consumers can iterate without optional
 * chaining.
 */
export interface DashboardIssueActivityDay {
  date: string;
  total: number;
  byPriority: Record<IssuePriority, number>;
  byStatus: Record<IssueStatus, number>;
}

/**
 * Trimmed issue projection used by the dashboard "Recent Issues" panel
 * (renders the top 10) and the activity feed's id->identifier/title lookup
 * map. Omits description, labels, and runtime state; the full issue is
 * fetched on demand from the issue-detail endpoint.
 */
export interface DashboardRecentIssue {
  id: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  projectId: string | null;
  parentId: string | null;
  assigneeAgentId: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastActivityAt: Date;
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
