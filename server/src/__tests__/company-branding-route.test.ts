import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

function createMockCompanyService() {
  return {
    list: vi.fn(),
    stats: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    archive: vi.fn(),
    remove: vi.fn(),
  };
}

function createMockAgentService() {
  return {
    getById: vi.fn(),
  };
}

function createMockAccessService() {
  return {
    ensureMembership: vi.fn(),
  };
}

function createMockBudgetService() {
  return {
    upsertPolicy: vi.fn(),
  };
}

function createMockHeartbeatService() {
  return {
    cancelActiveForCompany: vi.fn(),
    stopRunningForCompany: vi.fn(),
    invoke: vi.fn(),
    resumeQueuedRuns: vi.fn(),
  };
}

function createMockAgentHeartbeatModelService() {
  return {
    ensureCompanyHasCooCoordinator: vi.fn(),
  };
}

function createMockCompanyPortabilityService() {
  return {
    exportBundle: vi.fn(),
    previewExport: vi.fn(),
    previewImport: vi.fn(),
    importBundle: vi.fn(),
  };
}

function createMockFeedbackService() {
  return {
    listIssueVotesForUser: vi.fn(),
    listFeedbackTraces: vi.fn(),
    getFeedbackTraceById: vi.fn(),
    saveIssueVote: vi.fn(),
  };
}

function createMockExecutiveSummaryService() {
  return {
    listKpis: vi.fn(),
    replaceKpis: vi.fn(),
    buildExecutiveSummary: vi.fn(),
    tickDaily: vi.fn(),
  };
}

function createMockRoadmapEpicService() {
  return {
    listPausedEpicIds: vi.fn(),
    pauseEpic: vi.fn(),
    resumeEpic: vi.fn(),
  };
}

let mockCompanyService = createMockCompanyService();
let mockAgentService = createMockAgentService();
let mockAccessService = createMockAccessService();
let mockBudgetService = createMockBudgetService();
let mockHeartbeatService = createMockHeartbeatService();
let mockAgentHeartbeatModelService = createMockAgentHeartbeatModelService();
let mockCompanyPortabilityService = createMockCompanyPortabilityService();
let mockFeedbackService = createMockFeedbackService();
let mockExecutiveSummaryService = createMockExecutiveSummaryService();
let mockRoadmapEpicService = createMockRoadmapEpicService();
let mockLogActivity = vi.fn();
let companyRoutesFactory!: typeof import("../routes/companies.js").companyRoutes;
let errorHandlerMiddleware!: typeof import("../middleware/index.js").errorHandler;

function createCompany() {
  const now = new Date("2026-03-19T02:00:00.000Z");
  return {
    id: "company-1",
    name: "PrivateClip",
    description: null,
    status: "active",
    issuePrefix: "PAP",
    issueCounter: 568,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    requireBoardApprovalForNewAgents: false,
    dailyExecutiveSummaryEnabled: false,
    dailyExecutiveSummaryLastSentAt: null,
    dailyExecutiveSummaryLastStatus: null,
    dailyExecutiveSummaryLastError: null,
    brandColor: "#123456",
    logoAssetId: "11111111-1111-4111-8111-111111111111",
    logoUrl: "/api/assets/11111111-1111-4111-8111-111111111111/content",
    createdAt: now,
    updatedAt: now,
  };
}

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api/companies", companyRoutesFactory({} as any));
  app.use(errorHandlerMiddleware);
  return app;
}

describe.sequential("PATCH /api/companies/:companyId/branding", () => {
  beforeEach(async () => {
    vi.resetModules();
    mockCompanyService = createMockCompanyService();
    mockAgentService = createMockAgentService();
    mockAccessService = createMockAccessService();
    mockBudgetService = createMockBudgetService();
    mockHeartbeatService = createMockHeartbeatService();
    mockAgentHeartbeatModelService = createMockAgentHeartbeatModelService();
    mockCompanyPortabilityService = createMockCompanyPortabilityService();
    mockFeedbackService = createMockFeedbackService();
    mockExecutiveSummaryService = createMockExecutiveSummaryService();
    mockRoadmapEpicService = createMockRoadmapEpicService();
    mockLogActivity = vi.fn(async () => undefined);

    vi.doMock("../services/index.js", () => ({
      accessService: () => mockAccessService,
      agentService: () => mockAgentService,
      agentHeartbeatModelService: () => mockAgentHeartbeatModelService,
      budgetService: () => mockBudgetService,
      heartbeatService: () => mockHeartbeatService,
      companyPortabilityService: () => mockCompanyPortabilityService,
      companyService: () => mockCompanyService,
      executiveSummaryService: () => mockExecutiveSummaryService,
      roadmapEpicService: () => mockRoadmapEpicService,
      normalizeRoadmapEpicId: (roadmapId: string) => roadmapId.trim().toUpperCase(),
      feedbackService: () => mockFeedbackService,
      logActivity: mockLogActivity,
    }));
    ({ companyRoutes: companyRoutesFactory } = await import("../routes/companies.js"));
    ({ errorHandler: errorHandlerMiddleware } = await import("../middleware/index.js"));
  });

  it.sequential("rejects non-CEO agent callers", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      role: "engineer",
    });
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .patch("/api/companies/company-1/branding")
      .send({ logoAssetId: "11111111-1111-4111-8111-111111111111" });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Only CEO agents");
    expect(mockCompanyService.update).not.toHaveBeenCalled();
  });

  it.sequential("allows CEO agent callers to update branding fields", async () => {
    const company = createCompany();
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      role: "ceo",
    });
    mockCompanyService.update.mockResolvedValue(company);
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .patch("/api/companies/company-1/branding")
      .send({
        logoAssetId: "11111111-1111-4111-8111-111111111111",
        brandColor: "#123456",
      });

    expect(res.status).toBe(200);
    expect(res.body.logoAssetId).toBe(company.logoAssetId);
    expect(mockCompanyService.update).toHaveBeenCalledWith("company-1", {
      logoAssetId: "11111111-1111-4111-8111-111111111111",
      brandColor: "#123456",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        actorType: "agent",
        actorId: "agent-1",
        agentId: "agent-1",
        runId: "run-1",
        action: "company.branding_updated",
        details: {
          logoAssetId: "11111111-1111-4111-8111-111111111111",
          brandColor: "#123456",
        },
      }),
    );
  });

  it.sequential("allows board callers to update branding fields", async () => {
    const company = createCompany();
    mockCompanyService.update.mockResolvedValue({
      ...company,
      brandColor: null,
      logoAssetId: null,
      logoUrl: null,
    });
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .patch("/api/companies/company-1/branding")
      .send({ brandColor: null, logoAssetId: null });

    expect(res.status).toBe(200);
    expect(res.body.brandColor).toBeNull();
    expect(res.body.logoAssetId).toBeNull();
  });

  it.sequential("rejects non-branding fields in the request body", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .patch("/api/companies/company-1/branding")
      .send({
        logoAssetId: "11111111-1111-4111-8111-111111111111",
        status: "archived",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
    expect(mockCompanyService.update).not.toHaveBeenCalled();
  });
});
