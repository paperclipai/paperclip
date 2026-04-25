import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

function createServiceMocks() {
  const companyService = {
    list: vi.fn(),
    stats: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    archive: vi.fn(),
    remove: vi.fn(),
  };
  const agentService = {
    getById: vi.fn(),
  };
  const accessService = {
    ensureMembership: vi.fn(),
  };
  const budgetService = {
    upsertPolicy: vi.fn(),
  };
  const heartbeatService = {
    cancelActiveForCompany: vi.fn(),
    stopRunningForCompany: vi.fn(),
    invoke: vi.fn(),
    resumeQueuedRuns: vi.fn(),
  };
  const agentHeartbeatModelService = {
    ensureCompanyHasCooCoordinator: vi.fn(),
  };
  const companyPortabilityService = {
    exportBundle: vi.fn(),
    previewExport: vi.fn(),
    previewImport: vi.fn(),
    importBundle: vi.fn(),
  };
  const companyShellStateService = {
    get: vi.fn(),
  };
  const executiveSummaryService = {
    listKpis: vi.fn(),
    replaceKpis: vi.fn(),
    buildExecutiveSummary: vi.fn(),
    tickDaily: vi.fn(),
  };
  const feedbackService = {
    listIssueVotesForUser: vi.fn(),
    listFeedbackTraces: vi.fn(),
    getFeedbackTraceById: vi.fn(),
    saveIssueVote: vi.fn(),
  };
  const issueService = {
    countUnreadTouchedByUser: vi.fn(),
  };
  const roadmapEpicService = {
    listPausedEpicIds: vi.fn(),
    pauseEpic: vi.fn(),
    resumeEpic: vi.fn(),
  };
  const logActivity = vi.fn();

  return {
    accessService,
    agentHeartbeatModelService,
    agentService,
    budgetService,
    companyPortabilityService,
    companyService,
    companyShellStateService,
    executiveSummaryService,
    feedbackService,
    heartbeatService,
    issueService,
    logActivity,
    roadmapEpicService,
  };
}

type CompanyKpiRouteMocks = ReturnType<typeof createServiceMocks>;

function applyDefaultMocks(mocks: CompanyKpiRouteMocks) {
  mocks.agentService.getById.mockResolvedValue(null);
  mocks.accessService.ensureMembership.mockResolvedValue(undefined);
  mocks.budgetService.upsertPolicy.mockResolvedValue(undefined);
  mocks.heartbeatService.cancelActiveForCompany.mockResolvedValue(undefined);
  mocks.heartbeatService.stopRunningForCompany.mockResolvedValue(undefined);
  mocks.heartbeatService.invoke.mockResolvedValue(undefined);
  mocks.heartbeatService.resumeQueuedRuns.mockResolvedValue(undefined);
  mocks.agentHeartbeatModelService.ensureCompanyHasCooCoordinator.mockResolvedValue(undefined);
  mocks.companyPortabilityService.exportBundle.mockResolvedValue(undefined);
  mocks.companyPortabilityService.previewExport.mockResolvedValue(undefined);
  mocks.companyPortabilityService.previewImport.mockResolvedValue(undefined);
  mocks.companyPortabilityService.importBundle.mockResolvedValue(undefined);
  mocks.companyShellStateService.get.mockResolvedValue(null);
  mocks.executiveSummaryService.listKpis.mockResolvedValue([]);
  mocks.executiveSummaryService.replaceKpis.mockResolvedValue([]);
  mocks.executiveSummaryService.buildExecutiveSummary.mockResolvedValue({
    companyId: "company-1",
    companyName: "PrivateClip",
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
  mocks.executiveSummaryService.tickDaily.mockResolvedValue(undefined);
  mocks.feedbackService.listIssueVotesForUser.mockResolvedValue([]);
  mocks.feedbackService.listFeedbackTraces.mockResolvedValue([]);
  mocks.feedbackService.getFeedbackTraceById.mockResolvedValue(null);
  mocks.feedbackService.saveIssueVote.mockResolvedValue(undefined);
  mocks.issueService.countUnreadTouchedByUser.mockResolvedValue(0);
  mocks.roadmapEpicService.listPausedEpicIds.mockResolvedValue([]);
  mocks.roadmapEpicService.pauseEpic.mockResolvedValue(undefined);
  mocks.roadmapEpicService.resumeEpic.mockResolvedValue(undefined);
  mocks.logActivity.mockResolvedValue(undefined);
}

async function createHarness(actor: Record<string, unknown>) {
  vi.resetModules();
  const mocks = createServiceMocks();
  applyDefaultMocks(mocks);
  vi.doMock("../services/index.js", () => ({
    accessService: () => mocks.accessService,
    agentHeartbeatModelService: () => mocks.agentHeartbeatModelService,
    agentService: () => mocks.agentService,
    budgetService: () => mocks.budgetService,
    companyPortabilityService: () => mocks.companyPortabilityService,
    companyService: () => mocks.companyService,
    companyShellStateService: () => mocks.companyShellStateService,
    executiveSummaryService: () => mocks.executiveSummaryService,
    feedbackService: () => mocks.feedbackService,
    heartbeatService: () => mocks.heartbeatService,
    issueService: () => mocks.issueService,
    logActivity: mocks.logActivity,
    normalizeRoadmapEpicId: (roadmapId: string) => roadmapId.trim().toUpperCase(),
    roadmapEpicService: () => mocks.roadmapEpicService,
  }));

  const [{ companyRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/companies.js"),
    import("../middleware/index.js"),
  ]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api/companies", companyRoutes({} as any));
  app.use(errorHandler);

  return { app, mocks };
}

afterEach(() => {
  vi.doUnmock("../services/index.js");
});

describe.sequential("company KPI routes", () => {
  it.sequential("allows board users to list and replace KPIs", async () => {
    const { app, mocks } = await createHarness({
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

    expect(mocks.executiveSummaryService.listKpis).toHaveBeenCalledWith("company-1");
    expect(mocks.executiveSummaryService.replaceKpis).toHaveBeenCalledWith(
      "company-1",
      [{ label: "MRR", value: "$12,000", trend: "up", note: "week over week" }],
      { userId: "user-1", agentId: null },
    );
    expect(mocks.logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "company.kpis.updated",
        companyId: "company-1",
      }),
    );
  });

  it.sequential("allows board users to fetch executive summary payload", async () => {
    const { app, mocks } = await createHarness({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const response = await request(app).get("/api/companies/company-1/executive-summary");
    expect(response.status).toBe(200);
    expect(mocks.executiveSummaryService.buildExecutiveSummary).toHaveBeenCalledWith("company-1");
  });

  it.sequential("allows CEO agents to manage KPIs for their own company", async () => {
    const { app, mocks } = await createHarness({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });
    mocks.agentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      role: "ceo",
    });

    await request(app)
      .put("/api/companies/company-1/kpis")
      .send({
        kpis: [{ label: "NPS", value: "61", trend: "flat" }],
      })
      .expect(200);
  });

  it.sequential("rejects non-CEO agents from managing KPIs", async () => {
    const { app, mocks } = await createHarness({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });
    mocks.agentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      role: "engineer",
    });

    const response = await request(app)
      .put("/api/companies/company-1/kpis")
      .send({
        kpis: [{ label: "NPS", value: "61", trend: "flat" }],
      });

    expect(response.status).toBe(403);
    expect(response.body.error).toContain("Only CEO agents");
    expect(mocks.executiveSummaryService.replaceKpis).not.toHaveBeenCalled();
  });

  it.sequential("rejects non-CEO agents from reading executive summary payloads", async () => {
    const { app, mocks } = await createHarness({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });
    mocks.agentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      role: "engineer",
    });

    const response = await request(app).get("/api/companies/company-1/executive-summary");
    expect(response.status).toBe(403);
    expect(mocks.executiveSummaryService.buildExecutiveSummary).not.toHaveBeenCalled();
  });

  it.sequential("rejects cross-company agent access for KPI endpoints", async () => {
    const { app, mocks } = await createHarness({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-2",
      source: "agent_key",
      runId: "run-1",
    });
    mocks.agentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-2",
      role: "ceo",
    });

    const response = await request(app).get("/api/companies/company-1/kpis");
    expect(response.status).toBe(403);
    expect(response.body.error).toContain("cannot access another company");
    expect(mocks.executiveSummaryService.listKpis).not.toHaveBeenCalled();
  });

  it.sequential("allows board users to patch daily executive summary toggle", async () => {
    const { app, mocks } = await createHarness({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });
    mocks.companyService.getById.mockResolvedValue({
      id: "company-1",
      feedbackDataSharingEnabled: false,
    });
    mocks.companyService.update.mockResolvedValue({
      id: "company-1",
      dailyExecutiveSummaryEnabled: true,
    });

    const response = await request(app)
      .patch("/api/companies/company-1")
      .send({ dailyExecutiveSummaryEnabled: true });

    expect(response.status).toBe(200);
    expect(mocks.companyService.update).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ dailyExecutiveSummaryEnabled: true }),
    );
  });

  it.sequential("does not allow CEO agents to patch daily executive summary toggle", async () => {
    const { app, mocks } = await createHarness({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });
    mocks.companyService.getById.mockResolvedValue({
      id: "company-1",
      feedbackDataSharingEnabled: false,
    });
    mocks.agentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      role: "ceo",
    });

    const response = await request(app)
      .patch("/api/companies/company-1")
      .send({ dailyExecutiveSummaryEnabled: true });

    expect(response.status).toBe(400);
    expect(mocks.companyService.update).not.toHaveBeenCalled();
  });
});
