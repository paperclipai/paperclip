import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { companyRoutes } from "../routes/companies.js";

const mockCompanyService = vi.hoisted(() => ({
  list: vi.fn(),
  stats: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
}));

const mockCompanyShellStateService = vi.hoisted(() => ({
  listRailState: vi.fn(),
  getInboxSummary: vi.fn(),
  getRunActivity: vi.fn(),
}));
const mockIssueService = vi.hoisted(() => ({
  countUnreadTouchedByUser: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  companyService: () => mockCompanyService,
  companyShellStateService: () => mockCompanyShellStateService,
  companyPortabilityService: () => ({
    exportBundle: vi.fn(),
    previewExport: vi.fn(),
    previewImport: vi.fn(),
    importBundle: vi.fn(),
  }),
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
    ensureMembership: vi.fn(),
  }),
  budgetService: () => ({
    upsertPolicy: vi.fn(),
  }),
  heartbeatService: () => ({
    cancelActiveForCompany: vi.fn(),
    stopRunningForCompany: vi.fn(),
    invoke: vi.fn(),
    resumeQueuedRuns: vi.fn(),
  }),
  agentHeartbeatModelService: () => ({
    ensureCompanyHasCooCoordinator: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  roadmapEpicService: () => ({
    listPausedEpicIds: vi.fn(),
    pauseEpic: vi.fn(),
    resumeEpic: vi.fn(),
  }),
  normalizeRoadmapEpicId: (roadmapId: string) => roadmapId.trim().toUpperCase(),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(),
    listFeedbackTraces: vi.fn(),
    getFeedbackTraceById: vi.fn(),
    saveIssueVote: vi.fn(),
  }),
  executiveSummaryService: () => ({
    listKpis: vi.fn(),
    replaceKpis: vi.fn(),
    buildExecutiveSummary: vi.fn(),
    tickDaily: vi.fn(),
  }),
  issueService: () => mockIssueService,
  logActivity: vi.fn(),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1", "company-2", "company-3"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api/companies", companyRoutes({} as never));
  app.use(errorHandler);
  return app;
}

describe.sequential("company shell state routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.countUnreadTouchedByUser.mockResolvedValue(2);
    mockCompanyService.list.mockResolvedValue([
      { id: "company-1", name: "One", status: "active" },
      { id: "company-2", name: "Two", status: "paused" },
      { id: "company-3", name: "Three", status: "archived" },
    ]);
    mockCompanyShellStateService.listRailState.mockResolvedValue([
      { companyId: "company-1", inboxCount: 4, hasLiveRuns: true },
      { companyId: "company-2", inboxCount: 0, hasLiveRuns: false },
    ]);
    mockCompanyShellStateService.getInboxSummary.mockResolvedValue({
      inbox: 7,
      approvals: 2,
      failedRuns: 1,
      joinRequests: 1,
      mineIssues: 2,
      alerts: 1,
      failedRunSummaries: [
        {
          id: "run-1",
          agentId: "agent-1",
          status: "failed",
          createdAt: new Date("2026-04-20T10:00:00.000Z"),
          retryState: "none",
          error: "boom",
          issueId: "issue-1",
        },
      ],
    });
    mockCompanyShellStateService.getRunActivity.mockResolvedValue({
      days: [
        { date: "2026-04-19", succeeded: 3, failed: 1, other: 0, total: 4 },
        { date: "2026-04-20", succeeded: 2, failed: 0, other: 1, total: 3 },
      ],
    });
  });

  it.sequential("returns rail state for visible non-archived companies", async () => {
    const res = await request(createApp()).get("/api/companies/rail-state");

    expect(res.status).toBe(200);
    expect(mockCompanyShellStateService.listRailState).toHaveBeenCalledWith([
      { companyId: "company-1", canApproveJoins: true, unreadTouchedIssues: 2 },
      { companyId: "company-2", canApproveJoins: true, unreadTouchedIssues: 2 },
    ]);
    expect(res.body).toEqual([
      { companyId: "company-1", inboxCount: 4, hasLiveRuns: true },
      { companyId: "company-2", inboxCount: 0, hasLiveRuns: false },
    ]);
  });

  it.sequential("returns inbox summary for a company", async () => {
    const res = await request(createApp()).get("/api/companies/company-1/inbox-summary");

    expect(res.status).toBe(200);
    expect(mockCompanyShellStateService.getInboxSummary).toHaveBeenCalledWith(
      "company-1",
      { canApproveJoins: true, unreadTouchedIssues: 2 },
    );
    expect(res.body).toMatchObject({
      inbox: 7,
      approvals: 2,
      failedRuns: 1,
      joinRequests: 1,
      mineIssues: 2,
      alerts: 1,
    });
  });

  it.sequential("returns run activity buckets with a bounded days query", async () => {
    const res = await request(createApp()).get("/api/companies/company-1/run-activity?days=14");

    expect(res.status).toBe(200);
    expect(mockCompanyShellStateService.getRunActivity).toHaveBeenCalledWith("company-1", 14);
    expect(res.body).toEqual({
      days: [
        { date: "2026-04-19", succeeded: 3, failed: 1, other: 0, total: 4 },
        { date: "2026-04-20", succeeded: 2, failed: 0, other: 1, total: 3 },
      ],
    });
  });
});
