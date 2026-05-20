export interface DashboardRunActivityDay {
  date: string;
  succeeded: number;
  failed: number;
  other: number;
  total: number;
}

export type DashboardTokenUsageRange = "daily" | "weekly" | "monthly";

export interface DashboardTokenUsageBucket {
  key: string;
  label: string;
  startAt: string;
  endAt: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  runCount: number;
}

export interface DashboardTokenUsageSummary {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  runCount: number;
}

export interface DashboardTokenUsage {
  companyId: string;
  range: DashboardTokenUsageRange;
  scope: {
    type: "all_agents" | "single_agent";
    agentId: string | null;
    agentName: string | null;
    label: string;
  };
  timezone: "UTC";
  windowStartAt: string;
  windowEndAt: string;
  generatedAt: string;
  totals: DashboardTokenUsageSummary;
  buckets: DashboardTokenUsageBucket[];
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
}
