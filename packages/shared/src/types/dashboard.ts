export interface DashboardRunActivityDay {
  date: string;
  succeeded: number;
  failed: number;
  other: number;
  total: number;
}

/**
 * Per-agent run-rate, configured caps, and auto-pause status (WEI-209/WEI-210).
 * Surfaced on the dashboard so loops/auto-pauses are visible at a glance.
 */
export interface DashboardAgentRunCaps {
  agentId: string;
  name: string;
  role: string;
  status: string;
  runsLastHour: number;
  runsLastDay: number;
  caps: {
    perHour: number;
    perDay: number;
    maxConsecutiveRuns: number;
  };
  /** Non-null when the agent is paused; auto-pauses use the `auto:<grund> (<wert>)` format. */
  pauseReason: string | null;
  pausedAt: string | null;
  /** True when the agent is paused by the deterministic run-cap gate (`auto:` reason). */
  autoPaused: boolean;
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
  /** Per-agent run-rate + caps + auto-pause status (WEI-209/WEI-210). */
  agentRunCaps: DashboardAgentRunCaps[];
}
