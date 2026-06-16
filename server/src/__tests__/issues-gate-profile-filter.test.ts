import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

/**
 * D — gateProfile filter on issues list.
 * Verifies the route parses ?gateProfile= and passes it to issueService.list.
 */

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(async () => []),
  count: vi.fn(async () => 0),
  getById: vi.fn(),
  getAncestors: vi.fn(),
  getRelationSummaries: vi.fn(),
  findMentionedProjectIds: vi.fn(),
  getCommentCursor: vi.fn(),
  getComment: vi.fn(),
  listBlockerAttention: vi.fn(),
  listProductivityReviews: vi.fn(),
  getCurrentScheduledRetry: vi.fn(),
  listAttachments: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
}));

const mockIssueRecoveryActionService = vi.hoisted(() => ({
  getActiveForIssue: vi.fn(async () => null),
  listActiveForIssues: vi.fn(async () => new Map()),
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  accessService: () => mockAccessService,
  agentService: () => ({ getById: vi.fn(), list: vi.fn() }),
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(),
    getIssueDocumentByKey: vi.fn(),
  }),
  environmentService: () => ({}),
  executionWorkspaceService: () => ({ getById: vi.fn() }),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
  }),
  goalService: () => ({
    getById: vi.fn(),
    getDefaultCompanyGoal: vi.fn(),
  }),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({ id: "s1", general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" } })),
    listCompanyIds: vi.fn(async () => ["company-1"]),
  }),
  issueApprovalService: () => ({}),
  issueRecoveryActionService: () => mockIssueRecoveryActionService,
  issueThreadInteractionService: () => ({
    listForIssue: vi.fn(async () => []),
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  }),
  issueReferenceService: () => ({
    deleteDocumentSource: vi.fn(async () => undefined),
    diffIssueReferenceSummary: vi.fn(() => ({ addedReferencedIssues: [], removedReferencedIssues: [], currentReferencedIssues: [] })),
    emptySummary: vi.fn(() => ({ outbound: [], inbound: [] })),
    listIssueReferenceSummary: vi.fn(async () => ({ outbound: [], inbound: [] })),
    syncComment: vi.fn(async () => undefined),
    syncDocument: vi.fn(async () => undefined),
    syncIssue: vi.fn(async () => undefined),
  }),
  issueService: () => mockIssueService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({ getById: vi.fn(), listByIds: vi.fn() }),
  routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
  workProductService: () => ({ listForIssue: vi.fn(async () => []) }),
  ISSUE_LIST_DEFAULT_LIMIT: 500,
}));

vi.mock("../services/execution-workspaces.js", () => ({
  executionWorkspaceService: () => ({ getById: vi.fn() }),
}));

const companyId = "company-1";

const boardActor = {
  type: "board",
  userId: "user-1",
  companyIds: [companyId],
  isInstanceAdmin: true,
  source: "session",
};

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = boardActor;
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe.sequential("D — GET /companies/:id/issues gateProfile filter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.list.mockResolvedValue([]);
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      reason: "allow_explicit_grant",
      explanation: "test",
    });
  });

  it("passes gateProfile to issueService.list when provided", async () => {
    const app = createApp();
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues?gateProfile=dev_team`);

    expect(res.status).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledOnce();
    const [, filters] = mockIssueService.list.mock.calls[0];
    expect(filters.gateProfile).toBe("dev_team");
  });

  it("does not pass gateProfile when param is absent", async () => {
    const app = createApp();
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`);

    expect(res.status).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledOnce();
    const [, filters] = mockIssueService.list.mock.calls[0];
    expect(filters.gateProfile).toBeUndefined();
  });

  it("returns 200 with empty array when no issues match gateProfile", async () => {
    mockIssueService.list.mockResolvedValue([]);

    const app = createApp();
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues?gateProfile=dev_team`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
