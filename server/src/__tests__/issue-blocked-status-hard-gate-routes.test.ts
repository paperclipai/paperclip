import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// CONA-337 Control 1: status=blocked requires >= 1 unresolved blockedByIssueIds entry.
// Enforced at three places: PATCH /issues/:id, POST /companies/:cid/issues, and
// POST /issues/:id/children.

const mockWakeup = vi.hoisted(() => vi.fn(async () => undefined));
const mockIssueService = vi.hoisted(() => ({
  getAncestors: vi.fn(async () => []),
  getById: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
  getComment: vi.fn(async () => null),
  getCommentCursor: vi.fn(async () => ({
    totalComments: 0,
    latestCommentId: null,
    latestCommentAt: null,
  })),
  getRelationSummaries: vi.fn(async () => ({ blockedBy: [], blocks: [] })),
  update: vi.fn(),
  create: vi.fn(),
  createChild: vi.fn(),
  listWakeableBlockedDependents: vi.fn(async () => []),
  getWakeableParentAfterChildCompletion: vi.fn(async () => null),
  findMentionedAgents: vi.fn(async () => []),
  getDependencyReadiness: vi.fn(async () => ({
    issueId: "issue-1",
    blockerIssueIds: [],
    unresolvedBlockerIssueIds: [],
    unresolvedBlockerCount: 0,
    allBlockersDone: true,
    isDependencyReady: true,
  })),
  listUnresolvedBlockerIssueIds: vi.fn(async () => [] as string[]),
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
    wakeup: mockWakeup,
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

function expectContinuationContractViolation(res: { status: number; body: any }) {
  expect(res.status).toBe(422);
  expect(res.body).toEqual({
    error: "continuation_contract_violation",
    message: "status=blocked requires at least one unresolved blockedByIssueIds entry",
    code: 422,
  });
}

describe("CONA-337 Control 1: status=blocked hard gate", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
  });

  describe("PATCH /api/issues/:id", () => {
    it("returns 422 when transitioning to blocked with no current blockers", async () => {
      mockIssueService.getById.mockResolvedValue({
        id: "issue-1",
        companyId: "company-1",
        identifier: "CONA-1",
        title: "test",
        description: null,
        status: "in_progress",
        priority: "medium",
        parentId: null,
        assigneeAgentId: "agent-1",
        assigneeUserId: null,
        createdByAgentId: null,
        createdByUserId: null,
        executionWorkspaceId: null,
        labels: [],
        labelIds: [],
      });
      mockIssueService.getDependencyReadiness.mockResolvedValue({
        issueId: "issue-1",
        blockerIssueIds: [],
        unresolvedBlockerIssueIds: [],
        unresolvedBlockerCount: 0,
        allBlockersDone: true,
        isDependencyReady: true,
      });

      const res = await request(await createApp())
        .patch("/api/issues/issue-1")
        .send({ status: "blocked" });
      expectContinuationContractViolation(res);
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });

    it("returns 422 when transitioning to blocked with empty blockedByIssueIds", async () => {
      mockIssueService.getById.mockResolvedValue({
        id: "issue-1",
        companyId: "company-1",
        identifier: "CONA-1",
        title: "test",
        description: null,
        status: "in_progress",
        priority: "medium",
        parentId: null,
        assigneeAgentId: "agent-1",
        assigneeUserId: null,
        createdByAgentId: null,
        createdByUserId: null,
        executionWorkspaceId: null,
        labels: [],
        labelIds: [],
      });

      const res = await request(await createApp())
        .patch("/api/issues/issue-1")
        .send({ status: "blocked", blockedByIssueIds: [] });
      expectContinuationContractViolation(res);
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });

    it("returns 422 when transitioning to blocked with only done blockers", async () => {
      mockIssueService.getById.mockResolvedValue({
        id: "issue-1",
        companyId: "company-1",
        identifier: "CONA-1",
        title: "test",
        description: null,
        status: "in_progress",
        priority: "medium",
        parentId: null,
        assigneeAgentId: "agent-1",
        assigneeUserId: null,
        createdByAgentId: null,
        createdByUserId: null,
        executionWorkspaceId: null,
        labels: [],
        labelIds: [],
      });
      mockIssueService.listUnresolvedBlockerIssueIds.mockResolvedValue([]);

      const res = await request(await createApp())
        .patch("/api/issues/issue-1")
        .send({ status: "blocked", blockedByIssueIds: ["done-blocker-1"] });
      expectContinuationContractViolation(res);
      expect(mockIssueService.listUnresolvedBlockerIssueIds).toHaveBeenCalledWith(
        "company-1",
        ["done-blocker-1"],
      );
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });

    it("succeeds when transitioning to blocked with an unresolved blocker", async () => {
      mockIssueService.getById.mockResolvedValue({
        id: "issue-1",
        companyId: "company-1",
        identifier: "CONA-1",
        title: "test",
        description: null,
        status: "in_progress",
        priority: "medium",
        parentId: null,
        assigneeAgentId: "agent-1",
        assigneeUserId: null,
        createdByAgentId: null,
        createdByUserId: null,
        executionWorkspaceId: null,
        labels: [],
        labelIds: [],
      });
      mockIssueService.listUnresolvedBlockerIssueIds.mockResolvedValue([
        "live-blocker-1",
      ]);
      mockIssueService.update.mockResolvedValue({
        id: "issue-1",
        companyId: "company-1",
        identifier: "CONA-1",
        title: "test",
        description: null,
        status: "blocked",
        priority: "medium",
        parentId: null,
        assigneeAgentId: "agent-1",
        assigneeUserId: null,
        createdByAgentId: null,
        createdByUserId: null,
        executionWorkspaceId: null,
        labels: [],
        labelIds: [],
      });

      const res = await request(await createApp())
        .patch("/api/issues/issue-1")
        .send({ status: "blocked", blockedByIssueIds: ["live-blocker-1"] });
      expect(res.status).toBe(200);
      expect(mockIssueService.update).toHaveBeenCalled();
    });

    it("returns 422 when an already-blocked issue patches blockedByIssueIds to empty", async () => {
      mockIssueService.getById.mockResolvedValue({
        id: "issue-1",
        companyId: "company-1",
        identifier: "CONA-1",
        title: "test",
        description: null,
        status: "blocked",
        priority: "medium",
        parentId: null,
        assigneeAgentId: "agent-1",
        assigneeUserId: null,
        createdByAgentId: null,
        createdByUserId: null,
        executionWorkspaceId: null,
        labels: [],
        labelIds: [],
      });

      const res = await request(await createApp())
        .patch("/api/issues/issue-1")
        .send({ blockedByIssueIds: [] });
      expectContinuationContractViolation(res);
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/companies/:companyId/issues", () => {
    it("returns 422 when creating a blocked issue with no blockedByIssueIds", async () => {
      const res = await request(await createApp())
        .post("/api/companies/company-1/issues")
        .send({ title: "Test", status: "blocked" });
      expectContinuationContractViolation(res);
      expect(mockIssueService.create).not.toHaveBeenCalled();
    });

    it("returns 422 when creating a blocked issue with only done blockers", async () => {
      mockIssueService.listUnresolvedBlockerIssueIds.mockResolvedValue([]);
      const res = await request(await createApp())
        .post("/api/companies/company-1/issues")
        .send({
          title: "Test",
          status: "blocked",
          blockedByIssueIds: ["done-blocker-1"],
        });
      expectContinuationContractViolation(res);
      expect(mockIssueService.create).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/issues/:id/children", () => {
    beforeEach(() => {
      mockIssueService.getById.mockResolvedValue({
        id: "parent-1",
        companyId: "company-1",
        identifier: "CONA-PARENT",
        title: "parent",
        description: null,
        status: "in_progress",
        priority: "medium",
        parentId: null,
        assigneeAgentId: null,
        assigneeUserId: null,
        createdByAgentId: null,
        createdByUserId: null,
        executionWorkspaceId: null,
        labels: [],
        labelIds: [],
      });
    });

    it("returns 422 when creating a blocked child with no blockedByIssueIds", async () => {
      const res = await request(await createApp())
        .post("/api/issues/parent-1/children")
        .send({ title: "Child", status: "blocked" });
      expectContinuationContractViolation(res);
      expect(mockIssueService.createChild).not.toHaveBeenCalled();
    });
  });
});
