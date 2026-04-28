export interface DashboardRunActivityDay {
  date: string;
  succeeded: number;
  failed: number;
  /**
   * Subset of `failed` whose wall-clock spanned a host sleep boundary
   * (e.g. macOS Sleep -> Wake). These are environmental, not code failures
   * and can be subtracted from `failed` to get a "real failures" count.
   */
  sleepBoundaryFailed: number;
  other: number;
  total: number;
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
