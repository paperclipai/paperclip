import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  getAncestors: vi.fn(),
  getById: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
  getComment: vi.fn(),
  getCommentCursor: vi.fn(),
  getRelationSummaries: vi.fn(),
  getDependencyReadiness: vi.fn(async () => ({ unresolvedBlockerCount: 0 })),
  update: vi.fn(),
  addComment: vi.fn(),
  listWakeableBlockedDependents: vi.fn(async () => []),
  getWakeableParentAfterChildCompletion: vi.fn(async () => null),
  findMentionedAgents: vi.fn(async () => []),
  getCurrentScheduledRetry: vi.fn(async () => null),
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(),
  }),
  feedbackService: () => ({}),
  goalService: () => ({
    getById: vi.fn(),
    getDefaultCompanyGoal: vi.fn(),
  }),
  heartbeatService: () => ({
    wakeup: vi.fn(async () => undefined),
    reportRunActivity: vi.fn(async () => undefined),
  }),
  getIssueContinuationSummaryDocument: vi.fn(async () => null),
  instanceSettingsService: () => ({
    get: vi.fn(),
    listCompanyIds: vi.fn(),
  }),
  issueApprovalService: () => ({}),
  issueReferenceService: () => ({
    deleteDocumentSource: async () => undefined,
    diffIssueReferenceSummary: () => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    }),
    emptySummary: () => ({ outbound: [], inbound: [] }),
    listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    syncComment: async () => undefined,
    syncDocument: async () => undefined,
    syncIssue: async () => undefined,
  }),
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
  issueThreadInteractionService: () => ({
    listForIssue: vi.fn(async () => []),
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  }),
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

const BLOCKER_ID = "00000000-0000-4000-8000-000000000001";
const ISSUE_ID = "00000000-0000-4000-8000-000000000010";
const AGENT_ID = "00000000-0000-4000-8000-000000000020";
const COMPANY_ID = "company-1";

const baseIssue = {
  id: ISSUE_ID,
  companyId: COMPANY_ID,
  identifier: "PAP-500",
  title: "Test issue",
  description: null,
  priority: "medium",
  parentId: null,
  assigneeAgentId: AGENT_ID,
  assigneeUserId: null,
  createdByAgentId: null,
  createdByUserId: null,
  executionWorkspaceId: null,
  labels: [],
  labelIds: [],
};

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

describe("blocked-without-blockers warning", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.getComment.mockResolvedValue(null);
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
  });

  it("returns a warning when setting status to blocked without blockedByIssueIds", async () => {
    mockIssueService.getById.mockResolvedValue({ ...baseIssue, status: "in_progress" });
    mockIssueService.update.mockResolvedValue({ ...baseIssue, status: "blocked" });

    const res = await request(await createApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "blocked" });

    expect(res.status).toBe(200);
    expect(res.body.warnings).toBeDefined();
    expect(res.body.warnings).toHaveLength(1);
    expect(res.body.warnings[0]).toContain("blockedByIssueIds");
  });

  it("does not return a warning when setting status to blocked with blockedByIssueIds", async () => {
    mockIssueService.getById.mockResolvedValue({ ...baseIssue, status: "in_progress" });
    mockIssueService.update.mockResolvedValue({ ...baseIssue, status: "blocked" });
    mockIssueService.getRelationSummaries.mockResolvedValue({
      blockedBy: [{ id: BLOCKER_ID, identifier: "PAP-501", title: "Blocker", status: "todo" }],
      blocks: [],
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "blocked", blockedByIssueIds: [BLOCKER_ID] });

    expect(res.status).toBe(200);
    expect(res.body.warnings).toBeUndefined();
  });

  it("does not return a warning when issue already has blockers", async () => {
    mockIssueService.getById.mockResolvedValue({ ...baseIssue, status: "blocked" });
    mockIssueService.update.mockResolvedValue({ ...baseIssue, status: "blocked" });
    mockIssueService.getRelationSummaries.mockResolvedValue({
      blockedBy: [{ id: BLOCKER_ID, identifier: "PAP-501", title: "Blocker", status: "todo" }],
      blocks: [],
    });
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      body: "still blocked",
      createdAt: new Date().toISOString(),
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ comment: "still blocked" });

    expect(res.status).toBe(200);
    expect(res.body.warnings).toBeUndefined();
  });

  it("does not return a warning when status is not blocked", async () => {
    mockIssueService.getById.mockResolvedValue({ ...baseIssue, status: "in_progress" });
    mockIssueService.update.mockResolvedValue({ ...baseIssue, status: "done" });

    const res = await request(await createApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(res.body.warnings).toBeUndefined();
  });
});
