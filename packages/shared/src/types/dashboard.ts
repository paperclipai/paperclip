export interface DashboardRunActivityDay {
  date: string;
  succeeded: number;
  failed: number;
  /**
   * Subset of `failed` (i.e. `status === "failed" | "timed_out"`) whose
   * wall-clock spanned a host sleep boundary (e.g. macOS Sleep -> Wake).
   * These are environmental, not code failures, and can be subtracted from
   * `failed` to get a "real failures" count.
   *
   * Cancelled runs that crossed a sleep boundary are intentionally NOT
   * counted here -- they aggregate into `other`, since a cancellation is
   * already a non-failure outcome and the metric exists specifically to
   * de-noise the failure bucket. If you need a sleep-aware view of
   * cancelled runs, query `heartbeat_runs.sleep_boundary_crossed` directly.
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
