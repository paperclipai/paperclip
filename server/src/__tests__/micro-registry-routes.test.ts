import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const companyId = "22222222-2222-4222-8222-222222222222";
const podId = "33333333-3333-4333-8333-333333333333";
const experimentId = "44444444-4444-4444-8444-444444444444";
const issueId = "55555555-5555-4555-8555-555555555555";
const agentId = "66666666-6666-4666-8666-666666666666";

const mockRegistryService = vi.hoisted(() => ({
  overview: vi.fn(),
  createPod: vi.fn(),
  createExperiment: vi.fn(),
  updateExperimentVerdict: vi.fn(),
  createDependencyRequest: vi.fn(),
  createEvidencePack: vi.fn(),
  createPromotionRequest: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/micro-registry.js", () => ({
    microRegistryService: () => mockRegistryService,
  }));
}

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { microRegistryRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/micro-registry.js")>("../routes/micro-registry.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", microRegistryRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("micro registry routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/micro-registry.js");
    vi.doUnmock("../services/micro-registry.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockRegistryService.overview.mockResolvedValue({ pods: [], experiments: [], dependencyRequests: [], evidencePacks: [], promotionRequests: [] });
    mockRegistryService.createPod.mockResolvedValue({
      id: podId,
      companyId,
      paperclipIssueId: issueId,
      identifier: "MPOD-TEST",
      title: "Test pod",
      source: "operator",
      thesis: "A test thesis",
      ownerAgentId: agentId,
      lifecycleState: "draft",
      improvementAttemptCount: 0,
      dependencies: [],
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
    });
    mockRegistryService.createExperiment.mockResolvedValue({
      id: experimentId,
      companyId,
      podId,
      paperclipIssueId: issueId,
      identifier: "MEXP-TEST",
      title: "Test experiment",
      hypothesis: "Lead-lag exists",
      sourceKind: "paper",
      sourceUrl: "https://example.com/paper",
      lifecycleState: "draft",
      maxImprovementAttempts: 5,
      improvementAttemptCount: 0,
      overnightAllowed: false,
      holdingPeriodMinMinutes: 1,
      holdingPeriodMaxMinutes: null,
      metrics: {},
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
    });
    mockRegistryService.updateExperimentVerdict.mockResolvedValue({ id: experimentId, companyId, verdict: "kill", verdictReason: "No edge after five improvements", lifecycleState: "killed" });
    mockRegistryService.createDependencyRequest.mockResolvedValue({ id: "77777777-7777-4777-8777-777777777777", companyId, podId, experimentId, kind: "data", title: "Need tick data", status: "open" });
    mockRegistryService.createEvidencePack.mockResolvedValue({ id: "88888888-8888-4888-8888-888888888888", companyId, podId, experimentId, title: "Evidence", artifactUri: "file:///tmp/evidence.md", status: "draft" });
    mockRegistryService.createPromotionRequest.mockResolvedValue({ id: "99999999-9999-4999-8999-999999999999", companyId, podId, experimentId, target: "paper_broker_review", status: "requested", rationale: "Shadow metrics passed" });
  });

  it("returns the company-scoped micro registry overview", async () => {
    const app = await createApp({ type: "board", userId: "board-user", source: "session", isInstanceAdmin: true, companyIds: [companyId] });

    const res = await request(app).get(`/api/companies/${companyId}/micro-registry`);

    expect(res.status).toBe(200);
    expect(mockRegistryService.overview).toHaveBeenCalledWith(companyId);
    expect(res.body).toMatchObject({ pods: [], experiments: [] });
  });

  it("creates pods with board access and forwards the actor for audit fields", async () => {
    const app = await createApp({ type: "board", userId: "board-user", source: "session", isInstanceAdmin: true, companyIds: [companyId] });

    const res = await request(app).post(`/api/companies/${companyId}/micro-registry/pods`).send({
      paperclipIssueId: issueId,
      identifier: "MPOD-TEST",
      title: "Test pod",
      source: "operator",
      thesis: "A test thesis",
      ownerAgentId: agentId,
    });

    expect(res.status).toBe(201);
    expect(mockRegistryService.createPod).toHaveBeenCalledWith(companyId, expect.objectContaining({ identifier: "MPOD-TEST" }), expect.objectContaining({ userId: "board-user" }));
    expect(res.body).toMatchObject({ id: podId, lifecycleState: "draft", improvementAttemptCount: 0 });
  });

  it("creates day-trading experiments with no overnight exposure by default", async () => {
    const app = await createApp({ type: "board", userId: "board-user", source: "session", isInstanceAdmin: true, companyIds: [companyId] });

    const res = await request(app).post(`/api/companies/${companyId}/micro-registry/pods/${podId}/experiments`).send({
      paperclipIssueId: issueId,
      identifier: "MEXP-TEST",
      title: "Test experiment",
      hypothesis: "Lead-lag exists",
      sourceKind: "paper",
      sourceUrl: "https://example.com/paper",
    });

    expect(res.status).toBe(201);
    expect(mockRegistryService.createExperiment).toHaveBeenCalledWith(companyId, podId, expect.objectContaining({ identifier: "MEXP-TEST" }), expect.objectContaining({ userId: "board-user" }));
    expect(res.body).toMatchObject({ overnightAllowed: false, maxImprovementAttempts: 5, holdingPeriodMinMinutes: 1 });
  });

  it("records verdicts after improvement attempts finish", async () => {
    const app = await createApp({ type: "board", userId: "board-user", source: "session", isInstanceAdmin: true, companyIds: [companyId] });

    const res = await request(app).patch(`/api/companies/${companyId}/micro-registry/experiments/${experimentId}/verdict`).send({
      verdict: "kill",
      verdictReason: "No edge after five improvements",
      lifecycleState: "killed",
    });

    expect(res.status).toBe(200);
    expect(mockRegistryService.updateExperimentVerdict).toHaveBeenCalledWith(companyId, experimentId, expect.objectContaining({ verdict: "kill" }));
    expect(res.body).toMatchObject({ verdict: "kill", lifecycleState: "killed" });
  });

  it("creates dependency requests, evidence packs, and promotion requests as explicit records", async () => {
    const app = await createApp({ type: "board", userId: "board-user", source: "session", isInstanceAdmin: true, companyIds: [companyId] });

    const dependency = await request(app).post(`/api/companies/${companyId}/micro-registry/dependency-requests`).send({
      podId,
      experimentId,
      kind: "data",
      title: "Need tick data",
      description: "Need validated tick data before execution review",
    });
    expect(dependency.status).toBe(201);
    expect(mockRegistryService.createDependencyRequest).toHaveBeenCalledWith(companyId, expect.objectContaining({ kind: "data", title: "Need tick data" }));

    const evidence = await request(app).post(`/api/companies/${companyId}/micro-registry/evidence-packs`).send({
      podId,
      experimentId,
      title: "Evidence",
      artifactUri: "file:///tmp/evidence.md",
    });
    expect(evidence.status).toBe(201);
    expect(mockRegistryService.createEvidencePack).toHaveBeenCalledWith(companyId, expect.objectContaining({ artifactUri: "file:///tmp/evidence.md" }));

    const promotion = await request(app).post(`/api/companies/${companyId}/micro-registry/promotion-requests`).send({
      podId,
      experimentId,
      target: "paper_broker_review",
      rationale: "Shadow metrics passed",
    });
    expect(promotion.status).toBe(201);
    expect(mockRegistryService.createPromotionRequest).toHaveBeenCalledWith(companyId, expect.objectContaining({ target: "paper_broker_review" }));
  });

  it("blocks cross-company reads", async () => {
    const app = await createApp({ type: "board", userId: "board-user", source: "session", isInstanceAdmin: false, companyIds: ["99999999-9999-4999-8999-999999999999"] });

    const res = await request(app).get(`/api/companies/${companyId}/micro-registry`);

    expect(res.status).toBe(403);
    expect(mockRegistryService.overview).not.toHaveBeenCalled();
  });
});
