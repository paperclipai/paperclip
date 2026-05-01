export interface DashboardRunActivityDay {
  date: string;
  succeeded: number;
  failed: number;
  other: number;
  total: number;
}

/**
 * Daily breakdown of issues created in a 14-day window, sliced by both
 * priority and status. The dashboard charts (PriorityChart, IssueStatusChart)
 * render bars per day; this lets the server pre-aggregate so the client doesn't
 * have to ship the entire issue list.
 */
export interface DashboardIssueActivityDay {
  date: string;
  total: number;
  byPriority: Partial<Record<"critical" | "high" | "medium" | "low" | "none", number>>;
  byStatus: Partial<Record<"backlog" | "todo" | "in_progress" | "in_review" | "blocked" | "done" | "cancelled", number>>;
}

/**
 * Trimmed issue projection used by the dashboard "Recent Issues" panel and
 * by the activity feed's `entityNameMap` / `entityTitleMap` to resolve issue
 * references to identifiers and titles. Excludes description, jsonb columns,
 * labels, and run state — those are loaded on demand by IssueDetail.
 */
export interface DashboardRecentIssue {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  projectId: string | null;
  parentId: string | null;
  assigneeAgentId: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  lastActivityAt: Date | string | null;
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
