import { describe, expect, it } from "vitest";
import { normalizeDashboardSummary } from "./dashboard";

const baseSummary = {
  companyId: "company-1",
  agents: {
    active: 1,
    running: 0,
    paused: 0,
    error: 0,
  },
  tasks: {
    open: 1,
    inProgress: 0,
    blocked: 0,
    done: 0,
  },
  costs: {
    monthSpendCents: 0,
    monthBudgetCents: 0,
    monthUtilizationPercent: 0,
  },
  pendingApprovals: 0,
  budgets: {
    activeIncidents: 0,
    pendingApprovals: 0,
    pausedAgents: 0,
    pausedProjects: 0,
  },
  runActivity: [],
};

describe("normalizeDashboardSummary", () => {
  it("defaults missing heartbeat run staleness for older dashboard API responses", () => {
    expect(normalizeDashboardSummary(baseSummary).heartbeatRunStaleness).toEqual({
      thresholdMs: 0,
      staleAgentCount: 0,
      totalStaleRunCount: 0,
      agents: [],
    });
  });

  it("preserves heartbeat run staleness when the API returns it", () => {
    const heartbeatRunStaleness = {
      thresholdMs: 300000,
      staleAgentCount: 1,
      totalStaleRunCount: 2,
      agents: [
        {
          agentId: "agent-1",
          agentName: "Agent One",
          lastHeartbeatAt: "2026-05-14T20:00:00.000Z",
          staleRunCount: 2,
        },
      ],
    };

    expect(normalizeDashboardSummary({ ...baseSummary, heartbeatRunStaleness }).heartbeatRunStaleness)
      .toBe(heartbeatRunStaleness);
  });
});
