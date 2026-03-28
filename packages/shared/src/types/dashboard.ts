export interface StarvedAgentDetail {
  agentId: string;
  agentName: string;
  runnableCount: number;
  stalledIssues: Array<{
    id: string;
    identifier: string | null;
    title: string;
    status: string;
  }>;
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
  queueStarvation: {
    starvedAgentCount: number;
    starvedAgents: StarvedAgentDetail[];
  };
}
