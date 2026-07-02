import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const companyId = "22222222-2222-4222-8222-222222222222";

const mockService = vi.hoisted(() => ({
  overview: vi.fn(),
  createRunRequest: vi.fn(),
  createJudgmentFeedback: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../services/cps-experiments.js", () => ({
    cpsExperimentsService: () => mockService,
  }));
  vi.doMock("../services/index.js", () => ({
    logActivity: mockLogActivity,
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
    vi.doUnmock("../services/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockService.overview.mockResolvedValue({
      companyId,
      generatedAt: "2026-07-01T00:00:00.000Z",
      source: { indexPath: "/tmp/EXPERIMENTS_INDEX.json", present: true, stale: false, ageSeconds: 1, schema: "cps.experiment_index.v1", root: "/tmp" },
      counts: { total: 0, byKind: {}, byStatus: {}, byDecision: {}, strategyByDecision: {}, evalByVerdict: {}, judgmentByResultVerdict: {}, judgmentByPromotionVerdict: {}, judgmentByDataFit: {}, judgmentByRulesDisclosure: {} },
      recent: [],
      entries: [],
      safety: { readOnly: true, brokerActions: false, paidComputeActions: false, paidDataActions: false, signalPublishing: false, note: "read-only" },
    });
    mockService.createRunRequest.mockResolvedValue({
      schema: "cps.paperclip_run_request.v1",
      id: "req-1",
      companyId,
      action: "investigate_near_miss",
      experimentId: "exp-1",
      prompt: "Investigate safely",
      requestedAt: "2026-07-01T00:00:00.000Z",
      requestedBy: "board",
      status: "queued",
      maxRuntimeMinutes: 30,
      safety: { brokerActions: false, signalPublishing: false, allowPaidData: false, allowPaidCompute: false, note: "safe" },
      path: "/tmp/req-1.json",
      queuePath: "/tmp/QUEUE.jsonl",
    });
    mockService.createJudgmentFeedback.mockResolvedValue({
      schema: "cps.judgment_feedback.v1",
      id: "label-1",
      companyId,
      experimentId: "exp-1",
      label: "agree",
      correctedVerdict: null,
      routeToRole: null,
      comment: null,
      createdAt: "2026-07-01T00:00:00.000Z",
      createdBy: "board",
      judgmentPath: "/tmp/exp-1/JUDGMENT.json",
      path: "/tmp/label-1.json",
      queuePath: "/tmp/LABELS.jsonl",
    });
    mockLogActivity.mockResolvedValue(undefined);
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

  it("lets board users queue bounded CPS run requests and logs the mutation", async () => {
    const app = await createApp({ type: "board", userId: "board-user", source: "session", isInstanceAdmin: true, companyIds: [companyId] });

    const res = await request(app)
      .post(`/api/companies/${companyId}/cps-experiments/run-requests`)
      .send({ action: "investigate_near_miss", experimentId: "exp-1", prompt: "Investigate safely with local data only." });

    expect(res.status).toBe(202);
    expect(mockService.createRunRequest).toHaveBeenCalledWith(companyId, expect.objectContaining({ action: "investigate_near_miss", experimentId: "exp-1" }));
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "cps.run_request.queued", entityId: "req-1" }));
    expect(res.body).toMatchObject({ id: "req-1", safety: { brokerActions: false, signalPublishing: false } });
  });

  it("lets board users persist judgment feedback labels and logs the mutation", async () => {
    const app = await createApp({ type: "board", userId: "board-user", source: "session", isInstanceAdmin: true, companyIds: [companyId] });

    const res = await request(app)
      .post(`/api/companies/${companyId}/cps-experiments/judgment-feedback`)
      .send({ experimentId: "exp-1", label: "agree" });

    expect(res.status).toBe(201);
    expect(mockService.createJudgmentFeedback).toHaveBeenCalledWith(companyId, expect.objectContaining({ experimentId: "exp-1", label: "agree" }));
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "cps.judgment_label.created", entityId: "label-1" }));
    expect(res.body).toMatchObject({ id: "label-1", schema: "cps.judgment_feedback.v1", label: "agree" });
  });

  it("forwards correction fields and logs routeToRole", async () => {
    const app = await createApp({ type: "board", userId: "board-user", source: "session", isInstanceAdmin: true, companyIds: [companyId] });
    mockService.createJudgmentFeedback.mockResolvedValueOnce({
      schema: "cps.judgment_feedback.v1",
      id: "label-2",
      companyId,
      experimentId: "exp-1",
      label: "wrong_blocker",
      correctedVerdict: "DATA_BLOCKED",
      routeToRole: "data_engineering",
      comment: "Needs constituents data.",
      createdAt: "2026-07-02T00:00:00.000Z",
      createdBy: "board",
      judgmentPath: "/tmp/exp-1/JUDGMENT.json",
      path: "/tmp/label-2.json",
      queuePath: "/tmp/LABELS.jsonl",
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/cps-experiments/judgment-feedback`)
      .send({ experimentId: "exp-1", label: "wrong_blocker", correctedVerdict: "DATA_BLOCKED", routeToRole: "data_engineering", comment: "Needs constituents data." });

    expect(res.status).toBe(201);
    expect(mockService.createJudgmentFeedback).toHaveBeenCalledWith(companyId, expect.objectContaining({ routeToRole: "data_engineering", correctedVerdict: "DATA_BLOCKED" }));
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "cps.judgment_label.created",
      entityId: "label-2",
      details: expect.objectContaining({ routeToRole: "data_engineering", correctedVerdict: "DATA_BLOCKED" }),
    }));
    expect(res.body).toMatchObject({ id: "label-2", routeToRole: "data_engineering" });
  });
});
