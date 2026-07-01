import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const companyId = "22222222-2222-4222-8222-222222222222";

const mockService = vi.hoisted(() => ({
  overview: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/research-papers.js", () => ({
    researchPapersService: () => mockService,
  }));
}

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { researchPapersRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/research-papers.js")>("../routes/research-papers.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { actor?: unknown }).actor = actor;
    next();
  });
  app.use("/api", researchPapersRoutes({} as never));
  app.use(errorHandler);
  return app;
}

describe("research papers routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/research-papers.js");
    vi.doUnmock("../services/research-papers.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockService.overview.mockResolvedValue({
      companyId,
      generatedAt: "2026-06-29T00:00:00.000Z",
      roots: [],
      counts: { total: 0, byCategory: {}, byTone: {} },
      papers: [],
      toolbelts: [],
      safety: { readOnly: true, brokerActions: false, paidComputeActions: false, note: "read-only" },
    });
  });

  it("returns the company-scoped research-paper overview for a board actor", async () => {
    const app = await createApp({ type: "board", userId: "board-user", source: "session", isInstanceAdmin: true, companyIds: [companyId] });

    const res = await request(app).get(`/api/companies/${companyId}/research-papers`);

    expect(res.status).toBe(200);
    expect(mockService.overview).toHaveBeenCalledWith(companyId);
    expect(res.body).toMatchObject({ companyId, safety: { readOnly: true, brokerActions: false } });
  });

  it("rejects unauthenticated callers", async () => {
    const app = await createApp({ type: "none" });

    const res = await request(app).get(`/api/companies/${companyId}/research-papers`);

    expect(res.status).toBe(401);
    expect(mockService.overview).not.toHaveBeenCalled();
  });

  it("forbids board actors scoped to other companies", async () => {
    const app = await createApp({ type: "board", userId: "other", source: "session", isInstanceAdmin: false, companyIds: ["99999999-9999-4999-8999-999999999999"] });

    const res = await request(app).get(`/api/companies/${companyId}/research-papers`);

    expect(res.status).toBe(403);
    expect(mockService.overview).not.toHaveBeenCalled();
  });
});
