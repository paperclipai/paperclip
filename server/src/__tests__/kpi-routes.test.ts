import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock kpiService
// ---------------------------------------------------------------------------
const mockKpiService = vi.hoisted(() => ({
  compute: vi.fn(),
  saveSnapshot: vi.fn(),
  listSnapshots: vi.fn(),
}));

vi.mock("../services/kpi.js", () => ({
  kpiService: () => mockKpiService,
}));

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------
async function createApp(companyId = "company-1") {
  const [{ errorHandler }, { kpiRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/kpi.js"),
  ]);
  const app = express();
  app.use(express.json());
  // Inject a board actor with access to companyId
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", kpiRoutes({} as any));
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const COMPANY_ID = "company-1";

const stubReport = {
  companyId: COMPANY_ID,
  windowDays: 7,
  windowStart: "2026-04-07T00:00:00.000Z",
  computedAt: "2026-04-14T00:00:00.000Z",
  kpis: {
    tokensPerCompletedTask: { value: 12000, unit: "tokens" },
    costPerCompletedTaskCents: { value: 40, unit: "cents" },
    cacheHitRate: { value: 0.72, unit: "ratio" },
    budgetUtilizationEfficiency: { value: 2.5, unit: "tasks/$1" },
    heartbeatSuccessRate: { value: 0.95, unit: "ratio" },
    taskFirstAttemptSuccessRate: { value: 0.8, unit: "ratio" },
    meanRetryCount: { value: 0.2, unit: "retries/task" },
    taskCycleTimeSeconds: { value: 3600, unit: "seconds" },
    delegationDepthAvg: { value: 1.2, unit: "depth" },
    checkoutConflictRate: { value: null, unit: "ratio", note: "Conflict 409s are not persisted" },
    blockedTaskRatio: { value: 0.05, unit: "ratio" },
    humanInterventionRate: { value: 0.1, unit: "ratio" },
    autonomousCompletionRate: { value: 0.9, unit: "ratio" },
    traceCoverage: { value: 1.0, unit: "ratio" },
    meanTimeToDiagnoseSeconds: { value: null, unit: "seconds", note: "Not derivable" },
  },
  agentBreakdown: [],
};

const stubSnapshot = {
  id: "snap-1",
  companyId: COMPANY_ID,
  windowDays: 7,
  kpisJson: stubReport,
  computedAt: "2026-04-14T00:00:00.000Z",
  createdAt: "2026-04-14T00:00:00.000Z",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("GET /api/companies/:companyId/kpi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockKpiService.compute.mockResolvedValue(stubReport);
  });

  it("returns 200 with KPI report for default 7-day window", async () => {
    const app = await createApp();
    const res = await request(app).get(`/api/companies/${COMPANY_ID}/kpi`);

    expect(res.status).toBe(200);
    expect(res.body.companyId).toBe(COMPANY_ID);
    expect(res.body.windowDays).toBe(7);
    expect(res.body.kpis).toBeDefined();
    expect(mockKpiService.compute).toHaveBeenCalledWith(COMPANY_ID, 7);
  });

  it("respects windowDays query param", async () => {
    const app = await createApp();
    const res = await request(app).get(`/api/companies/${COMPANY_ID}/kpi?windowDays=30`);

    expect(res.status).toBe(200);
    expect(mockKpiService.compute).toHaveBeenCalledWith(COMPANY_ID, 30);
  });

  it("returns 400 for invalid windowDays", async () => {
    const app = await createApp();
    const res = await request(app).get(`/api/companies/${COMPANY_ID}/kpi?windowDays=999`);
    expect(res.status).toBe(400);
  });

  it("returns 400 for non-numeric windowDays", async () => {
    const app = await createApp();
    const res = await request(app).get(`/api/companies/${COMPANY_ID}/kpi?windowDays=abc`);
    expect(res.status).toBe(400);
  });

  it("returns 403 for mismatched companyId", async () => {
    // Use session-authenticated actor (not local_implicit) so companyIds whitelist is enforced.
    const { errorHandler } = await import("../middleware/index.js");
    const { kpiRoutes } = await import("../routes/kpi.js");
    const restrictedApp = express();
    restrictedApp.use(express.json());
    restrictedApp.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "user-1",
        companyIds: ["company-1"],
        source: "session",
        isInstanceAdmin: false,
      };
      next();
    });
    restrictedApp.use("/api", kpiRoutes({} as any));
    restrictedApp.use(errorHandler);

    const res = await request(restrictedApp).get("/api/companies/other-company/kpi");
    expect(res.status).toBe(403);
  });

  it("report includes all 15 KPIs", async () => {
    const app = await createApp();
    const res = await request(app).get(`/api/companies/${COMPANY_ID}/kpi`);

    expect(res.status).toBe(200);
    const kpiKeys = Object.keys(res.body.kpis);
    expect(kpiKeys).toContain("tokensPerCompletedTask");
    expect(kpiKeys).toContain("costPerCompletedTaskCents");
    expect(kpiKeys).toContain("cacheHitRate");
    expect(kpiKeys).toContain("budgetUtilizationEfficiency");
    expect(kpiKeys).toContain("heartbeatSuccessRate");
    expect(kpiKeys).toContain("taskFirstAttemptSuccessRate");
    expect(kpiKeys).toContain("meanRetryCount");
    expect(kpiKeys).toContain("taskCycleTimeSeconds");
    expect(kpiKeys).toContain("delegationDepthAvg");
    expect(kpiKeys).toContain("checkoutConflictRate");
    expect(kpiKeys).toContain("blockedTaskRatio");
    expect(kpiKeys).toContain("humanInterventionRate");
    expect(kpiKeys).toContain("autonomousCompletionRate");
    expect(kpiKeys).toContain("traceCoverage");
    expect(kpiKeys).toContain("meanTimeToDiagnoseSeconds");
    expect(kpiKeys).toHaveLength(15);
  });
});

describe("POST /api/companies/:companyId/kpi/snapshots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockKpiService.saveSnapshot.mockResolvedValue({ snapshot: stubSnapshot, report: stubReport });
  });

  it("returns 201 with snapshot and report", async () => {
    const app = await createApp();
    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/kpi/snapshots`)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.snapshot.id).toBe("snap-1");
    expect(res.body.report.kpis).toBeDefined();
    expect(mockKpiService.saveSnapshot).toHaveBeenCalledWith(COMPANY_ID, 7);
  });

  it("passes custom windowDays to saveSnapshot", async () => {
    const app = await createApp();
    await request(app)
      .post(`/api/companies/${COMPANY_ID}/kpi/snapshots`)
      .send({ windowDays: 14 });

    expect(mockKpiService.saveSnapshot).toHaveBeenCalledWith(COMPANY_ID, 14);
  });

  it("returns 400 for invalid windowDays in body", async () => {
    const app = await createApp();
    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/kpi/snapshots`)
      .send({ windowDays: 100 });

    expect(res.status).toBe(400);
  });
});

describe("GET /api/companies/:companyId/kpi/snapshots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockKpiService.listSnapshots.mockResolvedValue([stubSnapshot]);
  });

  it("returns 200 with snapshot list", async () => {
    const app = await createApp();
    const res = await request(app).get(`/api/companies/${COMPANY_ID}/kpi/snapshots`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].id).toBe("snap-1");
    expect(mockKpiService.listSnapshots).toHaveBeenCalledWith(COMPANY_ID, { limit: 12 });
  });

  it("respects limit query param", async () => {
    const app = await createApp();
    await request(app).get(`/api/companies/${COMPANY_ID}/kpi/snapshots?limit=4`);
    expect(mockKpiService.listSnapshots).toHaveBeenCalledWith(COMPANY_ID, { limit: 4 });
  });

  it("returns 400 for invalid limit", async () => {
    const app = await createApp();
    const res = await request(app).get(`/api/companies/${COMPANY_ID}/kpi/snapshots?limit=100`);
    expect(res.status).toBe(400);
  });
});
