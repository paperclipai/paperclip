import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const companyId = "22222222-2222-4222-8222-222222222222";

const mockBriefsService = vi.hoisted(() => ({
  overview: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/briefs.js", () => ({
    briefsService: () => mockBriefsService,
  }));
}

async function createApp(actor: Record<string, unknown>) {
  const [{ briefsRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/briefs.js")>("../routes/briefs.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", briefsRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("briefs routes", () => {
  beforeEach(() => {
    vi.resetModules();
    registerModuleMocks();
    vi.clearAllMocks();
    mockBriefsService.overview.mockResolvedValue({
      featureKey: "briefs",
      status: "ready",
      generatedAt: "2026-07-07T22:45:00.000Z",
      agent: {
        id: "agent-1",
        name: "Briefs Agent",
        status: "idle",
        adapterType: "codex_local",
      },
      warning: null,
      summaryItems: [],
    });
  });

  it("returns the Briefs overview for actors with company access", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app).get(`/api/companies/${companyId}/briefs/overview`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockBriefsService.overview).toHaveBeenCalledWith(companyId);
    expect(res.body).toMatchObject({ featureKey: "briefs", status: "ready" });
  });

  it("denies Briefs overview outside the actor company boundary", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: ["33333333-3333-4333-8333-333333333333"],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app).get(`/api/companies/${companyId}/briefs/overview`);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockBriefsService.overview).not.toHaveBeenCalled();
  });

  it("returns the built-in missing-agent 412 from the required Briefs agent", async () => {
    const { HttpError } = await import("../errors.js");
    mockBriefsService.overview.mockRejectedValue(new HttpError(412, "Built-in agent is not configured: briefs", {
      code: "built_in_agent_not_configured",
      key: "briefs",
      status: "not_provisioned",
      agentId: null,
      featureKeys: ["briefs"],
    }));
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app).get(`/api/companies/${companyId}/briefs/overview`);

    expect(res.status, JSON.stringify(res.body)).toBe(412);
    expect(res.body).toMatchObject({
      code: "built_in_agent_not_configured",
      details: {
        key: "briefs",
        status: "not_provisioned",
        featureKeys: ["briefs"],
      },
    });
  });
});
