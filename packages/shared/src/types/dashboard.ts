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
    billingType: "api" | "subscription" | "mixed" | "unknown";
  };
  pendingApprovals: number;
  staleTasks: number;
  queueAging: {
    agedQueued: number;
    agedBlocked: number;
    blockerLoops: number;
    total: number;
    escalated24h: number;
  };
}
