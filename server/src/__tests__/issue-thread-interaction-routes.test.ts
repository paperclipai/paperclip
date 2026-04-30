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
  create: vi.fn(),
  acceptInteraction: vi.fn(),
  acceptSuggestedTasks: vi.fn(),
  rejectInteraction: vi.fn(),
  rejectSuggestedTasks: vi.fn(),
  answerQuestions: vi.fn(),
  cancelQuestions: vi.fn(),
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
      hasPermission: vi.fn(async () => true),
    }),
    agentService: () => ({
      getById: vi.fn(async () => null),
      resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
        ambiguous: false,
        agent: { id: raw },
      })),
    }),
    clampIssueListLimit: (value: number) => value,
    ISSUE_LIST_DEFAULT_LIMIT: 500,
    ISSUE_LIST_MAX_LIMIT: 1000,
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
    mockInteractionService.listForIssue.mockResolvedValue([
      { id: "interaction-1", kind: "suggest_tasks", status: "pending" },
    ]);
    const app = await createApp();

    const listRes = await request(app).get("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions");
    expect(listRes.status).toBe(200);
    expect(listRes.body).toEqual([
      { id: "interaction-1", kind: "suggest_tasks", status: "pending" },
    ]);

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
});
