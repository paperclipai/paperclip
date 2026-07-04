import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockWakeup = vi.hoisted(() => vi.fn(async () => undefined));
const mockHeartbeatGetRun = vi.hoisted(() => vi.fn(async () => null));
const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));
const mockIssueService = vi.hoisted(() => ({
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  getAncestors: vi.fn(),
  getById: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
  getComment: vi.fn(),
  getCommentCursor: vi.fn(),
  getDependencyReadiness: vi.fn(),
  getRelationSummaries: vi.fn(),
  listComments: vi.fn(),
  update: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  findMentionedAgents: vi.fn(async () => []),
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  budgetService: () => ({
    upsertPolicy: vi.fn(async () => undefined),
  }),
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => mockAgentService,
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
    getRun: mockHeartbeatGetRun,
    reportRunActivity: vi.fn(async () => undefined),
    cancelBudgetScopeWork: vi.fn(async () => undefined),
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
  issueThreadInteractionService: () => ({
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  }),
  issueVisibilityService: () => ({
    canSeeIssue: vi.fn(async () => true),
    filterVisibleIssues: vi.fn(async (_principal, issues) => issues),
    ensureCollaborator: vi.fn(async () => undefined),
    resolveMentionsToCollaborators: vi.fn(async () => undefined),
    listCollaborators: vi.fn(async () => []),
    removeCollaborator: vi.fn(async () => undefined),
  }),
  webPushService: () => ({
    sendToUser: vi.fn(async () => undefined),
    sendToUsers: vi.fn(async () => undefined),
    notifyUsers: vi.fn(async () => undefined),
  }),
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

async function createApp(actor: Record<string, unknown> = {
  type: "board",
  userId: "local-board",
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
}) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
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
    mockIssueService.getComment.mockResolvedValue(null);
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      isDependencyReady: true,
      unresolvedBlockerCount: 0,
      unresolvedBlockerIssueIds: [],
    });
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listComments.mockResolvedValue([]);
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockAgentService.getById.mockResolvedValue(null);
    mockHeartbeatGetRun.mockResolvedValue(null);
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

  it("escalates an agent-blocked child lane with no unresolved blocker to the parent manager", async () => {
    mockIssueService.getById
      .mockResolvedValueOnce({
        id: "child-1",
        companyId: "company-1",
        identifier: "PAP-201",
        title: "QA lane",
        description: null,
        status: "blocked",
        priority: "medium",
        parentId: "parent-1",
        assigneeAgentId: "cmo-agent",
        assigneeUserId: null,
        createdByAgentId: null,
        createdByUserId: null,
        executionWorkspaceId: null,
        labels: [],
        labelIds: [],
      })
      .mockResolvedValueOnce({
        id: "parent-1",
        companyId: "company-1",
        identifier: "PAP-200",
        title: "Parent delivery",
        description: null,
        status: "blocked",
        priority: "medium",
        parentId: null,
        assigneeAgentId: "ceo-agent",
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
      identifier: "PAP-201",
      title: "QA lane",
      description: null,
      status: "blocked",
      priority: "medium",
      parentId: "parent-1",
      assigneeAgentId: "cmo-agent",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.addComment
      .mockResolvedValueOnce({ id: "child-comment-1", body: "QA failed; FE needs to repair the visible hero.", issueId: "child-1" })
      .mockResolvedValueOnce({ id: "parent-comment-1", body: "Paperclip escalated a blocked child lane.", issueId: "parent-1" });

    const app = await createApp({
      type: "agent",
      agentId: "cmo-agent",
      companyId: "company-1",
      source: "api_key",
      runId: "run-1",
    });
    const res = await request(app)
      .patch("/api/issues/child-1")
      .send({ status: "blocked", comment: "QA failed; FE needs to repair the visible hero." });

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockIssueService.addComment).toHaveBeenCalledWith(
        "parent-1",
        expect.stringContaining("Child blocked escalation: `child-1:child-comment-1`"),
        {},
        expect.objectContaining({
          authorType: "system",
          metadata: expect.objectContaining({
            version: 1,
            sections: expect.arrayContaining([
              expect.objectContaining({
                title: "Escalation",
                rows: expect.arrayContaining([
                  expect.objectContaining({ type: "key_value", label: "kind", value: "child_blocked_without_first_class_blocker" }),
                  expect.objectContaining({ type: "key_value", label: "childIssueId", value: "child-1" }),
                  expect.objectContaining({ type: "key_value", label: "sourceCommentId", value: "child-comment-1" }),
                ]),
              }),
            ]),
          }),
        }),
      );
      expect(mockWakeup).toHaveBeenCalledWith(
        "ceo-agent",
        expect.objectContaining({
          reason: "child_blocked_without_first_class_blocker",
          payload: expect.objectContaining({
            issueId: "parent-1",
            childIssueId: "child-1",
            childIdentifier: "PAP-201",
            sourceCommentId: "child-comment-1",
          }),
          contextSnapshot: expect.objectContaining({
            issueId: "parent-1",
            wakeReason: "child_blocked_without_first_class_blocker",
            childIssueId: "child-1",
          }),
        }),
      );
    });
  });

  it("does not escalate a blocked child lane that has a real unresolved blocker", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "child-1",
      companyId: "company-1",
      identifier: "PAP-211",
      title: "QA lane",
      description: null,
      status: "blocked",
      priority: "medium",
      parentId: "parent-1",
      assigneeAgentId: "cmo-agent",
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
      identifier: "PAP-211",
      title: "QA lane",
      description: null,
      status: "blocked",
      priority: "medium",
      parentId: "parent-1",
      assigneeAgentId: "cmo-agent",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      isDependencyReady: false,
      unresolvedBlockerCount: 1,
      unresolvedBlockerIssueIds: ["blocker-1"],
    });
    mockIssueService.addComment.mockResolvedValueOnce({
      id: "child-comment-1",
      body: "Blocked by blocker-1.",
      issueId: "child-1",
    });

    const app = await createApp({
      type: "agent",
      agentId: "cmo-agent",
      companyId: "company-1",
      source: "api_key",
      runId: "run-1",
    });
    const res = await request(app)
      .patch("/api/issues/child-1")
      .send({ status: "blocked", comment: "Blocked by blocker-1." });

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockIssueService.getDependencyReadiness).toHaveBeenCalledWith("child-1");
    });
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
    expect(mockWakeup).not.toHaveBeenCalledWith(
      "ceo-agent",
      expect.objectContaining({ reason: "child_blocked_without_first_class_blocker" }),
    );
  });

  it("routes explicit review-required agent completion attempts to the parent reviewer", async () => {
    const actorAgentId = "11111111-1111-4111-8111-111111111111";
    const reviewerAgentId = "22222222-2222-4222-8222-222222222222";
    const existingIssue = {
      id: "child-1",
      companyId: "company-1",
      identifier: "PAP-301",
      title: "Restricted implementation lane",
      description: null,
      status: "in_progress",
      priority: "medium",
      parentId: "parent-1",
      assigneeAgentId: actorAgentId,
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      executionState: null,
      labels: [],
      labelIds: [],
    };
    mockAgentService.getById.mockResolvedValue({
      id: actorAgentId,
      companyId: "company-1",
      role: "engineer",
      reportsTo: null,
      adapterType: "codex-local",
      adapterConfig: {},
      runtimeConfig: {},
      metadata: { reviewRequiredBeforeDone: true },
      permissions: {},
    });
    mockIssueService.getById
      .mockResolvedValueOnce(existingIssue)
      .mockResolvedValueOnce({
        id: "parent-1",
        companyId: "company-1",
        identifier: "PAP-300",
        title: "Parent delivery",
        description: null,
        status: "blocked",
        priority: "medium",
        parentId: null,
        assigneeAgentId: reviewerAgentId,
        assigneeUserId: null,
        createdByAgentId: null,
        createdByUserId: null,
        executionWorkspaceId: null,
        labels: [],
        labelIds: [],
      });
    mockIssueService.update.mockImplementation(async (_id, patch) => ({
      ...existingIssue,
      ...patch,
      status: patch.status,
      assigneeAgentId: patch.assigneeAgentId,
      assigneeUserId: patch.assigneeUserId,
    }));

    const app = await createApp({
      type: "agent",
      agentId: actorAgentId,
      companyId: "company-1",
      source: "api_key",
      runId: "run-review-required",
    });
    const res = await request(app)
      .patch("/api/issues/child-1")
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "child-1",
      expect.objectContaining({
        status: "in_review",
        assigneeAgentId: reviewerAgentId,
        assigneeUserId: null,
        executionState: expect.objectContaining({
          status: "pending",
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: reviewerAgentId, userId: null },
          returnAssignee: { type: "agent", agentId: actorAgentId, userId: null },
          reviewRequest: expect.objectContaining({
            instructions: expect.stringContaining("require review before it can mark issue work done"),
          }),
        }),
      }),
    );
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        reviewerAgentId,
        expect.objectContaining({
          reason: "execution_review_requested",
          payload: expect.objectContaining({
            issueId: "child-1",
          }),
          contextSnapshot: expect.objectContaining({
            issueId: "child-1",
            executionStage: expect.objectContaining({
              wakeRole: "reviewer",
              currentParticipant: expect.objectContaining({ agentId: reviewerAgentId }),
            }),
          }),
        }),
      );
    });
  });

  it("does not treat cheap model routing as review-required completion authority", async () => {
    const actorAgentId = "33333333-3333-4333-8333-333333333333";
    mockAgentService.getById.mockResolvedValue({
      id: actorAgentId,
      companyId: "company-1",
      role: "engineer",
      reportsTo: null,
      adapterType: "codex-local",
      adapterConfig: {},
      runtimeConfig: {},
      metadata: {},
      permissions: {},
    });
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-302",
      title: "Cheap model route work",
      description: null,
      status: "in_progress",
      priority: "medium",
      parentId: null,
      assigneeAgentId: actorAgentId,
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      assigneeAdapterOverrides: { modelProfile: "cheap" },
      executionWorkspaceId: null,
      executionState: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.update.mockImplementation(async (_id, patch) => ({
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-302",
      title: "Cheap model route work",
      description: null,
      priority: "medium",
      parentId: null,
      assigneeAgentId: actorAgentId,
      assigneeUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
      ...patch,
    }));

    const app = await createApp({
      type: "agent",
      agentId: actorAgentId,
      companyId: "company-1",
      source: "api_key",
      runId: "run-cheap-model",
    });
    const res = await request(app).patch("/api/issues/issue-1").send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "issue-1",
      expect.objectContaining({
        status: "done",
      }),
    );
    expect(mockIssueService.update).not.toHaveBeenCalledWith(
      "issue-1",
      expect.objectContaining({
        status: "in_review",
      }),
    );
  });
});
