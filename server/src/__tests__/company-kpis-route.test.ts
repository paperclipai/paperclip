import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { companyRoutes } from "../routes/companies.js";
import { errorHandler } from "../middleware/index.js";

const mockCompanyService = vi.hoisted(() => ({
  list: vi.fn(),
  stats: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
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

const mockExecutiveSummaryService = vi.hoisted(() => ({
  listKpis: vi.fn(),
  replaceKpis: vi.fn(),
  buildExecutiveSummary: vi.fn(),
  tickDaily: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(),
  listFeedbackTraces: vi.fn(),
  getFeedbackTraceById: vi.fn(),
  saveIssueVote: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  budgetService: () => mockBudgetService,
  companyPortabilityService: () => mockCompanyPortabilityService,
  companyService: () => mockCompanyService,
  executiveSummaryService: () => mockExecutiveSummaryService,
  feedbackService: () => mockFeedbackService,
  logActivity: mockLogActivity,
}));

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

describe("company KPI routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockExecutiveSummaryService.listKpis.mockResolvedValue([]);
    mockExecutiveSummaryService.replaceKpis.mockResolvedValue([]);
    mockExecutiveSummaryService.buildExecutiveSummary.mockResolvedValue({
      companyId: "company-1",
      companyName: "Paperclip",
      generatedAt: new Date("2026-04-11T08:00:00.000Z"),
      periodStart: new Date("2026-04-10T08:00:00.000Z"),
      periodEnd: new Date("2026-04-11T08:00:00.000Z"),
      manualKpis: [],
      computedKpis: {
        monthSpendCents: 0,
        monthBudgetCents: 0,
        monthUtilizationPercent: 0,
        tasksOpen: 0,
        tasksInProgress: 0,
        tasksBlocked: 0,
        tasksDone: 0,
        pendingApprovals: 0,
        activeBudgetIncidents: 0,
        pausedAgents: 0,
        pausedProjects: 0,
      },
      topChanges: {
        issueTransitions: [],
        failedRuns: [],
        pendingApprovals: 0,
      },
      dispatch: {
        enabled: false,
        lastSentAt: null,
        lastStatus: null,
        lastError: null,
        recipients: [],
      },
    });
  });

  it("allows board users to list and replace KPIs", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    await request(app).get("/api/companies/company-1/kpis").expect(200);

    await request(app)
      .put("/api/companies/company-1/kpis")
      .send({
        kpis: [{ label: "MRR", value: "$12,000", trend: "up", note: "week over week" }],
      })
      .expect(200);

    expect(mockExecutiveSummaryService.listKpis).toHaveBeenCalledWith("company-1");
    expect(mockExecutiveSummaryService.replaceKpis).toHaveBeenCalledWith(
      "company-1",
      [{ label: "MRR", value: "$12,000", trend: "up", note: "week over week" }],
      { userId: "user-1", agentId: null },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "company.kpis.updated",
        companyId: "company-1",
      }),
    );
  });

  it("allows board users to fetch executive summary payload", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const response = await request(app).get("/api/companies/company-1/executive-summary");
    expect(response.status).toBe(200);
    expect(mockExecutiveSummaryService.buildExecutiveSummary).toHaveBeenCalledWith("company-1");
  });

  it("allows CEO agents to manage KPIs for their own company", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      role: "ceo",
    });
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    await request(app)
      .put("/api/companies/company-1/kpis")
      .send({
        kpis: [{ label: "NPS", value: "61", trend: "flat" }],
      })
      .expect(200);
  });

  it("rejects non-CEO agents from managing KPIs", async () => {
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

    const response = await request(app)
      .put("/api/companies/company-1/kpis")
      .send({
        kpis: [{ label: "NPS", value: "61", trend: "flat" }],
      });

    expect(response.status).toBe(403);
    expect(response.body.error).toContain("Only CEO agents");
    expect(mockExecutiveSummaryService.replaceKpis).not.toHaveBeenCalled();
  });

  it("rejects non-CEO agents from reading executive summary payloads", async () => {
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

    const response = await request(app).get("/api/companies/company-1/executive-summary");
    expect(response.status).toBe(403);
    expect(mockExecutiveSummaryService.buildExecutiveSummary).not.toHaveBeenCalled();
  });

  it("rejects cross-company agent access for KPI endpoints", async () => {
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-2",
      source: "agent_key",
      runId: "run-1",
    });

    const response = await request(app).get("/api/companies/company-1/kpis");
    expect(response.status).toBe(403);
    expect(response.body.error).toContain("cannot access another company");
  });

  it("allows board users to patch daily executive summary toggle", async () => {
    mockCompanyService.getById.mockResolvedValue({
      id: "company-1",
      feedbackDataSharingEnabled: false,
    });
    mockCompanyService.update.mockResolvedValue({
      id: "company-1",
      dailyExecutiveSummaryEnabled: true,
    });
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const response = await request(app)
      .patch("/api/companies/company-1")
      .send({ dailyExecutiveSummaryEnabled: true });

    expect(response.status).toBe(200);
    expect(mockCompanyService.update).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ dailyExecutiveSummaryEnabled: true }),
    );
  });

  it("does not allow CEO agents to patch daily executive summary toggle", async () => {
    mockCompanyService.getById.mockResolvedValue({
      id: "company-1",
      feedbackDataSharingEnabled: false,
    });
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      role: "ceo",
    });
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const response = await request(app)
      .patch("/api/companies/company-1")
      .send({ dailyExecutiveSummaryEnabled: true });

    expect(response.status).toBe(400);
    expect(mockCompanyService.update).not.toHaveBeenCalled();
  });
});
