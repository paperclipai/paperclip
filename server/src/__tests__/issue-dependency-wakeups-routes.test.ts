import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The first test in this suite imports the large `routes/issues.ts` module
// through `vi.importActual` inside `createApp`. `vi.resetModules()` in
// `beforeEach` forces a fresh import each test, so the first test pays the
// one-time transform and execution cost of that module. Locally the first
// test takes about 3.7s while the later tests take about 0.13s each. Under
// the loaded serial shard (maxWorkers=1) this cold-start can cross vitest's
// default 5000ms test timeout and produce a flaky "Test timed out in 5000ms"
// failure. Give the suite generous headroom, far above the observed cold-start
// yet still below the 30s hook timeout.
vi.setConfig({ testTimeout: 15000 });

const mockWakeup = vi.hoisted(() => vi.fn(async () => undefined));
const mockFindExistingIssueBlockersResolvedWakeForReadyState = vi.hoisted(() => vi.fn(async () => null));
const mockIssueService = vi.hoisted(() => ({
  getAncestors: vi.fn(),
  getById: vi.fn(),
  getByIdForUpdate: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
  getComment: vi.fn(),
  getCommentCursor: vi.fn(),
  getRelationSummaries: vi.fn(),
  update: vi.fn(),
  getDependencyReadiness: vi.fn(),
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
  companySkillService: () => ({
    completeTestRunForIssue: vi.fn(async () => null),
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
    expirePendingInteractionsForTerminalIssue: vi.fn(async () => []),
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

vi.mock("../services/issue-dependency-wakeups.js", async () => {
  const actual = await vi.importActual<typeof import("../services/issue-dependency-wakeups.js")>(
    "../services/issue-dependency-wakeups.js",
  );
  return {
    ...actual,
    findExistingIssueBlockersResolvedWakeForReadyState:
      mockFindExistingIssueBlockersResolvedWakeForReadyState,
  };
});

// Drizzle stamps the SQL table name on this symbol; the route module is re-imported per test
// via vi.resetModules(), so table objects cannot be matched by identity — match by name.
const drizzleTableName = (table: unknown): string | undefined =>
  (table as Record<symbol, unknown> | null)?.[Symbol.for("drizzle:Name")] as string | undefined;

async function createApp(rowsByTable?: Record<string, unknown[]>) {
  const emptyRows: unknown[] = [];
  const buildQuery = (table: unknown) => {
    const tableName = drizzleTableName(table);
    const rows = (tableName ? rowsByTable?.[tableName] : undefined) ?? emptyRows;
    const whereResult = {
      limit: vi.fn(async () => rows),
      then: async (resolve: (queried: unknown[]) => unknown) => resolve(rows),
    };
    const query: Record<string, unknown> = {};
    query.innerJoin = vi.fn(() => query);
    query.where = vi.fn(() => whereResult);
    return query;
  };
  const routeDb = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => buildQuery(table)),
    })),
    transaction: async (callback: (tx: Record<string, never>) => Promise<unknown>) => callback({}),
  };
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
  app.use("/api", issueRoutes(routeDb as any, {} as any));
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
    mockFindExistingIssueBlockersResolvedWakeForReadyState.mockResolvedValue(null);
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.getByIdForUpdate.mockImplementation(async () => mockIssueService.getById());
    mockIssueService.getComment.mockResolvedValue(null);
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: "issue-1",
      blockerIssueIds: [],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      pendingFinalizeBlockerIssueIds: [],
      allBlockersDone: true,
      isDependencyReady: true,
    });
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
        blockerIssueIds: ["issue-1", "issue-3"],
      },
    ]);

    const res = await request(await createApp()).patch("/api/issues/issue-1").send({ status: "done" });
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
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
    });
  });

  it("wakes an assigned blocked issue when blockers are applied after the blocker is already done", async () => {
    const parentIssueId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const childIssueId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    mockIssueService.getById.mockResolvedValue({
      id: parentIssueId,
      companyId: "company-1",
      identifier: "PAP-200",
      title: "Blocked after completion",
      description: null,
      status: "todo",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-2",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.update.mockResolvedValue({
      id: parentIssueId,
      companyId: "company-1",
      identifier: "PAP-200",
      title: "Blocked after completion",
      description: null,
      status: "blocked",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-2",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: parentIssueId,
      blockerIssueIds: [childIssueId],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      pendingFinalizeBlockerIssueIds: [],
      allBlockersDone: true,
      isDependencyReady: true,
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${parentIssueId}`)
      .send({
        status: "blocked",
        blockedByIssueIds: [childIssueId],
        unblockDescriptor: { owner: "board", action: "Review the restored dependency" },
      });

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-2",
        expect.objectContaining({
          reason: "issue_blockers_resolved",
          payload: expect.objectContaining({
            issueId: parentIssueId,
            resolvedBlockerIssueId: childIssueId,
            mutation: "blocked_dependency_restored",
          }),
          contextSnapshot: expect.objectContaining({
            source: "issue.blockers_restored",
          }),
        }),
      );
    });
  });

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
    await vi.waitFor(() => {
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
    });
  });

  describe("clearing the last blocker on an already-blocked issue", () => {
    const blockedIssueId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const blockerIssueId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

    const blockedIssue = (overrides: Record<string, unknown> = {}) => ({
      id: blockedIssueId,
      companyId: "company-1",
      identifier: "PAP-300",
      title: "Waiting on nothing",
      description: null,
      status: "blocked",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-7",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      unblockDescriptor: null,
      labels: [],
      labelIds: [],
      ...overrides,
    });

    const blockerRelation = {
      id: blockerIssueId,
      identifier: "PAP-301",
      title: "The blocker",
      status: "done",
      priority: "medium",
      assigneeAgentId: null,
      assigneeUserId: null,
    };

    const statusSentToUpdate = () =>
      (mockIssueService.update.mock.calls[0]?.[1] as { status?: string } | undefined)?.status;

    // Wakes are emitted from a fire-and-forget post-commit IIFE, so asserting that NO wake was
    // emitted needs the event loop drained first — otherwise the assertion passes vacuously.
    const drainPostCommitWakeups = async () => {
      for (let turn = 0; turn < 5; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    };

    it("releases the issue to todo and wakes the assignee when the last blocker edge is removed", async () => {
      mockIssueService.getById.mockResolvedValue(blockedIssue());
      mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [blockerRelation], blocks: [] });
      mockIssueService.update.mockResolvedValue(blockedIssue({ status: "todo" }));

      const res = await request(await createApp())
        .patch(`/api/issues/${blockedIssueId}`)
        .send({ blockedByIssueIds: [] });

      expect(res.status).toBe(200);
      expect(statusSentToUpdate()).toBe("todo");
      await vi.waitFor(() => {
        expect(mockWakeup).toHaveBeenCalledWith(
          "agent-7",
          expect.objectContaining({
            reason: "issue_blockers_resolved",
            payload: expect.objectContaining({
              issueId: blockedIssueId,
              resolvedBlockerIssueId: blockerIssueId,
              blockerIssueIds: [blockerIssueId],
              mutation: "blockers_cleared",
            }),
            contextSnapshot: expect.objectContaining({
              source: "issue.blockers_cleared",
            }),
          }),
        );
      });
    });

    it("releases an already naked-blocked issue to todo without emitting a wake", async () => {
      mockIssueService.getById.mockResolvedValue(blockedIssue());
      // Already naked-blocked: status "blocked" with zero blocker edges, no interaction,
      // no approval, no unblockDescriptor.
      mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
      mockIssueService.update.mockResolvedValue(blockedIssue({ status: "todo" }));

      const res = await request(await createApp())
        .patch(`/api/issues/${blockedIssueId}`)
        .send({ blockedByIssueIds: [] });

      expect(res.status).toBe(200);
      expect(statusSentToUpdate()).toBe("todo");

      await drainPostCommitWakeups();
      expect(mockFindExistingIssueBlockersResolvedWake).not.toHaveBeenCalled();
      expect(mockWakeup).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ reason: "issue_blockers_resolved" }),
      );
      expect(mockWakeup).not.toHaveBeenCalled();
    });

    it("keeps the issue blocked when a pending thread interaction remains", async () => {
      mockIssueService.getById.mockResolvedValue(blockedIssue());
      mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [blockerRelation], blocks: [] });
      mockIssueService.update.mockResolvedValue(blockedIssue());

      const res = await request(
        await createApp({ issue_thread_interactions: [{ id: "interaction-1" }] }),
      )
        .patch(`/api/issues/${blockedIssueId}`)
        .send({ blockedByIssueIds: [] });

      expect(res.status).toBe(200);
      expect(statusSentToUpdate()).toBeUndefined();
    });

    it("keeps the issue blocked when a pending linked approval remains", async () => {
      mockIssueService.getById.mockResolvedValue(blockedIssue());
      mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [blockerRelation], blocks: [] });
      mockIssueService.update.mockResolvedValue(blockedIssue());

      const res = await request(await createApp({ issue_approvals: [{ id: "approval-1" }] }))
        .patch(`/api/issues/${blockedIssueId}`)
        .send({ blockedByIssueIds: [] });

      expect(res.status).toBe(200);
      expect(statusSentToUpdate()).toBeUndefined();
    });

    it("keeps the issue blocked when an unblockDescriptor remains", async () => {
      mockIssueService.getById.mockResolvedValue(
        blockedIssue({ unblockDescriptor: { owner: "board", action: "Decide on the vendor" } }),
      );
      mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [blockerRelation], blocks: [] });
      mockIssueService.update.mockResolvedValue(
        blockedIssue({ unblockDescriptor: { owner: "board", action: "Decide on the vendor" } }),
      );

      const res = await request(await createApp())
        .patch(`/api/issues/${blockedIssueId}`)
        .send({ blockedByIssueIds: [] });

      expect(res.status).toBe(200);
      expect(statusSentToUpdate()).toBeUndefined();
    });

    it("keeps the issue blocked when blockers are replaced with a still-open blocker", async () => {
      mockIssueService.getById.mockResolvedValue(blockedIssue());
      mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
      mockIssueService.update.mockResolvedValue(blockedIssue());

      const res = await request(await createApp({ issues: [{ id: blockerIssueId }] }))
        .patch(`/api/issues/${blockedIssueId}`)
        .send({ blockedByIssueIds: [blockerIssueId] });

      expect(res.status).toBe(200);
      expect(statusSentToUpdate()).toBeUndefined();
    });

    it("still rejects entering blocked without any wait surface", async () => {
      mockIssueService.getById.mockResolvedValue(blockedIssue({ status: "todo" }));
      mockIssueService.update.mockResolvedValue(blockedIssue());

      const res = await request(await createApp())
        .patch(`/api/issues/${blockedIssueId}`)
        .send({ status: "blocked" });

      expect(res.status).toBe(422);
      expect(res.body.error).toBe(
        "Entering blocked requires unresolved blockers, a pending interaction/approval, or unblockDescriptor",
      );
    });
  });
});
