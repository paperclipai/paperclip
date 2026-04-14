import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { companyRoutes } from "../routes/companies.js";
import { errorHandler } from "../middleware/index.js";
import { conflict } from "../errors.js";

const mockCompanyService = vi.hoisted(() => ({
  list: vi.fn(),
  stats: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  remove: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  ensureMembership: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  cancelActiveForCompany: vi.fn(),
  cancelExecutionScopeWork: vi.fn(),
  stopRunningForCompany: vi.fn(),
  invoke: vi.fn(),
  resumeQueuedRuns: vi.fn(),
}));

const mockAgentHeartbeatModelService = vi.hoisted(() => ({
  ensureCompanyHasCooCoordinator: vi.fn(),
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

const mockExecutiveSummaryService = vi.hoisted(() => ({
  listKpis: vi.fn(),
  replaceKpis: vi.fn(),
  buildExecutiveSummary: vi.fn(),
  tickDaily: vi.fn(),
}));

const mockRoadmapEpicService = vi.hoisted(() => ({
  listPausedEpicIds: vi.fn(),
  pauseEpic: vi.fn(),
  resumeEpic: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  budgetService: () => mockBudgetService,
  agentHeartbeatModelService: () => mockAgentHeartbeatModelService,
  heartbeatService: () => mockHeartbeatService,
  companyPortabilityService: () => mockCompanyPortabilityService,
  companyService: () => mockCompanyService,
  executiveSummaryService: () => mockExecutiveSummaryService,
  roadmapEpicService: () => mockRoadmapEpicService,
  normalizeRoadmapEpicId: (roadmapId: string) => roadmapId.trim().toUpperCase(),
  feedbackService: () => mockFeedbackService,
  logActivity: mockLogActivity,
}));

function createCompany(status: "active" | "paused") {
  const now = new Date("2026-04-11T12:00:00.000Z");
  return {
    id: "company-1",
    name: "PrivateClip",
    description: null,
    status,
    pauseReason: status === "paused" ? "manual" : null,
    pausedAt: status === "paused" ? now : null,
    issuePrefix: "PAP",
    issueCounter: 101,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    requireBoardApprovalForNewAgents: false,
    feedbackDataSharingEnabled: false,
    feedbackDataSharingConsentAt: null,
    feedbackDataSharingConsentByUserId: null,
    feedbackDataSharingTermsVersion: null,
    dailyExecutiveSummaryEnabled: false,
    dailyExecutiveSummaryLastSentAt: null,
    dailyExecutiveSummaryLastStatus: null,
    dailyExecutiveSummaryLastError: null,
    brandColor: null,
    logoAssetId: null,
    logoUrl: null,
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
  app.use("/api/companies", companyRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("company pause/resume routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAgentService.list.mockResolvedValue([]);
    mockRoadmapEpicService.listPausedEpicIds.mockResolvedValue([]);
    mockRoadmapEpicService.pauseEpic.mockResolvedValue({ roadmapId: "RM-2026-Q2-01" });
    mockRoadmapEpicService.resumeEpic.mockResolvedValue({ roadmapId: "RM-2026-Q2-01" });
    mockAgentHeartbeatModelService.ensureCompanyHasCooCoordinator.mockResolvedValue({
      apply: true,
      companyId: "company-1",
      companyName: "PrivateClip",
      created: false,
      reason: "already_has_coo",
      createdAgentId: null,
    });
  });

  it("pauses a company and cancels queued, running, and deferred company work", async () => {
    const paused = createCompany("paused");
    mockCompanyService.pause.mockResolvedValue(paused);
    mockHeartbeatService.cancelExecutionScopeWork.mockResolvedValue({
      cancelledRunCount: 2,
      cancelledWakeupCount: 3,
    });

    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const response = await request(app).post("/api/companies/company-1/pause").send({});

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("paused");
    expect(mockCompanyService.pause).toHaveBeenCalledWith("company-1");
    expect(mockHeartbeatService.cancelExecutionScopeWork).toHaveBeenCalledWith(
      {
        companyId: "company-1",
        scopeType: "company",
        scopeId: "company-1",
      },
      "Cancelled due to company pause",
    );
    expect(mockHeartbeatService.cancelActiveForCompany).not.toHaveBeenCalled();
    expect(mockHeartbeatService.stopRunningForCompany).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        action: "company.paused",
        details: { cancelledRunCount: 2, cancelledWakeupCount: 3 },
      }),
    );
  });

  it("resumes a company and triggers a COO kickoff for future work", async () => {
    const active = createCompany("active");
    mockCompanyService.resume.mockResolvedValue(active);
    mockAgentService.list.mockResolvedValue([
      { id: "agent-coo-1", role: "coo", status: "idle" },
    ]);
    mockHeartbeatService.invoke.mockResolvedValue({ id: "run-1" });

    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const response = await request(app).post("/api/companies/company-1/resume").send({});

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("active");
    expect(mockCompanyService.resume).toHaveBeenCalledWith("company-1");
    expect(mockAgentHeartbeatModelService.ensureCompanyHasCooCoordinator).toHaveBeenCalledWith(
      "company-1",
      { apply: true },
    );
    expect(mockHeartbeatService.resumeQueuedRuns).toHaveBeenCalled();
    expect(mockHeartbeatService.invoke).toHaveBeenCalledWith(
      "agent-coo-1",
      "on_demand",
      expect.objectContaining({
        source: "company.resume",
        reason: "company_resumed_coo_kickoff",
        mutation: "company_resumed",
      }),
      "system",
      { actorType: "user", actorId: "user-1" },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        action: "company.resumed",
        details: {
          cooAgentId: "agent-coo-1",
          cooHeartbeatTriggered: true,
        },
      }),
    );
  });

  it("returns 409 when attempting to manually resume a budget-paused company", async () => {
    mockCompanyService.resume.mockRejectedValue(
      conflict("Company is paused because its budget hard-stop was reached."),
    );

    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const response = await request(app).post("/api/companies/company-1/resume").send({});

    expect(response.status).toBe(409);
    expect(response.body.error).toContain("budget hard-stop");
    expect(mockHeartbeatService.resumeQueuedRuns).not.toHaveBeenCalled();
  });

  it("lists paused roadmap epics for a company", async () => {
    mockRoadmapEpicService.listPausedEpicIds.mockResolvedValue([
      "RM-2026-Q2-01",
      "RM-2026-Q2-03",
    ]);

    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const response = await request(app).get("/api/companies/company-1/roadmap-epics");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      pausedEpicIds: ["RM-2026-Q2-01", "RM-2026-Q2-03"],
    });
    expect(mockRoadmapEpicService.listPausedEpicIds).toHaveBeenCalledWith("company-1");
  });

  it("pauses a roadmap epic for a company", async () => {
    mockCompanyService.getById.mockResolvedValue(createCompany("active"));

    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const response = await request(app)
      .post("/api/companies/company-1/roadmap-epics/rm-2026-q2-01/pause")
      .send({});

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ roadmapId: "RM-2026-Q2-01", paused: true });
    expect(mockRoadmapEpicService.pauseEpic).toHaveBeenCalledWith("company-1", "RM-2026-Q2-01", "user-1");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        action: "roadmap.epic.paused",
        details: {
          roadmapId: "RM-2026-Q2-01",
        },
      }),
    );
  });

  it("resumes a roadmap epic for a company and resumes queued runs", async () => {
    mockCompanyService.getById.mockResolvedValue(createCompany("active"));

    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const response = await request(app)
      .post("/api/companies/company-1/roadmap-epics/rm-2026-q2-01/resume")
      .send({});

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ roadmapId: "RM-2026-Q2-01", paused: false });
    expect(mockRoadmapEpicService.resumeEpic).toHaveBeenCalledWith("company-1", "RM-2026-Q2-01");
    expect(mockHeartbeatService.resumeQueuedRuns).toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        action: "roadmap.epic.resumed",
        details: {
          roadmapId: "RM-2026-Q2-01",
        },
      }),
    );
  });

  it("returns 404 when the company does not exist", async () => {
    mockCompanyService.pause.mockResolvedValue(null);

    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const response = await request(app).post("/api/companies/company-missing/pause").send({});

    expect(response.status).toBe(404);
    expect(response.body.error).toBe("Company not found");
    expect(mockHeartbeatService.stopRunningForCompany).not.toHaveBeenCalled();
    expect(mockHeartbeatService.cancelActiveForCompany).not.toHaveBeenCalled();
  });
});
