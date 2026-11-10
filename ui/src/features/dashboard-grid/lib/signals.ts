export interface DashboardSignalInput {
  summary?: {
    agents: { running: number; error: number };
    pendingApprovals: number;
    budgets: { pendingApprovals: number };
  } | null;
  liveRuns?: ReadonlyArray<{ status: string }> | null;
  agents?: ReadonlyArray<{ status: string }> | null;
}

const LIVE_RUN_STATUSES = new Set(["running", "queued"]);

export function deriveDashboardSignals(input: DashboardSignalInput): Record<string, boolean> {
  const { summary, liveRuns, agents } = input;
  return {
    "live-runs": (summary?.agents.running ?? 0) > 0
      || (liveRuns ?? []).some((run) => LIVE_RUN_STATUSES.has(run.status))
      || (agents ?? []).some((agent) => agent.status === "running"),
    "agent-errors": (summary?.agents.error ?? 0) > 0 || (agents ?? []).some((agent) => agent.status === "error"),
    "pending-approvals": (summary?.pendingApprovals ?? 0) + (summary?.budgets.pendingApprovals ?? 0) > 0,
  };
}
