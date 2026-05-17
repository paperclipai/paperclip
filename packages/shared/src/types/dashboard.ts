export interface DashboardRunActivityDay {
  date: string;
  succeeded: number;
  failed: number;
  other: number;
  total: number;
}

export interface DashboardSummary {
  companyId: string;
  agents: {
    /** Canonical run-state taxonomy counts (ZERA-579 / ZERA-580). */
    working: number;
    idle: number;
    paused: number;
    suspended: number;
    error: number;
    /**
     * Orthogonal liveness flag: agents with no heartbeat within the dormant
     * threshold. Counted as a subset of their primary state (typically `idle`),
     * surfaced separately as an operator triage signal.
     */
    dormant: number;
    /**
     * @deprecated One-release alias for `idle`. The metric was previously
     * mislabeled `active` even though it counted idle agents (ZERA-579).
     * Remove after clients migrate.
     */
    active: number;
    /**
     * @deprecated One-release alias for `working`. Renamed from `running` per
     * the canonical taxonomy. Remove after clients migrate.
     */
    running: number;
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
