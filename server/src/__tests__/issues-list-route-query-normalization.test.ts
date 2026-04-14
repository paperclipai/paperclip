import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(async () => []),
  archiveClosed: vi.fn(async () => ({
    archivedCount: 0,
    issueIds: [],
    olderThanDays: 14,
    archivedAt: new Date("2026-04-12T00:00:00.000Z"),
    cutoff: new Date("2026-03-29T00:00:00.000Z"),
  })),
}));

const mockExecutionGateService = vi.hoisted(() => ({
  getExecutionBlock: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  documentService: () => ({}),
  executionGateService: () => mockExecutionGateService,
  executionWorkspaceService: () => ({}),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => ({}),
  heartbeatService: () => ({
    wakeup: vi.fn(async () => undefined),
    reportRunActivity: vi.fn(async () => undefined),
    getRun: vi.fn(async () => null),
    getActiveRunForAgent: vi.fn(async () => null),
    cancelRun: vi.fn(async () => null),
  }),
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    })),
    listCompanyIds: vi.fn(async () => ["company-1"]),
  }),
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue list query normalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("treats literal null query values as omitted filters", async () => {
    const assigneeAgentId = "8cb74f2d-9f0d-45f3-b820-e594f66a6133";

    const res = await request(createApp()).get(
      `/api/companies/company-1/issues?projectId=null&parentId=null&assigneeAgentId=${assigneeAgentId}`,
    );

    expect(res.status).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        projectId: undefined,
        parentId: undefined,
        assigneeAgentId,
      }),
    );
  });

  it("passes includeClosed query flag to the issue service list filter", async () => {
    const res = await request(createApp()).get("/api/companies/company-1/issues?includeClosed=true");

    expect(res.status).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        includeClosed: true,
      }),
    );
  });

  it("passes includeRelations query flag to the issue service list filter", async () => {
    const res = await request(createApp()).get("/api/companies/company-1/issues?includeRelations=true");

    expect(res.status).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        includeRelations: true,
      }),
    );
  });

  it("passes recovery-source exclusion query flag to the issue service list filter", async () => {
    const res = await request(createApp()).get(
      "/api/companies/company-1/issues?excludeRecoverySourcesWithOpenSuccessors=true",
    );

    expect(res.status).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        excludeRecoverySourcesWithOpenSuccessors: true,
      }),
    );
  });

  it("supports bulk archive of closed issues", async () => {
    const res = await request(createApp())
      .post("/api/companies/company-1/issues/archive-closed")
      .send({ olderThanDays: 21 });

    expect(res.status).toBe(200);
    expect(mockIssueService.archiveClosed).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        olderThanDays: 21,
      }),
    );
  });
});
