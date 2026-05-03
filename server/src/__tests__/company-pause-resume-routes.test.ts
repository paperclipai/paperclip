import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";
import { errorHandler } from "../middleware/index.js";
import { companyRoutes } from "../routes/companies.js";

const mockCompanyService = vi.hoisted(() => ({
  pause: vi.fn(),
  resume: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  ensureMembership: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockCompanyPortabilityService = vi.hoisted(() => ({
  exportBundle: vi.fn(),
  previewExport: vi.fn(),
  previewImport: vi.fn(),
  importBundle: vi.fn(),
}));

const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(),
  listFeedbackTraces: vi.fn(),
  getFeedbackTraceById: vi.fn(),
  saveIssueVote: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  cancelActiveForAgent: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/companies.js", () => ({
  companyService: () => mockCompanyService,
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => mockAgentService,
}));

vi.mock("../services/access.js", () => ({
  accessService: () => mockAccessService,
}));

vi.mock("../services/budgets.js", () => ({
  budgetService: () => mockBudgetService,
}));

vi.mock("../services/company-portability.js", () => ({
  companyPortabilityService: () => mockCompanyPortabilityService,
}));

vi.mock("../services/feedback.js", () => ({
  feedbackService: () => mockFeedbackService,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  budgetService: () => mockBudgetService,
  companyPortabilityService: () => mockCompanyPortabilityService,
  companyService: () => mockCompanyService,
  feedbackService: () => mockFeedbackService,
  heartbeatService: () => mockHeartbeatService,
  logActivity: mockLogActivity,
}));

async function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api/companies", companyRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const companyId = "11111111-1111-4111-8111-111111111111";

describe.sequential("company pause/resume routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe.sequential("POST /:companyId/pause", () => {
    it.sequential("requires board access", async () => {
      const app = await createApp({
        type: "agent",
        agentId: "22222222-2222-4222-8222-222222222222",
        companyId,
        source: "agent_key",
        runId: "run-1",
      });

      const res = await request(app)
        .post(`/api/companies/${companyId}/pause`)
        .send({});

      expect(res.status).toBe(403);
      expect(mockCompanyService.pause).not.toHaveBeenCalled();
    });

    it.sequential("requires company access", async () => {
      const app = await createApp({
        type: "board",
        userId: "user-1",
        companyIds: ["other-company"],
        source: "session",
        isInstanceAdmin: false,
      });

      const res = await request(app)
        .post(`/api/companies/${companyId}/pause`)
        .send({});

      expect(res.status).toBe(403);
      expect(mockCompanyService.pause).not.toHaveBeenCalled();
    });

    it.sequential("returns 404 when company not found", async () => {
      const app = await createApp({
        type: "board",
        userId: "user-1",
        companyIds: [companyId],
        source: "session",
        isInstanceAdmin: false,
      });
      mockCompanyService.pause.mockResolvedValue(null);

      const res = await request(app)
        .post(`/api/companies/${companyId}/pause`)
        .send({});

      expect(res.status).toBe(404);
    });

    it.sequential("pauses company and cancels active runs for paused agents", async () => {
      const app = await createApp({
        type: "board",
        userId: "user-1",
        companyIds: [companyId],
        source: "session",
        isInstanceAdmin: false,
      });
      const pausedAgentIds = ["agent-1", "agent-2"];
      mockCompanyService.pause.mockImplementation(async (
        _companyId: string,
        _reason: string,
        options: { cancelActiveForAgent: (agentId: string) => Promise<unknown> },
      ) => {
        for (const agentId of pausedAgentIds) {
          await options.cancelActiveForAgent(agentId);
        }
        return {
          id: companyId,
          status: "paused",
          pausedAgentIds,
        };
      });
      mockHeartbeatService.cancelActiveForAgent.mockResolvedValue(null);

      const res = await request(app)
        .post(`/api/companies/${companyId}/pause`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("paused");
      expect(mockCompanyService.pause).toHaveBeenCalledWith(companyId, "manual", {
        cancelActiveForAgent: mockHeartbeatService.cancelActiveForAgent,
      });
      expect(mockHeartbeatService.cancelActiveForAgent).toHaveBeenCalledWith("agent-1");
      expect(mockHeartbeatService.cancelActiveForAgent).toHaveBeenCalledWith("agent-2");
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "company.paused",
          entityType: "company",
          entityId: companyId,
          details: { pausedAgentCount: 2 },
        }),
      );
    });

    it.sequential("returns 422 when company is already paused", async () => {
      const app = await createApp({
        type: "board",
        userId: "user-1",
        companyIds: [companyId],
        source: "session",
        isInstanceAdmin: false,
      });
      mockCompanyService.pause.mockRejectedValue(new HttpError(422, "Company is already paused"));

      const res = await request(app)
        .post(`/api/companies/${companyId}/pause`)
        .send({});

      expect(res.status).toBe(422);
      expect(res.body.error).toBe("Company is already paused");
    });
  });

  describe.sequential("POST /:companyId/resume", () => {
    it.sequential("requires board access", async () => {
      const app = await createApp({
        type: "agent",
        agentId: "22222222-2222-4222-8222-222222222222",
        companyId,
        source: "agent_key",
        runId: "run-1",
      });

      const res = await request(app)
        .post(`/api/companies/${companyId}/resume`)
        .send({});

      expect(res.status).toBe(403);
      expect(mockCompanyService.resume).not.toHaveBeenCalled();
    });

    it.sequential("returns 404 when company not found", async () => {
      const app = await createApp({
        type: "board",
        userId: "user-1",
        companyIds: [companyId],
        source: "session",
        isInstanceAdmin: false,
      });
      mockCompanyService.resume.mockResolvedValue(null);

      const res = await request(app)
        .post(`/api/companies/${companyId}/resume`)
        .send({});

      expect(res.status).toBe(404);
    });

    it.sequential("resumes company and logs activity", async () => {
      const app = await createApp({
        type: "board",
        userId: "user-1",
        companyIds: [companyId],
        source: "session",
        isInstanceAdmin: false,
      });
      const resumedAgentIds = ["agent-1", "agent-2"];
      mockCompanyService.resume.mockResolvedValue({
        id: companyId,
        status: "active",
        resumedAgentIds,
      });

      const res = await request(app)
        .post(`/api/companies/${companyId}/resume`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("active");
      expect(mockCompanyService.resume).toHaveBeenCalledWith(companyId);
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "company.resumed",
          entityType: "company",
          entityId: companyId,
          details: { resumedAgentCount: 2 },
        }),
      );
    });
  });
});
