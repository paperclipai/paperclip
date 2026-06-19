import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";

const mockWorkflowService = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  getDetail: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  runManual: vi.fn(),
  getRunDetail: vi.fn(),
  cancelRun: vi.fn(),
  getHandoff: vi.fn(),
  resolveHandoff: vi.fn(),
  verifyRuntimeToken: vi.fn(),
  applyPhaseEvent: vi.fn(),
  createRuntimeHandoff: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  workflowService: () => mockWorkflowService,
  logActivity: vi.fn(),
}));

import { workflowRoutes } from "../routes/workflows.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
      memberships: [{ companyId, status: "active", membershipRole: "admin" }],
    };
    next();
  });
  app.use("/api", workflowRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("workflow routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 404 when a runtime phase event targets an unknown phase key", async () => {
    mockWorkflowService.verifyRuntimeToken.mockResolvedValue(true);
    mockWorkflowService.applyPhaseEvent.mockResolvedValue(null);

    const res = await request(createApp())
      .post(`/api/workflow-runs/${runId}/runtime/phase-events`)
      .send({
        token: "runtime-token",
        phaseKey: "missing-phase",
        status: "running",
      });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Workflow phase not found for key: missing-phase" });
    expect(mockWorkflowService.applyPhaseEvent).toHaveBeenCalledWith(runId, {
      phaseKey: "missing-phase",
      status: "running",
    });
  });

  it("cancels a workflow run", async () => {
    mockWorkflowService.getRunDetail.mockResolvedValue({
      id: runId,
      companyId,
      status: "running",
      workflow: { id: "workflow-1", title: "Social", status: "active", runnerType: "google_adk" },
      phases: [],
      handoffs: [],
      deliverables: [],
    });
    mockWorkflowService.cancelRun.mockResolvedValue({
      id: runId,
      companyId,
      status: "cancelled",
    });

    const res = await request(createApp())
      .post(`/api/workflow-runs/${runId}/cancel`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: runId, status: "cancelled" });
    expect(mockWorkflowService.cancelRun).toHaveBeenCalledWith(runId, { userId: "board-user" });
  });
});
