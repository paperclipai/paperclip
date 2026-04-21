import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDashboardService = vi.hoisted(() => ({
  summary: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/dashboard.js", () => ({
    dashboardService: () => mockDashboardService,
  }));
  vi.doMock("../services/dashboard.ts", () => ({
    dashboardService: () => mockDashboardService,
  }));
  vi.doMock("../routes/authz.js", async () =>
    vi.importActual<typeof import("../routes/authz.ts")>("../routes/authz.ts"),
  );
  vi.doMock("../routes/authz.ts", async () =>
    vi.importActual<typeof import("../routes/authz.ts")>("../routes/authz.ts"),
  );
  vi.doMock("../middleware/index.js", async () =>
    vi.importActual<typeof import("../middleware/index.ts")>("../middleware/index.ts"),
  );
  vi.doMock("../middleware/index.ts", async () =>
    vi.importActual<typeof import("../middleware/index.ts")>("../middleware/index.ts"),
  );
  vi.doMock("../middleware/logger.js", async () =>
    vi.importActual<typeof import("../middleware/logger.ts")>("../middleware/logger.ts"),
  );
  vi.doMock("../middleware/logger.ts", async () =>
    vi.importActual<typeof import("../middleware/logger.ts")>("../middleware/logger.ts"),
  );
}

let dashboardRouteImportSeq = 0;

async function createApp(actor: Record<string, unknown>) {
  vi.resetModules();
  vi.doUnmock("../services/dashboard.js");
  vi.doUnmock("../services/dashboard.ts");
  vi.doUnmock("../routes/dashboard.js");
  vi.doUnmock("../routes/dashboard.ts");
  vi.doUnmock("../routes/authz.js");
  vi.doUnmock("../routes/authz.ts");
  vi.doUnmock("../middleware/index.js");
  vi.doUnmock("../middleware/index.ts");
  vi.doUnmock("../middleware/logger.js");
  vi.doUnmock("../middleware/logger.ts");
  registerModuleMocks();
  dashboardRouteImportSeq += 1;
  const routeModulePath = `../routes/dashboard.ts?dashboard-routes-${dashboardRouteImportSeq}`;
  const [{ errorHandler }, { dashboardRoutes }] = await Promise.all([
    import("../middleware/index.ts"),
    import(routeModulePath) as Promise<typeof import("../routes/dashboard.ts")>,
  ]);
  const app = express();
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", dashboardRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("dashboard routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/dashboard.js");
    vi.doUnmock("../services/dashboard.ts");
    vi.doUnmock("../routes/dashboard.js");
    vi.doUnmock("../routes/dashboard.ts");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../routes/authz.ts");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../middleware/index.ts");
    vi.doUnmock("../middleware/logger.js");
    vi.doUnmock("../middleware/logger.ts");
    registerModuleMocks();
    vi.resetAllMocks();
  });

  it("allows same-company agents to read the dashboard summary", async () => {
    mockDashboardService.summary.mockResolvedValue({
      companyId: "company-1",
      agents: { active: 1, running: 0, paused: 0, error: 0 },
      tasks: { open: 1, inProgress: 0, blocked: 0, done: 0 },
      costs: {
        monthSpendCents: 0,
        monthBudgetCents: 0,
        monthUtilizationPercent: 0,
        workValue: {
          companyId: "company-1",
          totalTokens: 0,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          aiSpendCents: 0,
          estimatedDevHours: 0,
          estimatedDevValueCents: 0,
          estimatedSavingsCents: 0,
          roiMultiple: 0,
          devValueHourlyRateCents: 15000,
          devValueTokensPerHour: 100000,
        },
      },
      pendingApprovals: 0,
      budgets: { activeIncidents: 0, pendingApprovals: 0, pausedAgents: 0, pausedProjects: 0 },
      staleIssues: [],
      recentActivity: [],
      liveRuns: [],
    });

    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
    });
    const res = await request(app).get("/api/companies/company-1/dashboard");

    expect(res.status).toBe(200);
    expect(mockDashboardService.summary).toHaveBeenCalledWith("company-1");
    expect(res.body.companyId).toBe("company-1");
  });

  it("rejects agents that target another company", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
    });
    const res = await request(app).get("/api/companies/company-2/dashboard");

    expect(res.status).toBe(403);
    expect(mockDashboardService.summary).not.toHaveBeenCalled();
  });
});
