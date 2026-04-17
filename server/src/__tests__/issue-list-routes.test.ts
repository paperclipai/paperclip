import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
    resolveByReference: vi.fn(),
  }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(),
  }),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => ({
    getById: vi.fn(),
    getDefaultCompanyGoal: vi.fn(),
  }),
  heartbeatService: () => ({
    wakeup: vi.fn(async () => undefined),
    reportRunActivity: vi.fn(async () => undefined),
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
  projectService: () => ({
    getById: vi.fn(),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
}));

async function createApp() {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
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

describe("issue list routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.resetAllMocks();
    mockIssueService.list.mockResolvedValue([]);
  });

  it("treats parentIssueId as an alias for parentId on the company issues list route", async () => {
    const parentIssueId = "11111111-1111-4111-8111-111111111111";

    const res = await request(await createApp())
      .get("/api/companies/company-1/issues")
      .query({ parentIssueId });

    expect(res.status).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledWith("company-1", expect.objectContaining({
      parentId: parentIssueId,
    }));
  });

  it("continues to pass through parentId on the company issues list route", async () => {
    const parentId = "22222222-2222-4222-8222-222222222222";

    const res = await request(await createApp())
      .get("/api/companies/company-1/issues")
      .query({ parentId });

    expect(res.status).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledWith("company-1", expect.objectContaining({
      parentId,
    }));
  });

  it("prefers parentId over parentIssueId when both are supplied", async () => {
    const parentId = "33333333-3333-4333-8333-333333333333";
    const parentIssueId = "44444444-4444-4444-8444-444444444444";

    const res = await request(await createApp())
      .get("/api/companies/company-1/issues")
      .query({ parentId, parentIssueId });

    expect(res.status).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledWith("company-1", expect.objectContaining({
      parentId,
    }));
  });
});
