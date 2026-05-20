import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDashboardService = vi.hoisted(() => ({
  summary: vi.fn(),
  tokenUsage: vi.fn(),
}));

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/dashboard.js", () => ({
    dashboardService: () => mockDashboardService,
  }));
  vi.doMock("../services/index.js", () => ({
    companyService: () => mockCompanyService,
    companyPortabilityService: () => ({}),
    accessService: () => ({}),
    budgetService: () => ({}),
    agentService: () => ({}),
    feedbackService: () => ({}),
  }));
}

async function createApp(actor: Record<string, unknown>, mountBoth = false) {
  const [
    { companyRoutes },
    { dashboardRoutes },
    { errorHandler }
  ] = await Promise.all([
    import("../routes/companies.js"),
    import("../routes/dashboard.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as never;
    next();
  });

  const api = express.Router();
  if (mountBoth) {
    // Mount exactly as it is in server/src/app.ts
    api.use("/companies", companyRoutes({} as any));
    api.use("/companies", dashboardRoutes({} as any));
  } else {
    api.use("/companies", dashboardRoutes({} as any));
  }

  app.use("/api", api);
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "API route not found" });
  });
  app.use(errorHandler);
  return app;
}

describe("dashboard routing", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/dashboard.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/companies.js");
    vi.doUnmock("../routes/dashboard.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockDashboardService.summary.mockResolvedValue({ totalRuns: 10 });
    mockDashboardService.tokenUsage.mockResolvedValue({ buckets: [], totals: { input: 0, output: 0, costCents: 0 } });
    mockCompanyService.getById.mockResolvedValue({ id: "company-1", name: "Test Company" });
  });

  it("can access dashboard summary route (isolated)", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    }, false);

    const res = await request(app).get("/api/companies/company-1/dashboard");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ totalRuns: 10 });
    expect(mockDashboardService.summary).toHaveBeenCalledWith("company-1");
  });

  it("can access token usage route (isolated)", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    }, false);

    const res = await request(app).get("/api/companies/company-1/dashboard/token-usage?range=daily");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ buckets: [], totals: { input: 0, output: 0, costCents: 0 } });
    expect(mockDashboardService.tokenUsage).toHaveBeenCalledWith("company-1", { range: "daily", agentId: null });
  });

  it("can access token usage route when both companyRoutes and dashboardRoutes are mounted as in app.ts", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    }, true);

    const res = await request(app).get("/api/companies/company-1/dashboard/token-usage?range=daily");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ buckets: [], totals: { input: 0, output: 0, costCents: 0 } });
  });
});
