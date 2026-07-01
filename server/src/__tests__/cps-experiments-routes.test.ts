import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const companyId = "22222222-2222-4222-8222-222222222222";

const mockService = vi.hoisted(() => ({
  overview: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/cps-experiments.js", () => ({
    cpsExperimentsService: () => mockService,
  }));
}

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { cpsExperimentRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/cps-experiments.js")>("../routes/cps-experiments.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { actor?: unknown }).actor = actor;
    next();
  });
  app.use("/api", cpsExperimentRoutes({} as never));
  app.use(errorHandler);
  return app;
}

describe("CPS experiment routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/cps-experiments.js");
    vi.doUnmock("../services/cps-experiments.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockService.overview.mockResolvedValue({
      companyId,
      generatedAt: "2026-07-01T00:00:00.000Z",
      source: { indexPath: "/tmp/EXPERIMENTS_INDEX.json", present: true, stale: false, ageSeconds: 1, schema: "cps.experiment_index.v1", root: "/tmp" },
      counts: { total: 0, byKind: {}, byStatus: {}, byDecision: {}, strategyByDecision: {}, evalByVerdict: {} },
      recent: [],
      entries: [],
      safety: { readOnly: true, brokerActions: false, paidComputeActions: false, paidDataActions: false, signalPublishing: false, note: "read-only" },
    });
  });

  it("returns the company-scoped experiment overview for a board actor", async () => {
    const app = await createApp({ type: "board", userId: "board-user", source: "session", isInstanceAdmin: true, companyIds: [companyId] });

    const res = await request(app).get(`/api/companies/${companyId}/cps-experiments`);

    expect(res.status).toBe(200);
    expect(mockService.overview).toHaveBeenCalledWith(companyId);
    expect(res.body).toMatchObject({ companyId, safety: { readOnly: true, brokerActions: false, paidDataActions: false } });
  });

  it("rejects unauthenticated callers", async () => {
    const app = await createApp({ type: "none" });

    const res = await request(app).get(`/api/companies/${companyId}/cps-experiments`);

    expect(res.status).toBe(401);
    expect(mockService.overview).not.toHaveBeenCalled();
  });

  it("forbids board actors scoped to other companies", async () => {
    const app = await createApp({ type: "board", userId: "other", source: "session", isInstanceAdmin: false, companyIds: ["99999999-9999-4999-8999-999999999999"] });

    const res = await request(app).get(`/api/companies/${companyId}/cps-experiments`);

    expect(res.status).toBe(403);
    expect(mockService.overview).not.toHaveBeenCalled();
  });
});
