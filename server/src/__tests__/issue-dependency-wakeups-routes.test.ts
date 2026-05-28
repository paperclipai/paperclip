import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockWakeup = vi.hoisted(() => vi.fn(async () => undefined));
const mockIssueService = vi.hoisted(() => ({
  getAncestors: vi.fn(),
  getAssigneesByIds: vi.fn(async () => []),
  getById: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
  getComment: vi.fn(),
  getCommentCursor: vi.fn(),
  getRelationSummaries: vi.fn(),
  update: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  findMentionedAgents: vi.fn(async () => []),
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
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
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

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    companyId: "company-1",
    identifier: "PAP-100",
    title: "Blocker",
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
    ...overrides,
  };
}

function makeDependent(overrides: Record<string, unknown> = {}) {
  return {
    id: "dep-1",
    assigneeAgentId: "agent-dep",
    status: "todo",
    parentId: null,
    createdByAgentId: null,
    createdByUserId: null,
    blockerIssueIds: ["issue-1"],
    ...overrides,
  };
}

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

describe("issue dependency wakeups in issue routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.getAssigneesByIds.mockResolvedValue([]);
    mockIssueService.getComment.mockResolvedValue(null);
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
  });

  it("wakes dependents when the final blocker transitions to done", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-100",
      title: "Finish blocker",
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
    mockIssueService.update.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-100",
      title: "Finish blocker",
      description: null,
      status: "done",
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
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([
      {
        id: "issue-2",
        assigneeAgentId: "agent-2",
        status: "todo",
        parentId: null,
        createdByAgentId: null,
        createdByUserId: null,
        blockerIssueIds: ["issue-1", "issue-3"],
      },
    ]);

    const res = await request(await createApp()).patch("/api/issues/issue-1").send({ status: "done" });
    expect(res.status).toBe(200);
    await vi.waitFor(
      () => {
        expect(mockWakeup).toHaveBeenCalledWith(
          "agent-2",
          expect.objectContaining({
            reason: "issue_blockers_resolved",
            payload: expect.objectContaining({
              issueId: "issue-2",
              resolvedBlockerIssueId: "issue-1",
            }),
          }),
        );
      },
      { timeout: 10000 },
    );
  }, 30000);

  it("wakes the parent when all direct children become terminal", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "child-1",
      companyId: "company-1",
      identifier: "PAP-101",
      title: "Last child",
      description: null,
      status: "in_progress",
      priority: "medium",
      parentId: "parent-1",
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.update.mockResolvedValue({
      id: "child-1",
      companyId: "company-1",
      identifier: "PAP-101",
      title: "Last child",
      description: null,
      status: "done",
      priority: "medium",
      parentId: "parent-1",
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue({
      id: "parent-1",
      assigneeAgentId: "agent-9",
      childIssueIds: ["child-0", "child-1"],
      childIssueSummaries: [
        {
          id: "child-0",
          identifier: "PAP-100",
          title: "First child",
          status: "done",
          priority: "medium",
          assigneeAgentId: "agent-1",
          assigneeUserId: null,
          updatedAt: new Date("2026-04-18T12:00:00.000Z"),
          summary: "First child finished.",
        },
        {
          id: "child-1",
          identifier: "PAP-101",
          title: "Last child",
          status: "done",
          priority: "medium",
          assigneeAgentId: "agent-1",
          assigneeUserId: null,
          updatedAt: new Date("2026-04-18T12:05:00.000Z"),
          summary: "Last child finished.",
        },
      ],
      childIssueSummaryTruncated: false,
    });

    const res = await request(await createApp()).patch("/api/issues/child-1").send({ status: "done" });
    expect(res.status).toBe(200);
    await vi.waitFor(
      () => {
        expect(mockWakeup).toHaveBeenCalledWith(
          "agent-9",
          expect.objectContaining({
            reason: "issue_children_completed",
            payload: expect.objectContaining({
              issueId: "parent-1",
              completedChildIssueId: "child-1",
              childIssueSummaries: expect.arrayContaining([
                expect.objectContaining({ identifier: "PAP-101", summary: "Last child finished." }),
              ]),
            }),
            contextSnapshot: expect.objectContaining({
              childIssueSummaries: expect.arrayContaining([
                expect.objectContaining({ identifier: "PAP-100", summary: "First child finished." }),
              ]),
            }),
          }),
        );
      },
      { timeout: 10000 },
    );
  }, 30000);

  it("attaches idempotencyKey on blocker-resolved wakes (AC#4)", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "in_progress" }));
    mockIssueService.update.mockResolvedValue(makeIssue({ status: "done" }));
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([
      makeDependent({ id: "dep-1", assigneeAgentId: "agent-dep", status: "todo" }),
    ]);

    const res = await request(await createApp()).patch("/api/issues/issue-1").send({ status: "done" });
    expect(res.status).toBe(200);
    await vi.waitFor(
      () => {
        expect(mockWakeup).toHaveBeenCalledWith(
          "agent-dep",
          expect.objectContaining({
            idempotencyKey: "blockers_resolved:issue-1:dep-1",
          }),
        );
      },
      { timeout: 10000 },
    );
  });

  it("auto-promotes backlog dependents to todo and wakes all siblings (AC#1/AC#2/F4/F8)", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "in_progress" }));
    mockIssueService.update.mockResolvedValue(makeIssue({ status: "done" }));
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([
      makeDependent({ id: "dep-1", status: "backlog", assigneeAgentId: "agent-s1", blockerIssueIds: ["issue-1"] }),
      makeDependent({ id: "dep-2", status: "backlog", assigneeAgentId: "agent-s2", blockerIssueIds: ["issue-1"] }),
      makeDependent({ id: "dep-3", status: "backlog", assigneeAgentId: "agent-s3", blockerIssueIds: ["issue-1"] }),
    ]);

    const res = await request(await createApp()).patch("/api/issues/issue-1").send({ status: "done" });
    expect(res.status).toBe(200);
    await vi.waitFor(
      () => {
        expect(mockIssueService.update).toHaveBeenCalledWith("dep-1", { status: "todo" });
        expect(mockIssueService.update).toHaveBeenCalledWith("dep-2", { status: "todo" });
        expect(mockIssueService.update).toHaveBeenCalledWith("dep-3", { status: "todo" });
        expect(mockWakeup).toHaveBeenCalledWith(
          "agent-s1",
          expect.objectContaining({ reason: "issue_blockers_resolved" }),
        );
        expect(mockWakeup).toHaveBeenCalledWith(
          "agent-s2",
          expect.objectContaining({ reason: "issue_blockers_resolved" }),
        );
        expect(mockWakeup).toHaveBeenCalledWith(
          "agent-s3",
          expect.objectContaining({ reason: "issue_blockers_resolved" }),
        );
      },
      { timeout: 10000 },
    );
  });

  it("wakes parent assignee when orphan dependent has no assignee (AC#3/F7)", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "in_progress" }));
    mockIssueService.update.mockResolvedValue(makeIssue({ status: "done" }));
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([
      makeDependent({ id: "dep-orphan", assigneeAgentId: null, parentId: "parent-1", status: "todo" }),
    ]);
    mockIssueService.getAssigneesByIds.mockResolvedValue([{ id: "parent-1", assigneeAgentId: "agent-parent" }]);

    const res = await request(await createApp()).patch("/api/issues/issue-1").send({ status: "done" });
    expect(res.status).toBe(200);
    await vi.waitFor(
      () => {
        expect(mockWakeup).toHaveBeenCalledWith(
          "agent-parent",
          expect.objectContaining({
            reason: "issue_orphan_blocker_resolved",
            payload: expect.objectContaining({ issueId: "dep-orphan", needsAssignee: true }),
          }),
        );
      },
      { timeout: 10000 },
    );
  });

  it("falls back to creator when orphan dependent has no assignee and no parent (F7)", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "in_progress" }));
    mockIssueService.update.mockResolvedValue(makeIssue({ status: "done" }));
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([
      makeDependent({
        id: "dep-orphan",
        assigneeAgentId: null,
        parentId: null,
        createdByAgentId: "agent-creator",
        status: "todo",
      }),
    ]);

    const res = await request(await createApp()).patch("/api/issues/issue-1").send({ status: "done" });
    expect(res.status).toBe(200);
    await vi.waitFor(
      () => {
        expect(mockWakeup).toHaveBeenCalledWith(
          "agent-creator",
          expect.objectContaining({
            reason: "issue_orphan_blocker_resolved",
            payload: expect.objectContaining({ issueId: "dep-orphan", needsAssignee: true }),
          }),
        );
      },
      { timeout: 10000 },
    );
  });
});
