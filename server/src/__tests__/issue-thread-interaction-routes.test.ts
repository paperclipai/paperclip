import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ASSIGNEE_AGENT_ID = "11111111-1111-4111-8111-111111111111";
const CREATED_AGENT_ID = "22222222-2222-4222-8222-222222222222";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockInteractionService = vi.hoisted(() => ({
  listForIssue: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  acceptInteraction: vi.fn(),
  acceptSuggestedTasks: vi.fn(),
  rejectInteraction: vi.fn(),
  rejectSuggestedTasks: vi.fn(),
  expireRequestConfirmationsSupersededByHistoricalComments: vi.fn(),
  answerQuestions: vi.fn(),
  cancelQuestions: vi.fn(),
  sweepPendingRequestConfirmationsOnTerminalIssues: vi.fn(),
}));

const mockAuthorizationService = vi.hoisted(() => ({
  isManagerOf: vi.fn(async () => false),
  decide: vi.fn(),
  decidePrincipalGrant: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentTaskCompleted: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    accessService: () => ({
      canUser: vi.fn(async () => true),
      decide: vi.fn(async (input: { action?: string }) => ({
        allowed: true,
        action: input.action,
        reason: "allow_explicit_grant",
        explanation: "Allowed by test grant.",
      })),
      hasPermission: vi.fn(async () => true),
    }),
    agentService: () => ({
      getById: vi.fn(async () => null),
      resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
        ambiguous: false,
        agent: { id: raw },
      })),
    }),
    authorizationService: () => mockAuthorizationService,
    clampIssueListLimit: (value: number) => value,
    ISSUE_LIST_DEFAULT_LIMIT: 500,
    ISSUE_LIST_MAX_LIMIT: 1000,
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
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
    issueThreadInteractionService: () => mockInteractionService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  }));
}

function createIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    companyId: "company-1",
    status: "in_progress",
    workMode: "standard",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: ASSIGNEE_AGENT_ID,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-1714",
    title: "Persist interactions",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    ...overrides,
  };
}

async function createApp(actor: Record<string, unknown> = {
  type: "board",
  userId: "local-board",
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
}) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/issues.js"),
    import("../middleware/index.js"),
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

describe.sequential("issue thread interaction routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../services/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(createIssue());
    mockInteractionService.listForIssue.mockResolvedValue([]);
    mockInteractionService.expireRequestConfirmationsSupersededByHistoricalComments.mockResolvedValue([]);
    mockInteractionService.create.mockResolvedValue({
      id: "interaction-1",
      companyId: "company-1",
      issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      kind: "suggest_tasks",
      status: "pending",
      continuationPolicy: "wake_assignee",
      idempotencyKey: null,
      sourceCommentId: null,
      sourceRunId: "run-1",
      payload: {
        version: 1,
        tasks: [{ clientKey: "task-1", title: "One" }],
      },
      result: null,
      createdAt: "2026-04-20T12:00:00.000Z",
      updatedAt: "2026-04-20T12:00:00.000Z",
    });
    mockInteractionService.acceptInteraction.mockResolvedValue({
      interaction: {
        id: "interaction-1",
        companyId: "company-1",
        issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        kind: "suggest_tasks",
        status: "accepted",
        continuationPolicy: "wake_assignee",
        idempotencyKey: null,
        sourceCommentId: "comment-1",
        sourceRunId: "run-1",
        payload: {
          version: 1,
          tasks: [{ clientKey: "task-1", title: "One" }],
        },
        result: {
          version: 1,
          createdTasks: [{ clientKey: "task-1", issueId: "child-1" }],
          skippedClientKeys: ["task-2"],
        },
        createdAt: "2026-04-20T12:00:00.000Z",
        updatedAt: "2026-04-20T12:05:00.000Z",
        resolvedAt: "2026-04-20T12:05:00.000Z",
      },
      createdIssues: [
        {
          id: "child-1",
          assigneeAgentId: CREATED_AGENT_ID,
          status: "todo",
        },
      ],
    });
    mockInteractionService.rejectInteraction.mockResolvedValue({
      id: "interaction-1",
      companyId: "company-1",
      issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      kind: "suggest_tasks",
      status: "rejected",
      continuationPolicy: "wake_assignee",
      idempotencyKey: null,
      sourceCommentId: "comment-1",
      sourceRunId: "run-1",
      payload: {
        version: 1,
        tasks: [{ clientKey: "task-1", title: "One" }],
      },
      result: {
        version: 1,
        rejectionReason: "Not actionable enough",
      },
      createdAt: "2026-04-20T12:00:00.000Z",
      updatedAt: "2026-04-20T12:05:00.000Z",
      resolvedAt: "2026-04-20T12:05:00.000Z",
    });
    mockInteractionService.answerQuestions.mockResolvedValue({
      id: "interaction-2",
      companyId: "company-1",
      issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      kind: "ask_user_questions",
      status: "answered",
      continuationPolicy: "wake_assignee",
      idempotencyKey: null,
      sourceCommentId: "comment-2",
      sourceRunId: "run-2",
      payload: {
        version: 1,
        questions: [{
          id: "scope",
          prompt: "Scope?",
          selectionMode: "single",
          options: [{ id: "phase-1", label: "Phase 1" }],
        }],
      },
      result: {
        version: 1,
        answers: [{ questionId: "scope", optionIds: ["phase-1"] }],
      },
      createdAt: "2026-04-20T12:00:00.000Z",
      updatedAt: "2026-04-20T12:06:00.000Z",
      resolvedAt: "2026-04-20T12:06:00.000Z",
    });
    mockInteractionService.sweepPendingRequestConfirmationsOnTerminalIssues.mockResolvedValue({ expired: [] });
    mockInteractionService.getById.mockResolvedValue(null);
    mockAuthorizationService.isManagerOf.mockResolvedValue(false);
    mockInteractionService.cancelQuestions.mockResolvedValue({
      id: "interaction-2",
      companyId: "company-1",
      issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      kind: "ask_user_questions",
      status: "cancelled",
      continuationPolicy: "wake_assignee",
      idempotencyKey: null,
      sourceCommentId: "comment-2",
      sourceRunId: "run-2",
      payload: {
        version: 1,
        questions: [{
          id: "scope",
          prompt: "Scope?",
          selectionMode: "single",
          options: [{ id: "phase-1", label: "Phase 1" }],
        }],
      },
      result: {
        version: 1,
        answers: [],
        cancelled: true,
        cancellationReason: null,
        summaryMarkdown: null,
      },
      createdAt: "2026-04-20T12:00:00.000Z",
      updatedAt: "2026-04-20T12:05:00.000Z",
      resolvedAt: "2026-04-20T12:05:00.000Z",
    });
  });

  it("lists and creates board-authored interactions", async () => {
    mockInteractionService.expireRequestConfirmationsSupersededByHistoricalComments.mockResolvedValueOnce([
      {
        id: "interaction-expired",
        kind: "request_confirmation",
        status: "expired",
        result: {
          version: 1,
          outcome: "superseded_by_comment",
          commentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        },
      },
    ]);
    mockInteractionService.listForIssue.mockResolvedValue([
      { id: "interaction-1", kind: "suggest_tasks", status: "pending" },
    ]);
    const app = await createApp();

    const listRes = await request(app).get("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions");
    expect(listRes.status).toBe(200);
    expect(listRes.body).toEqual([
      { id: "interaction-1", kind: "suggest_tasks", status: "pending" },
    ]);
    expect(mockInteractionService.expireRequestConfirmationsSupersededByHistoricalComments).toHaveBeenCalledWith(
      expect.objectContaining({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.thread_interaction_expired",
        details: expect.objectContaining({
          interactionId: "interaction-expired",
          interactionKind: "request_confirmation",
          source: "issue.interactions.catchup_superseded_by_comment",
          result: expect.objectContaining({
            outcome: "superseded_by_comment",
            commentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          }),
        }),
      }),
    );

    const createRes = await request(app)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions")
      .send({
        kind: "suggest_tasks",
        payload: {
          version: 1,
          tasks: [{ clientKey: "task-1", title: "One" }],
        },
      });

    expect(createRes.status).toBe(201);
    expect(mockInteractionService.create).toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.thread_interaction_created",
        details: expect.objectContaining({
          interactionId: "interaction-1",
          interactionKind: "suggest_tasks",
        }),
      }),
    );
  });

  it("accepts suggested tasks and wakes created assignees plus the current assignee", async () => {
    const app = await createApp();

    const res = await request(app)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-1/accept")
      .send({ selectedClientKeys: ["task-1"] });

    expect(res.status).toBe(200);
    expect(mockInteractionService.acceptInteraction).toHaveBeenCalledWith(
      expect.objectContaining({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      "interaction-1",
      { selectedClientKeys: ["task-1"] },
      expect.objectContaining({ userId: "local-board" }),
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(2);
    expect(mockHeartbeatService.wakeup).toHaveBeenNthCalledWith(
      1,
      CREATED_AGENT_ID,
      expect.objectContaining({
        source: "assignment",
        reason: "issue_assigned",
        payload: expect.objectContaining({
          issueId: "child-1",
          mutation: "interaction_accept",
        }),
      }),
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenNthCalledWith(
      2,
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        source: "automation",
        reason: "issue_commented",
        payload: expect.objectContaining({
          issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          interactionId: "interaction-1",
          interactionStatus: "accepted",
          sourceCommentId: "comment-1",
          sourceRunId: "run-1",
        }),
      }),
    );
  });

  it("answers questions and emits a continuation wake", async () => {
    const app = await createApp();

    const res = await request(app)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-2/respond")
      .send({
        answers: [{ questionId: "scope", optionIds: ["phase-1"] }],
      });

    expect(res.status).toBe(200);
    expect(mockInteractionService.answerQuestions).toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        reason: "issue_commented",
        payload: expect.objectContaining({
          interactionId: "interaction-2",
          interactionKind: "ask_user_questions",
          interactionStatus: "answered",
          sourceCommentId: "comment-2",
          sourceRunId: "run-2",
        }),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.thread_interaction_answered",
      }),
    );
  });

  it("cancels question interactions and emits a continuation wake", async () => {
    const app = await createApp();

    const res = await request(app)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-2/cancel")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
    expect(mockInteractionService.cancelQuestions).toHaveBeenCalledWith(
      expect.objectContaining({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      "interaction-2",
      {},
      expect.objectContaining({ userId: "local-board" }),
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        reason: "issue_commented",
        payload: expect.objectContaining({
          interactionId: "interaction-2",
          interactionKind: "ask_user_questions",
          interactionStatus: "cancelled",
          sourceCommentId: "comment-2",
          sourceRunId: "run-2",
        }),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.thread_interaction_cancelled",
      }),
    );
  });

  it("accepts request confirmations and wakes the current assignee when configured for accept-only wakeups", async () => {
    mockInteractionService.acceptInteraction.mockResolvedValueOnce({
      interaction: {
        id: "interaction-3",
        companyId: "company-1",
        issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        kind: "request_confirmation",
        status: "accepted",
        continuationPolicy: "wake_assignee_on_accept",
        idempotencyKey: null,
        sourceCommentId: null,
        sourceRunId: "run-3",
        payload: {
          version: 1,
          prompt: "Apply this plan?",
        },
        result: {
          version: 1,
          outcome: "accepted",
        },
        createdAt: "2026-04-20T12:00:00.000Z",
        updatedAt: "2026-04-20T12:05:00.000Z",
        resolvedAt: "2026-04-20T12:05:00.000Z",
      },
      createdIssues: [],
    });
    const app = await createApp();

    const res = await request(app)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-3/accept")
      .send({});

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        reason: "issue_commented",
        payload: expect.objectContaining({
          interactionId: "interaction-3",
          interactionKind: "request_confirmation",
          interactionStatus: "accepted",
        }),
      }),
    );
  });

  it("forces a fresh workspace-aware session when accepting a planning confirmation", async () => {
    mockIssueService.getById.mockResolvedValueOnce(createIssue({ workMode: "planning" }));
    mockInteractionService.acceptInteraction.mockResolvedValueOnce({
      interaction: {
        id: "interaction-plan",
        companyId: "company-1",
        issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        kind: "request_confirmation",
        status: "accepted",
        continuationPolicy: "wake_assignee_on_accept",
        idempotencyKey: "confirmation:issue:plan:revision",
        sourceCommentId: null,
        sourceRunId: "run-plan",
        payload: {
          version: 1,
          prompt: "Approve this plan?",
          target: {
            type: "issue_document",
            issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            documentId: "document-plan",
            key: "plan",
            revisionId: "revision-plan",
            revisionNumber: 1,
          },
        },
        result: {
          version: 1,
          outcome: "accepted",
        },
        createdAt: "2026-04-20T12:00:00.000Z",
        updatedAt: "2026-04-20T12:05:00.000Z",
        resolvedAt: "2026-04-20T12:05:00.000Z",
      },
      createdIssues: [],
    });
    const app = await createApp();

    const res = await request(app)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-plan/accept")
      .send({});

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        reason: "issue_commented",
        contextSnapshot: expect.objectContaining({
          issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          interactionId: "interaction-plan",
          interactionKind: "request_confirmation",
          interactionStatus: "accepted",
          forceFreshSession: true,
          workspaceRefreshReason: "accepted_plan_confirmation",
        }),
      }),
    );
  });

  it("forces a fresh workspace-aware session when accepting a plan document confirmation on a standard-work issue", async () => {
    mockIssueService.getById.mockResolvedValueOnce(createIssue({ workMode: "standard" }));
    mockInteractionService.acceptInteraction.mockResolvedValueOnce({
      interaction: {
        id: "interaction-standard-plan",
        companyId: "company-1",
        issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        kind: "request_confirmation",
        status: "accepted",
        continuationPolicy: "wake_assignee_on_accept",
        idempotencyKey: "confirmation:issue:plan:revision-standard",
        sourceCommentId: null,
        sourceRunId: "run-standard-plan",
        payload: {
          version: 1,
          prompt: "Approve this plan?",
          target: {
            type: "issue_document",
            issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            documentId: "document-plan",
            key: "plan",
            revisionId: "revision-standard",
            revisionNumber: 2,
          },
        },
        result: {
          version: 1,
          outcome: "accepted",
        },
        createdAt: "2026-04-20T12:00:00.000Z",
        updatedAt: "2026-04-20T12:05:00.000Z",
        resolvedAt: "2026-04-20T12:05:00.000Z",
      },
      createdIssues: [],
    });
    const app = await createApp();

    const res = await request(app)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-standard-plan/accept")
      .send({});

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        reason: "issue_commented",
        contextSnapshot: expect.objectContaining({
          issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          interactionId: "interaction-standard-plan",
          interactionKind: "request_confirmation",
          interactionStatus: "accepted",
          forceFreshSession: true,
          workspaceRefreshReason: "accepted_plan_confirmation",
        }),
      }),
    );
  });

  it("wakes the returned agent when accepting an agent-authored confirmation from a board review assignee", async () => {
    mockIssueService.getById.mockResolvedValueOnce(createIssue({
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
    }));
    mockInteractionService.acceptInteraction.mockResolvedValueOnce({
      interaction: {
        id: "interaction-4",
        companyId: "company-1",
        issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        kind: "request_confirmation",
        status: "accepted",
        continuationPolicy: "wake_assignee_on_accept",
        idempotencyKey: null,
        sourceCommentId: null,
        sourceRunId: "run-4",
        payload: {
          version: 1,
          prompt: "Approve this plan?",
        },
        result: {
          version: 1,
          outcome: "accepted",
        },
        createdAt: "2026-04-20T12:00:00.000Z",
        updatedAt: "2026-04-20T12:05:00.000Z",
        resolvedAt: "2026-04-20T12:05:00.000Z",
      },
      createdIssues: [],
      continuationIssue: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        assigneeAgentId: CREATED_AGENT_ID,
        assigneeUserId: null,
        status: "todo",
      },
    });
    const app = await createApp();

    const res = await request(app)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-4/accept")
      .send({});

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      CREATED_AGENT_ID,
      expect.objectContaining({
        source: "automation",
        reason: "issue_commented",
        payload: expect.objectContaining({
          issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          interactionId: "interaction-4",
          interactionKind: "request_confirmation",
          interactionStatus: "accepted",
        }),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        details: expect.objectContaining({
          source: "request_confirmation_accept",
          assigneeAgentId: CREATED_AGENT_ID,
          assigneeUserId: null,
          _previous: expect.objectContaining({
            assigneeUserId: "local-board",
          }),
        }),
      }),
    );
  });

  it("does not emit a continuation wake when request confirmations are rejected", async () => {
    mockInteractionService.rejectInteraction.mockResolvedValueOnce({
      id: "interaction-3",
      companyId: "company-1",
      issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      kind: "request_confirmation",
      status: "rejected",
      continuationPolicy: "wake_assignee_on_accept",
      idempotencyKey: null,
      sourceCommentId: null,
      sourceRunId: "run-3",
      payload: {
        version: 1,
        prompt: "Apply this plan?",
      },
      result: {
        version: 1,
        outcome: "rejected",
        reason: "Needs changes",
      },
      createdAt: "2026-04-20T12:00:00.000Z",
      updatedAt: "2026-04-20T12:05:00.000Z",
      resolvedAt: "2026-04-20T12:05:00.000Z",
    });
    const app = await createApp();

    const res = await request(app)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-3/reject")
      .send({ reason: "Needs changes" });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("does not emit an accept-only continuation wake for rejected suggested tasks", async () => {
    mockInteractionService.rejectInteraction.mockResolvedValueOnce({
      id: "interaction-5",
      companyId: "company-1",
      issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      kind: "suggest_tasks",
      status: "rejected",
      continuationPolicy: "wake_assignee_on_accept",
      idempotencyKey: null,
      sourceCommentId: null,
      sourceRunId: "run-5",
      payload: {
        version: 1,
        tasks: [{ clientKey: "task-1", title: "One" }],
      },
      result: {
        version: 1,
        rejectionReason: "Not now",
      },
      createdAt: "2026-04-20T12:00:00.000Z",
      updatedAt: "2026-04-20T12:05:00.000Z",
      resolvedAt: "2026-04-20T12:05:00.000Z",
    });
    const app = await createApp();

    const res = await request(app)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-5/reject")
      .send({ reason: "Not now" });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("allows agent-authored interaction creation and stamps the active run id", async () => {
    const app = await createApp({
      type: "agent",
      agentId: CREATED_AGENT_ID,
      companyId: "company-1",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions")
      .send({
        kind: "suggest_tasks",
        idempotencyKey: "interaction:task-1",
        payload: {
          version: 1,
          tasks: [{ clientKey: "task-1", title: "One" }],
        },
      });

    expect(res.status).toBe(201);
    expect(mockInteractionService.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      expect.objectContaining({
        kind: "suggest_tasks",
        idempotencyKey: "interaction:task-1",
        sourceRunId: "run-1",
      }),
      {
        agentId: CREATED_AGENT_ID,
        userId: null,
      },
    );
  });

  describe("chain-of-command reviewer accept gate (SPC-6815)", () => {
    const REVIEWER_AGENT_ID = "33333333-3333-4333-8333-333333333333";
    const STRANGER_AGENT_ID = "44444444-4444-4444-8444-444444444444";

    function pendingRequestConfirmation(overrides: Record<string, unknown> = {}) {
      return {
        id: "interaction-confirmation",
        companyId: "company-1",
        issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        kind: "request_confirmation",
        status: "pending",
        continuationPolicy: "wake_assignee_on_accept",
        idempotencyKey: null,
        sourceCommentId: null,
        sourceRunId: "run-confirm",
        createdByAgentId: ASSIGNEE_AGENT_ID,
        createdByUserId: null,
        resolvedByAgentId: null,
        resolvedByUserId: null,
        title: null,
        summary: null,
        payload: { version: 1, prompt: "Confirm the work delivered for SPC-6776." },
        result: null,
        createdAt: "2026-05-30T12:00:00.000Z",
        updatedAt: "2026-05-30T12:00:00.000Z",
        ...overrides,
      };
    }

    it("permits a chain-of-command reviewer agent to accept their own request_confirmation", async () => {
      mockInteractionService.getById.mockResolvedValueOnce(pendingRequestConfirmation());
      mockAuthorizationService.isManagerOf.mockImplementation(
        async (_companyId: string, manager: string, target: string) =>
          manager === REVIEWER_AGENT_ID && target === ASSIGNEE_AGENT_ID,
      );
      mockInteractionService.acceptInteraction.mockResolvedValueOnce({
        interaction: { ...pendingRequestConfirmation(), status: "accepted", resolvedByAgentId: REVIEWER_AGENT_ID },
        createdIssues: [],
      });
      const app = await createApp({
        type: "agent",
        agentId: REVIEWER_AGENT_ID,
        companyId: "company-1",
        runId: "run-cto",
      });

      const res = await request(app)
        .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-confirmation/accept")
        .send({});

      expect(res.status).toBe(200);
      expect(mockInteractionService.acceptInteraction).toHaveBeenCalledWith(
        expect.objectContaining({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
        "interaction-confirmation",
        {},
        expect.objectContaining({ agentId: REVIEWER_AGENT_ID, userId: null }),
      );
    });

    it("permits a chain-of-command reviewer agent to reject their own request_confirmation", async () => {
      mockInteractionService.getById.mockResolvedValueOnce(pendingRequestConfirmation());
      mockAuthorizationService.isManagerOf.mockImplementation(
        async (_companyId: string, manager: string, target: string) =>
          manager === REVIEWER_AGENT_ID && target === ASSIGNEE_AGENT_ID,
      );
      mockInteractionService.rejectInteraction.mockResolvedValueOnce({
        ...pendingRequestConfirmation(),
        status: "rejected",
        resolvedByAgentId: REVIEWER_AGENT_ID,
        result: { version: 1, outcome: "rejected", reason: "Needs follow-up" },
      });
      const app = await createApp({
        type: "agent",
        agentId: REVIEWER_AGENT_ID,
        companyId: "company-1",
        runId: "run-cto",
      });

      const res = await request(app)
        .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-confirmation/reject")
        .send({ reason: "Needs follow-up" });

      expect(res.status).toBe(200);
      expect(mockInteractionService.rejectInteraction).toHaveBeenCalled();
    });

    it("denies a non-reviewer agent accept on request_confirmation", async () => {
      mockInteractionService.getById.mockResolvedValueOnce(pendingRequestConfirmation());
      mockAuthorizationService.isManagerOf.mockResolvedValue(false);
      const app = await createApp({
        type: "agent",
        agentId: STRANGER_AGENT_ID,
        companyId: "company-1",
        runId: "run-stranger",
      });

      const res = await request(app)
        .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-confirmation/accept")
        .send({});

      expect(res.status).toBe(403);
      expect(mockInteractionService.acceptInteraction).not.toHaveBeenCalled();
    });

    it("denies an agent accept on suggest_tasks even when in chain-of-command", async () => {
      mockInteractionService.getById.mockResolvedValueOnce({
        ...pendingRequestConfirmation(),
        id: "interaction-tasks",
        kind: "suggest_tasks",
        payload: { version: 1, tasks: [{ clientKey: "t", title: "T" }] },
      });
      mockAuthorizationService.isManagerOf.mockResolvedValue(true);
      const app = await createApp({
        type: "agent",
        agentId: REVIEWER_AGENT_ID,
        companyId: "company-1",
        runId: "run-cto",
      });

      const res = await request(app)
        .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-tasks/accept")
        .send({ selectedClientKeys: ["t"] });

      expect(res.status).toBe(403);
      expect(mockInteractionService.acceptInteraction).not.toHaveBeenCalled();
    });

    it("denies an agent respond on ask_user_questions (board only kind)", async () => {
      mockAuthorizationService.isManagerOf.mockResolvedValue(true);
      const app = await createApp({
        type: "agent",
        agentId: REVIEWER_AGENT_ID,
        companyId: "company-1",
        runId: "run-cto",
      });

      const res = await request(app)
        .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-questions/respond")
        .send({ answers: [{ questionId: "scope", optionIds: ["phase-1"] }] });

      expect(res.status).toBe(403);
      expect(mockInteractionService.answerQuestions).not.toHaveBeenCalled();
    });

    it("preserves board acceptance for request_confirmation without consulting the manager check", async () => {
      mockInteractionService.acceptInteraction.mockResolvedValueOnce({
        interaction: { ...pendingRequestConfirmation(), status: "accepted" },
        createdIssues: [],
      });
      const app = await createApp();

      const res = await request(app)
        .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-confirmation/accept")
        .send({});

      expect(res.status).toBe(200);
      expect(mockAuthorizationService.isManagerOf).not.toHaveBeenCalled();
      expect(mockInteractionService.getById).not.toHaveBeenCalled();
    });
  });

  describe("admin sweep of pending request_confirmation on terminal issues", () => {
    it("expires pending request_confirmation rows on done/cancelled issues for the company", async () => {
      mockInteractionService.sweepPendingRequestConfirmationsOnTerminalIssues.mockResolvedValueOnce({
        expired: [
          {
            id: "73ae1223",
            issueId: "spc-6776-issue",
            companyId: "company-1",
            kind: "request_confirmation",
            status: "expired",
            result: { version: 1, outcome: "superseded_by_terminal_issue", issueStatus: "done" },
          },
        ],
      });
      const app = await createApp();

      const res = await request(app)
        .post("/api/admin/companies/company-1/issue-thread-interactions/sweep-pending-on-terminal-issues")
        .send({});

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        expiredCount: 1,
        expired: [{ id: "73ae1223", issueId: "spc-6776-issue" }],
      });
      expect(mockInteractionService.sweepPendingRequestConfirmationsOnTerminalIssues).toHaveBeenCalledWith(
        { companyId: "company-1" },
        expect.objectContaining({ userId: "local-board" }),
      );
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.thread_interaction_expired",
          details: expect.objectContaining({
            interactionId: "73ae1223",
            source: "admin.sweep_pending_on_terminal_issues",
          }),
        }),
      );
    });

    it("rejects agents from invoking the sweep endpoint", async () => {
      const app = await createApp({
        type: "agent",
        agentId: "44444444-4444-4444-8444-444444444444",
        companyId: "company-1",
        runId: "run-x",
      });

      const res = await request(app)
        .post("/api/admin/companies/company-1/issue-thread-interactions/sweep-pending-on-terminal-issues")
        .send({});

      expect(res.status).toBe(403);
      expect(mockInteractionService.sweepPendingRequestConfirmationsOnTerminalIssues).not.toHaveBeenCalled();
    });
  });
});
