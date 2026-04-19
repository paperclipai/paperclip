import { describe, expect, it, vi } from "vitest";
const mockOverview = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    activeIncidents: [],
    pendingApprovalCount: 2,
    pausedAgentCount: 1,
    pausedProjectCount: 0,
  }),
);

vi.mock("../services/budgets.js", () => ({
  budgetService: () => ({
    overview: mockOverview,
  }),
}));

function createDbWithMissingCompany() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([]),
      })),
    })),
  };
}

describe("services/dashboard.ts", () => {
  it("throws notFound when company is missing", async () => {
    const { dashboardService } = await import("../services/dashboard.js");
    const service = dashboardService(createDbWithMissingCompany() as any);
    await expect(service.summary("missing-company")).rejects.toThrow("Company not found");
  });

  it("computes dashboard aggregates for agent/task/cost buckets", async () => {
    const company = [{ id: "company-1", budgetMonthlyCents: 1000 }];
    const agentRows = [
      { status: "idle", count: 2 },
      { status: "running", count: 1 },
      { status: "paused", count: 1 },
    ];
    const taskRows = [
      { status: "todo", count: 2 },
      { status: "in_progress", count: 1 },
      { status: "blocked", count: 1 },
      { status: "done", count: 3 },
      { status: "cancelled", count: 1 },
    ];
    const pendingApprovals = [{ count: 4 }];
    const monthSpend = [{ monthSpend: 250 }];
    let call = 0;
    const select = vi.fn(() => {
      call += 1;
      if (call === 1) {
        return {
          from: vi.fn(() => ({
            where: vi.fn().mockResolvedValue(company),
          })),
        };
      }
      if (call === 2) {
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              groupBy: vi.fn().mockResolvedValue(agentRows),
            })),
          })),
        };
      }
      if (call === 3) {
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              groupBy: vi.fn().mockResolvedValue(taskRows),
            })),
          })),
        };
      }
      if (call === 4) {
        return {
          from: vi.fn(() => ({
            where: vi.fn().mockResolvedValue(pendingApprovals),
          })),
        };
      }
      return {
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue(monthSpend),
        })),
      };
    });
    const db = { select };
    const { dashboardService } = await import("../services/dashboard.js");
    const service = dashboardService(db as any);

    const summary = await service.summary("company-1");
    expect(summary).toMatchObject({
      companyId: "company-1",
      agents: {
        active: 2,
        running: 1,
        paused: 1,
        error: 0,
      },
      tasks: {
        open: 4,
        inProgress: 1,
        blocked: 1,
        done: 3,
      },
      costs: {
        monthSpendCents: 250,
        monthBudgetCents: 1000,
        monthUtilizationPercent: 25,
      },
      pendingApprovals: 4,
      budgets: {
        activeIncidents: 0,
        pendingApprovals: 2,
        pausedAgents: 1,
        pausedProjects: 0,
      },
    });
  });
});

