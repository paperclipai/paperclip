export interface DashboardRunActivityDay {
  date: string;
  succeeded: number;
  failed: number;
  other: number;
  total: number;
}

export interface DashboardAttentionApproval {
  kind: "approval";
  id: string;
  type: string;
  status: string;
  title: string;
  summary: string | null;
  requestedByAgentId: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface DashboardAttentionInteraction {
  kind: "interaction";
  id: string;
  interactionKind: string;
  status: string;
  title: string;
  summary: string | null;
  issueId: string;
  issueIdentifier: string | null;
  issueTitle: string;
  createdByAgentId: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
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
  attention: {
    approvals: DashboardAttentionApproval[];
    interactions: DashboardAttentionInteraction[];
    total: number;
  };
  runActivity: DashboardRunActivityDay[];
}
