import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ASSIGNEE_AGENT_ID = "11111111-1111-4111-8111-111111111111";
const UNRELATED_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const CREATED_AGENT_ID = "22222222-2222-4222-8222-222222222222";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  listReviewAttention: vi.fn(),
}));

const mockInteractionService = vi.hoisted(() => ({
  listForIssue: vi.fn(),
  getForIssue: vi.fn(),
  create: vi.fn(),
  acceptInteraction: vi.fn(),
  acceptSuggestedTasks: vi.fn(),
  rejectInteraction: vi.fn(),
  rejectSuggestedTasks: vi.fn(),
  expireRequestConfirmationsSupersededByHistoricalComments: vi.fn(),
  expirePendingInteractionsForTerminalIssue: vi.fn(),
  answerQuestions: vi.fn(),
  submitItemVerdicts: vi.fn(),
  cancelQuestions: vi.fn(),
  withdrawInteraction: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
}));
const mockResolveTaskWatchdogMutationScope = vi.hoisted(() => vi.fn(async () => ({ kind: "none" })));
const mockResolveCoreTrustPreset = vi.hoisted(() => vi.fn(() => ({ kind: "standard" })));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockReviewTransition = vi.hoisted(() => ({
  value: null as null | { actorType: string; actorId: string; details: Record<string, unknown> },
}));
const mockDbSelectWhere = vi.hoisted(() => vi.fn(() => ({
  then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve([{ companyId: "company-1", agentId: CREATED_AGENT_ID, contextSnapshot: null }]).then(
      onFulfilled,
      onRejected,
    ),
})));
const mockDbSelectFrom = vi.hoisted(() => vi.fn(() => ({ where: mockDbSelectWhere })));
const mockDbSelect = vi.hoisted(() => vi.fn(() => ({ from: mockDbSelectFrom })));
const mockDb = vi.hoisted(() => ({
  select: mockDbSelect,
}));

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentTaskCompleted: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
}));

vi.mock("../services/task-watchdog-scope.js", () => ({
  TASK_WATCHDOG_ORIGIN_KIND: "task_watchdog",
  resolveTaskWatchdogMutationScope: mockResolveTaskWatchdogMutationScope,
  taskWatchdogScopeAllowsIssueMutation: vi.fn(async (_db, scope) => scope),
}));

vi.mock("../services/trust-preset-resolver.js", () => ({
  LOW_TRUST_ISSUE_ANCESTRY_MAX_DEPTH: 100,
  resolveCoreTrustPreset: mockResolveCoreTrustPreset,
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
      getById: vi.fn(async () => ({ id: CREATED_AGENT_ID, companyId: "company-1", permissions: null })),
      resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
        ambiguous: false,
        agent: { id: raw },
      })),
    }),
    clampIssueListLimit: (value: number) => value,
    companySkillService: () => ({
      completeTestRunForIssue: vi.fn(async () => null),
    }),
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
    taskWatchdogService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      upsertForIssue: vi.fn(),
      disableForIssue: vi.fn(async () => null),
    }),
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
}, routeOptions: Record<string, unknown> = {}) {
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
  app.use("/api", issueRoutes(mockDb as any, {} as any, routeOptions));
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
    mockResolveTaskWatchdogMutationScope.mockResolvedValue({ kind: "none" });
    mockResolveCoreTrustPreset.mockReturnValue({ kind: "standard" });
    mockIssueService.getById.mockResolvedValue(createIssue());
    mockIssueService.listReviewAttention.mockResolvedValue(new Map());
    mockInteractionService.listForIssue.mockResolvedValue([]);
    mockInteractionService.expireRequestConfirmationsSupersededByHistoricalComments.mockResolvedValue([]);
    mockInteractionService.expirePendingInteractionsForTerminalIssue.mockResolvedValue([]);
    mockInteractionService.getForIssue.mockResolvedValue({
      id: "interaction-withdraw",
      kind: "ask_user_questions",
      createdByAgentId: CREATED_AGENT_ID,
      sourceRunId: "run-1",
      requestedResolverPolicy: "board_or_agents",
      effectiveResolverPolicy: "board_or_agents",
      continuationPolicy: "wake_assignee",
      status: "pending",
      payload: { version: 1, questions: [] },
    });
    mockInteractionService.withdrawInteraction.mockResolvedValue({
      id: "interaction-withdraw",
      companyId: "company-1",
      issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      kind: "request_confirmation",
      createdByAgentId: CREATED_AGENT_ID,
      status: "cancelled",
      continuationPolicy: "wake_assignee",
      payload: { version: 1, prompt: "Proceed?" },
      result: { version: 1, outcome: "withdrawn", reason: "Replanning" },
    });
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
    mockInteractionService.submitItemVerdicts.mockResolvedValue({
      interaction: {
        id: "interaction-verdicts",
        companyId: "company-1",
        issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        kind: "request_item_verdicts",
        status: "pending",
        continuationPolicy: "wake_assignee",
        idempotencyKey: null,
        sourceCommentId: "comment-verdicts",
        sourceRunId: "run-verdicts",
        payload: {
          version: 1,
          prompt: "Review generated artifacts.",
          items: [
            { id: "api", label: "API route" },
            { id: "docs", label: "Docs" },
          ],
          verdicts: ["approve", "reject"],
          requireReasonOn: ["reject"],
          allowBulkApprove: true,
        },
        result: {
          version: 1,
          outcome: "resolved",
          complete: false,
          items: [
            {
              id: "docs",
              verdict: "reject",
              reason: "Missing examples",
              resolvedByUserId: "local-board",
              resolvedAt: "2026-04-20T12:06:00.000Z",
            },
          ],
        },
        createdAt: "2026-04-20T12:00:00.000Z",
        updatedAt: "2026-04-20T12:06:00.000Z",
        resolvedAt: null,
      },
      newlyResolvedItemIds: ["docs"],
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
    mockDbSelect.mockImplementation(() => ({ from: mockDbSelectFrom }));
    mockDbSelectFrom.mockImplementation(() => ({ where: mockDbSelectWhere }));
    mockDbSelectWhere.mockImplementation(() => ({
      then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve([{ companyId: "company-1", agentId: CREATED_AGENT_ID, contextSnapshot: null }]).then(
          onFulfilled,
          onRejected,
        ),
      orderBy: () => ({
        limit: () => Promise.resolve(mockReviewTransition.value ? [mockReviewTransition.value] : []),
      }),
    }));
    mockReviewTransition.value = null;
  });

  it("creates board-authored interactions", async () => {
    const app = await createApp();

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
  }, 10_000);

  it("does not run historical-comment catch-up or queue recovery from the interaction read path", async () => {
    mockIssueService.getById.mockResolvedValue(createIssue({
      status: "in_review",
      assigneeAgentId: ASSIGNEE_AGENT_ID,
    }));
    mockInteractionService.listForIssue.mockResolvedValue([]);

    await request(await createApp())
      .get("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions")
      .expect(200);

    expect(mockInteractionService.expireRequestConfirmationsSupersededByHistoricalComments).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("wakes the addressed agent when an interaction is created", async () => {
    mockInteractionService.create.mockResolvedValueOnce({
      id: "interaction-addressed",
      companyId: "company-1",
      issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      kind: "ask_user_questions",
      status: "pending",
      continuationPolicy: "wake_assignee",
      addresseeAgentId: ASSIGNEE_AGENT_ID,
      requestedResolverPolicy: "board_only",
      effectiveResolverPolicy: "board_only",
      idempotencyKey: null,
      sourceCommentId: null,
      sourceRunId: null,
      payload: { version: 1, questions: [] },
      result: null,
      createdAt: "2026-07-25T12:00:00.000Z",
      updatedAt: "2026-07-25T12:00:00.000Z",
    });
    const app = await createApp();

    const res = await request(app)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions")
      .send({
        kind: "ask_user_questions",
        addresseeAgentId: ASSIGNEE_AGENT_ID,
        payload: {
          version: 1,
          questions: [{
            id: "scope",
            prompt: "Which scope?",
            selectionMode: "single",
            options: [{ id: "phase-1", label: "Phase 1" }],
          }],
        },
      });

    expect(res.status).toBe(201);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        reason: "interaction_pending",
        idempotencyKey: "interaction-pending:interaction-addressed",
        payload: expect.objectContaining({
          issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          interactionId: "interaction-addressed",
        }),
        contextSnapshot: expect.objectContaining({ wakeReason: "interaction_pending" }),
      }),
    );
  });

  it("returns 400 for agent-addressed tool-action confirmations", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions")
      .send({
        kind: "request_confirmation",
        addresseeAgentId: ASSIGNEE_AGENT_ID,
        payload: {
          version: 1,
          prompt: "Run the tool?",
          toolAction: {
            version: 1,
            actionRequestId: "11111111-1111-4111-8111-111111111111",
            invocationId: "22222222-2222-4222-8222-222222222222",
            toolName: "send_email",
            toolDisplayName: "Send email",
            connectionId: "33333333-3333-4333-8333-333333333333",
            applicationId: "44444444-4444-4444-8444-444444444444",
            appDisplayName: "Gmail",
            risk: "write",
            previewMarkdown: "Send an email to the reviewed recipient.",
            argumentsSummaryJson: '{"to":"recipient@example.com"}',
            argumentsHash: "reviewed-arguments-hash",
            expiresAt: "2026-07-25T16:00:00.000Z",
          },
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("cannot be addressed");
    expect(mockInteractionService.create).not.toHaveBeenCalled();
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

  it("submits item verdicts and emits one continuation wake with resolved item ids", async () => {
    const app = await createApp();

    const res = await request(app)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-verdicts/verdicts")
      .send({
        verdicts: [{ id: "docs", verdict: "reject", reason: "Missing examples" }],
      });

    expect(res.status).toBe(200);
    expect(mockInteractionService.submitItemVerdicts).toHaveBeenCalledWith(
      expect.objectContaining({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      "interaction-verdicts",
      { verdicts: [{ id: "docs", verdict: "reject", reason: "Missing examples" }] },
      expect.objectContaining({ userId: "local-board" }),
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        reason: "issue_commented",
        idempotencyKey: expect.stringMatching(
          /^request_item_verdicts:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:interaction-verdicts:/,
        ),
        payload: expect.objectContaining({
          interactionId: "interaction-verdicts",
          interactionKind: "request_item_verdicts",
          interactionStatus: "pending",
          sourceCommentId: "comment-verdicts",
          sourceRunId: "run-verdicts",
          newlyResolvedItemIds: ["docs"],
          itemVerdicts: {
            newlyResolvedItemIds: ["docs"],
            coalesceWindowMs: 2000,
          },
        }),
        contextSnapshot: expect.objectContaining({
          interactionId: "interaction-verdicts",
          interactionKind: "request_item_verdicts",
          interactionStatus: "pending",
          newlyResolvedItemIds: ["docs"],
          itemVerdicts: {
            newlyResolvedItemIds: ["docs"],
            coalesceWindowMs: 2000,
          },
        }),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.thread_interaction_item_verdicts_submitted",
        details: expect.objectContaining({
          interactionKind: "request_item_verdicts",
          newlyResolvedItemCount: 1,
          newlyResolvedItemIds: ["docs"],
          complete: false,
        }),
      }),
    );
  });

  it("allows a board user to withdraw and wakes the assignee", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-withdraw/withdraw")
      .send({ reason: "Replanning" });

    expect(res.status).toBe(200);
    expect(mockInteractionService.withdrawInteraction).toHaveBeenCalledWith(
      expect.objectContaining({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      "interaction-withdraw",
      { reason: "Replanning" },
      expect.objectContaining({ userId: "local-board" }),
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(ASSIGNEE_AGENT_ID, expect.objectContaining({
      payload: expect.objectContaining({ interactionStatus: "cancelled" }),
    }));
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "issue.thread_interaction_withdrawn",
    }));
  });

  it("allows the creator agent to withdraw and wakes a different assignee", async () => {
    mockIssueService.getById.mockResolvedValueOnce(createIssue({ status: "in_review", reviewPolicy: null }));
    mockInteractionService.getForIssue.mockResolvedValueOnce({
      id: "interaction-withdraw",
      kind: "request_confirmation",
      status: "pending",
      createdByAgentId: CREATED_AGENT_ID,
      sourceRunId: "run-1",
      requestedResolverPolicy: "board_only",
      effectiveResolverPolicy: "board_only",
      payload: { version: 1, prompt: "Proceed?" },
    });
    const app = await createApp({ type: "agent", agentId: CREATED_AGENT_ID, companyId: "company-1", runId: "run-1" });
    const res = await request(app)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-withdraw/withdraw")
      .send({});
    expect(res.status).toBe(200);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(ASSIGNEE_AGENT_ID, expect.anything());
  });

  it("allows the assignee agent to withdraw without waking itself", async () => {
    mockIssueService.getById.mockResolvedValueOnce(createIssue({ status: "todo" }));
    const app = await createApp({ type: "agent", agentId: ASSIGNEE_AGENT_ID, companyId: "company-1", runId: "run-2" });
    const res = await request(app)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-withdraw/withdraw")
      .send({});
    expect(res.status).toBe(200);
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("rejects withdrawal by an unrelated agent", async () => {
    const app = await createApp({ type: "agent", agentId: "33333333-3333-4333-8333-333333333333", companyId: "company-1", runId: "run-3" });
    const res = await request(app)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-withdraw/withdraw")
      .send({});
    expect(res.status).toBe(403);
    expect(mockInteractionService.withdrawInteraction).not.toHaveBeenCalled();
  });

  it("rejects withdrawal by watchdog-scoped runs", async () => {
    mockResolveTaskWatchdogMutationScope.mockResolvedValueOnce({
      kind: "watchdog",
      watchdogId: "watchdog-1",
      companyId: "company-1",
      watchedIssueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      watchdogIssueId: null,
      stopFingerprint: "stop-1",
    });
    const app = await createApp({ type: "agent", agentId: ASSIGNEE_AGENT_ID, companyId: "company-1", runId: "run-watchdog" });
    const res = await request(app)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-withdraw/withdraw")
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Task-watchdog");
    expect(mockInteractionService.withdrawInteraction).not.toHaveBeenCalled();
  });

  it("rejects withdrawal by low-trust actors", async () => {
    mockResolveCoreTrustPreset.mockReturnValueOnce({ kind: "low_trust_review" });
    const app = await createApp({ type: "agent", agentId: ASSIGNEE_AGENT_ID, companyId: "company-1", runId: "run-low-trust" });
    const res = await request(app)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-withdraw/withdraw")
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Low-trust");
    expect(mockInteractionService.withdrawInteraction).not.toHaveBeenCalled();
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
    expect(mockHeartbeatService.wakeup.mock.calls[0]?.[1]?.payload).not.toHaveProperty("toolAction");
    expect(mockHeartbeatService.wakeup.mock.calls[0]?.[1]?.contextSnapshot).not.toHaveProperty("toolAction");
  });

  it("executes an accepted tool-action confirmation through the gateway callback", async () => {
    const approveToolActionRequest = vi.fn().mockResolvedValue({
      status: "executed",
      resultSummary: "Added row 42",
    });
    mockInteractionService.acceptInteraction.mockResolvedValueOnce({
      interaction: {
        id: "interaction-tool-action",
        companyId: "company-1",
        issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        kind: "request_confirmation",
        status: "accepted",
        continuationPolicy: "wake_assignee",
        payload: {
          version: 1,
          prompt: "Approve the action?",
          toolAction: {
            version: 1,
            actionRequestId: "action-request-1",
            toolName: "google_sheets_add_row",
          },
        },
        result: { version: 1, outcome: "accepted" },
      },
      createdIssues: [],
    });
    const app = await createApp(undefined, { approveToolActionRequest });

    const res = await request(app)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-tool-action/accept")
      .send({});

    expect(res.status).toBe(200);
    expect(approveToolActionRequest).toHaveBeenCalledWith({
      companyId: "company-1",
      issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      interactionId: "interaction-tool-action",
      actionRequestId: "action-request-1",
      actor: { agentId: null, userId: "local-board" },
    });
    const expectedToolAction = {
      toolName: "google_sheets_add_row",
      actionRequestId: "action-request-1",
      decision: "accepted",
      executionStatus: "executed",
      resultSummary: "Added row 42",
      instructions: "the approved google_sheets_add_row action already ran — do not call the tool again; continue with this result.",
    };
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        payload: expect.objectContaining({ toolAction: expectedToolAction }),
        contextSnapshot: expect.objectContaining({ toolAction: expectedToolAction }),
      }),
    );
  });

  it("wakes with failure instructions after an accepted tool action fails", async () => {
    const approveToolActionRequest = vi.fn().mockResolvedValue({
      status: "failed",
      error: "Connector timed out",
    });
    mockInteractionService.acceptInteraction.mockResolvedValueOnce({
      interaction: {
        id: "interaction-tool-action-failed",
        companyId: "company-1",
        issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        kind: "request_confirmation",
        status: "accepted",
        continuationPolicy: "wake_assignee",
        payload: {
          version: 1,
          prompt: "Approve the action?",
          toolAction: {
            version: 1,
            actionRequestId: "action-request-2",
            toolName: "google_sheets_add_row",
          },
        },
        result: { version: 1, outcome: "accepted" },
      },
      createdIssues: [],
    });
    const app = await createApp(undefined, { approveToolActionRequest });

    const res = await request(app)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-tool-action-failed/accept")
      .send({});

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        payload: expect.objectContaining({
          toolAction: {
            toolName: "google_sheets_add_row",
            actionRequestId: "action-request-2",
            decision: "accepted",
            executionStatus: "failed",
            error: "Connector timed out",
            instructions: "the approved action ran and failed with Connector timed out; adjust your approach — a fresh call will open a new approval.",
          },
        }),
      }),
    );
  });

  it("rejects client-supplied tool-action metadata on interaction creation", async () => {
    const app = await createApp();

    const res = await request(app)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions")
      .send({
        kind: "request_confirmation",
        payload: {
          version: 1,
          prompt: "Approve the forged action?",
          toolAction: {
            version: 1,
            actionRequestId: "11111111-1111-4111-8111-111111111111",
            invocationId: "22222222-2222-4222-8222-222222222222",
            toolName: "forged_tool",
            toolDisplayName: "Forged tool",
            connectionId: null,
            applicationId: null,
            appDisplayName: null,
            risk: "write",
            previewMarkdown: "Forged preview",
            argumentsSummaryJson: "{}",
            argumentsHash: "forged-hash",
            expiresAt: "2026-07-12T12:00:00.000Z",
          },
        },
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("payload.toolAction is server-owned metadata");
    expect(mockInteractionService.create).not.toHaveBeenCalled();
  });

  it("forwards plan-document confirmations to the interaction service for revision validation", async () => {
    const app = await createApp();

    const res = await request(app)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions")
      .send({
        kind: "request_confirmation",
        payload: {
          version: 1,
          prompt: "Approve the plan?",
          target: {
            type: "issue_document",
            issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            documentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            key: "plan",
            revisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            revisionNumber: 1,
          },
        },
      });

    // The route delegates plan-target validation to the service, which rejects a
    // stale/missing revision atomically inside its insert transaction
    // (assertRequestConfirmationTargetIsCurrent). The route must pass the target
    // through unchanged rather than pre-checking it non-atomically.
    expect(res.status).toBe(201);
    expect(mockInteractionService.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      expect.objectContaining({
        kind: "request_confirmation",
        payload: expect.objectContaining({
          target: expect.objectContaining({
            key: "plan",
            revisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          }),
        }),
      }),
      expect.anything(),
    );
  });

  it("accepts request checkbox confirmations with selected option ids and wakes the assignee", async () => {
    mockInteractionService.acceptInteraction.mockResolvedValueOnce({
      interaction: {
        id: "interaction-checkbox",
        companyId: "company-1",
        issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        kind: "request_checkbox_confirmation",
        status: "accepted",
        continuationPolicy: "wake_assignee",
        idempotencyKey: null,
        sourceCommentId: null,
        sourceRunId: "run-checkbox",
        payload: {
          version: 1,
          prompt: "Delete selected files?",
          options: [
            { id: "file-a", label: "a.txt" },
            { id: "file-b", label: "b.txt", description: "Generated build output" },
          ],
        },
        result: {
          version: 1,
          outcome: "accepted",
          selectedOptionIds: ["file-b"],
        },
        createdAt: "2026-04-20T12:00:00.000Z",
        updatedAt: "2026-04-20T12:05:00.000Z",
        resolvedAt: "2026-04-20T12:05:00.000Z",
      },
      createdIssues: [],
    });
    const app = await createApp();

    const res = await request(app)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-checkbox/accept")
      .send({ selectedOptionIds: ["file-b"] });

    expect(res.status).toBe(200);
    expect(mockInteractionService.acceptInteraction).toHaveBeenCalledWith(
      expect.objectContaining({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      "interaction-checkbox",
      { selectedOptionIds: ["file-b"] },
      expect.objectContaining({ userId: "local-board" }),
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        reason: "issue_commented",
        payload: expect.objectContaining({
          interactionId: "interaction-checkbox",
          interactionKind: "request_checkbox_confirmation",
          interactionStatus: "accepted",
          checkboxSelection: {
            prompt: "Delete selected files?",
            selectedOptionIds: ["file-b"],
            selectedOptions: [{ id: "file-b", label: "b.txt", description: "Generated build output" }],
          },
        }),
        contextSnapshot: expect.objectContaining({
          checkboxSelection: {
            prompt: "Delete selected files?",
            selectedOptionIds: ["file-b"],
            selectedOptions: [{ id: "file-b", label: "b.txt", description: "Generated build output" }],
          },
        }),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.thread_interaction_accepted",
        details: expect.objectContaining({
          interactionKind: "request_checkbox_confirmation",
          interactionStatus: "accepted",
        }),
      }),
    );
  });

  it("preserves accepted empty checkbox selections in assignee wake context", async () => {
    mockInteractionService.acceptInteraction.mockResolvedValueOnce({
      interaction: {
        id: "interaction-checkbox-empty",
        companyId: "company-1",
        issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        kind: "request_checkbox_confirmation",
        status: "accepted",
        continuationPolicy: "wake_assignee",
        idempotencyKey: null,
        sourceCommentId: null,
        sourceRunId: "run-checkbox",
        payload: {
          version: 1,
          prompt: "Delete selected files?",
          options: [
            { id: "file-a", label: "a.txt", description: "Temporary export" },
            { id: "file-b", label: "b.txt", description: "Generated build output" },
          ],
        },
        result: {
          version: 1,
          outcome: "accepted",
          selectedOptionIds: [],
        },
        createdAt: "2026-04-20T12:00:00.000Z",
        updatedAt: "2026-04-20T12:05:00.000Z",
        resolvedAt: "2026-04-20T12:05:00.000Z",
      },
      createdIssues: [],
    });
    const app = await createApp();

    const res = await request(app)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-checkbox-empty/accept")
      .send({ selectedOptionIds: [] });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        payload: expect.objectContaining({
          checkboxSelection: {
            prompt: "Delete selected files?",
            selectedOptionIds: [],
            selectedOptions: [],
          },
        }),
        contextSnapshot: expect.objectContaining({
          checkboxSelection: {
            prompt: "Delete selected files?",
            selectedOptionIds: [],
            selectedOptions: [],
          },
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
          planReviewInteraction: expect.objectContaining({
            id: "interaction-plan",
            kind: "request_confirmation",
            status: "accepted",
            acceptedTargetRevision: expect.objectContaining({
              issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              documentId: "document-plan",
              key: "plan",
              revisionId: "revision-plan",
              revisionNumber: 1,
            }),
            result: expect.objectContaining({
              outcome: "accepted",
            }),
          }),
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

  it("overrides accept-only continuation when rejection consumes the last review path", async () => {
    const issue = createIssue({ status: "in_review" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.listReviewAttention.mockResolvedValue(new Map([[
      issue.id,
      { state: "stalled", paths: [], reason: "review path consumed" },
    ]]));
    mockInteractionService.rejectInteraction.mockResolvedValueOnce({
      id: "interaction-last-review-path",
      companyId: "company-1",
      issueId: issue.id,
      kind: "request_confirmation",
      status: "rejected",
      continuationPolicy: "wake_assignee_on_accept",
      idempotencyKey: null,
      sourceCommentId: null,
      sourceRunId: "run-last-review-path",
      payload: { version: 1, prompt: "Approve this?" },
      result: { version: 1, outcome: "rejected", reason: "Needs changes" },
      createdAt: "2026-04-20T12:00:00.000Z",
      updatedAt: "2026-04-20T12:05:00.000Z",
      resolvedAt: "2026-04-20T12:05:00.000Z",
    });

    const res = await request(await createApp())
      .post(`/api/issues/${issue.id}/interactions/interaction-last-review-path/reject`)
      .send({ reason: "Needs changes" });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        payload: expect.objectContaining({
          reviewPathLost: true,
          reviewPathConsumedRef: "interaction-last-review-path",
        }),
        contextSnapshot: expect.objectContaining({
          reviewPathLost: true,
          reviewPathInstruction: expect.stringContaining("Restore a reviewer"),
        }),
      }),
    );
  });

  it("wakes with decline instructions when a tool-action confirmation is rejected", async () => {
    mockInteractionService.rejectInteraction.mockResolvedValueOnce({
      id: "interaction-tool-action-rejected",
      companyId: "company-1",
      issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      kind: "request_confirmation",
      status: "rejected",
      continuationPolicy: "wake_assignee",
      idempotencyKey: null,
      sourceCommentId: null,
      sourceRunId: "run-tool-action-rejected",
      payload: {
        version: 1,
        prompt: "Approve the action?",
        toolAction: {
          version: 1,
          actionRequestId: "action-request-3",
          toolName: "google_sheets_add_row",
        },
      },
      result: {
        version: 1,
        outcome: "rejected",
        reason: "Use the sandbox sheet instead",
      },
      createdAt: "2026-04-20T12:00:00.000Z",
      updatedAt: "2026-04-20T12:05:00.000Z",
      resolvedAt: "2026-04-20T12:05:00.000Z",
    });
    const app = await createApp();

    const res = await request(app)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-tool-action-rejected/reject")
      .send({ reason: "Use the sandbox sheet instead" });

    expect(res.status).toBe(200);
    const expectedToolAction = {
      toolName: "google_sheets_add_row",
      actionRequestId: "action-request-3",
      decision: "rejected",
      executionStatus: "rejected",
      declineReason: "Use the sandbox sheet instead",
      instructions: "the action was declined: Use the sandbox sheet instead; do not retry the same call — adjust your approach or mark the task blocked/in_review with the decline reason.",
    };
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        payload: expect.objectContaining({ toolAction: expectedToolAction }),
        contextSnapshot: expect.objectContaining({ toolAction: expectedToolAction }),
      }),
    );
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

  it("allows a different in-scope agent run to respond when policy permits", async () => {
    mockIssueService.getById.mockResolvedValueOnce(createIssue({ status: "todo" }));
    const app = await createApp({
      type: "agent",
      agentId: ASSIGNEE_AGENT_ID,
      companyId: "company-1",
      runId: "run-2",
    });

    const res = await request(app)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-2/respond")
      .send({ answers: [{ questionId: "scope", optionIds: ["phase-1"] }] });

    expect(res.status).toBe(200);
    expect(mockInteractionService.answerQuestions).toHaveBeenCalledWith(
      expect.anything(),
      "interaction-2",
      expect.anything(),
      expect.objectContaining({ agentId: ASSIGNEE_AGENT_ID, runId: "run-2", userId: null }),
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({ idempotencyKey: "interaction:interaction-2:answered" }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      actorType: "agent",
      agentId: ASSIGNEE_AGENT_ID,
      runId: "run-2",
      details: expect.objectContaining({ resolutionActorKind: "agent" }),
    }));
  });

  it("allows an agent to accept another agent's pending review confirmation by default", async () => {
    mockReviewTransition.value = {
      actorType: "agent",
      actorId: CREATED_AGENT_ID,
      details: { reviewInteractionId: "interaction-agent-review" },
    };
    mockIssueService.getById.mockResolvedValueOnce(createIssue({
      status: "in_review",
      reviewPolicy: null,
      createdByAgentId: CREATED_AGENT_ID,
      createdByUserId: null,
    }));
    mockInteractionService.getForIssue.mockResolvedValueOnce({
      id: "interaction-agent-review",
      kind: "request_confirmation",
      status: "pending",
      createdByAgentId: CREATED_AGENT_ID,
      sourceRunId: "run-1",
      requestedResolverPolicy: "board_only",
      effectiveResolverPolicy: "board_only",
      payload: { version: 1, prompt: "Approve this review?" },
    });
    mockInteractionService.acceptInteraction.mockResolvedValueOnce({
      interaction: {
        id: "interaction-agent-review",
        companyId: "company-1",
        issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        kind: "request_confirmation",
        status: "accepted",
        continuationPolicy: "none",
        requestedResolverPolicy: "board_only",
        effectiveResolverPolicy: "board_only",
        payload: { version: 1, prompt: "Approve this review?" },
        result: { version: 1, outcome: "accepted" },
      },
      createdIssues: [],
    });
    const app = await createApp({
      type: "agent",
      agentId: ASSIGNEE_AGENT_ID,
      companyId: "company-1",
      runId: "run-2",
    });

    const res = await request(app)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-agent-review/accept")
      .send({});

    expect(res.status).toBe(200);
    expect(mockInteractionService.acceptInteraction).toHaveBeenCalledWith(
      expect.anything(),
      "interaction-agent-review",
      {},
      {
        agentId: ASSIGNEE_AGENT_ID,
        runId: "run-2",
        userId: null,
        reviewVerdictAuthorized: true,
      },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      actorType: "agent",
      agentId: ASSIGNEE_AGENT_ID,
      details: expect.objectContaining({ resolutionActorKind: "agent" }),
    }));
  });

  it("allows an agent to reject a pending review confirmation by default", async () => {
    mockReviewTransition.value = {
      actorType: "agent",
      actorId: CREATED_AGENT_ID,
      details: { reviewInteractionId: "interaction-agent-reject" },
    };
    mockIssueService.getById.mockResolvedValueOnce(createIssue({
      status: "in_review",
      reviewPolicy: null,
      createdByAgentId: CREATED_AGENT_ID,
      createdByUserId: null,
    }));
    mockInteractionService.getForIssue.mockResolvedValueOnce({
      id: "interaction-agent-reject",
      kind: "request_confirmation",
      status: "pending",
      createdByAgentId: CREATED_AGENT_ID,
      sourceRunId: "run-1",
      requestedResolverPolicy: "board_only",
      effectiveResolverPolicy: "board_only",
      payload: { version: 1, prompt: "Approve this review?" },
    });
    const app = await createApp({
      type: "agent",
      agentId: ASSIGNEE_AGENT_ID,
      companyId: "company-1",
      runId: "run-2",
    });

    const res = await request(app)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-agent-reject/reject")
      .send({ reason: "Needs changes" });

    expect(res.status).toBe(200);
    expect(mockInteractionService.rejectInteraction).toHaveBeenCalledWith(
      expect.anything(),
      "interaction-agent-reject",
      { reason: "Needs changes" },
      expect.objectContaining({
        agentId: ASSIGNEE_AGENT_ID,
        reviewVerdictAuthorized: true,
      }),
    );
  });

  it("keeps an unrelated pending confirmation board-only on an in-review issue", async () => {
    mockReviewTransition.value = {
      actorType: "agent",
      actorId: CREATED_AGENT_ID,
      details: { reviewInteractionId: "interaction-agent-review" },
    };
    mockIssueService.getById.mockResolvedValueOnce(createIssue({
      status: "in_review",
      reviewPolicy: null,
      createdByAgentId: CREATED_AGENT_ID,
      createdByUserId: null,
    }));
    mockInteractionService.getForIssue.mockResolvedValueOnce({
      id: "interaction-unrelated-confirmation",
      kind: "request_confirmation",
      status: "pending",
      createdByAgentId: UNRELATED_AGENT_ID,
      sourceRunId: "run-1",
      requestedResolverPolicy: "board_only",
      effectiveResolverPolicy: "board_only",
      payload: { version: 1, prompt: "Approve an unrelated operation?" },
    });
    const app = await createApp({
      type: "agent",
      agentId: ASSIGNEE_AGENT_ID,
      companyId: "company-1",
      runId: "run-2",
    });

    const res = await request(app)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-unrelated-confirmation/accept")
      .send({});

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "This issue-thread interaction is board-only" });
    expect(mockInteractionService.acceptInteraction).not.toHaveBeenCalled();
  });

  it("keeps a same-requester sibling confirmation board-only", async () => {
    mockReviewTransition.value = {
      actorType: "agent",
      actorId: CREATED_AGENT_ID,
      details: { reviewInteractionId: "interaction-agent-review" },
    };
    mockIssueService.getById.mockResolvedValueOnce(createIssue({
      status: "in_review",
      reviewPolicy: null,
      createdByAgentId: CREATED_AGENT_ID,
      createdByUserId: null,
    }));
    mockInteractionService.getForIssue.mockResolvedValueOnce({
      id: "interaction-requester-sibling",
      kind: "request_confirmation",
      status: "pending",
      createdByAgentId: CREATED_AGENT_ID,
      sourceRunId: "run-1",
      requestedResolverPolicy: "board_only",
      effectiveResolverPolicy: "board_only",
      payload: { version: 1, prompt: "Approve a different operation?" },
    });
    const app = await createApp({
      type: "agent",
      agentId: ASSIGNEE_AGENT_ID,
      companyId: "company-1",
      runId: "run-2",
    });

    const res = await request(app)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-requester-sibling/accept")
      .send({});

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "This issue-thread interaction is board-only" });
    expect(mockInteractionService.acceptInteraction).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "it addresses a different agent",
      requesterAgentId: CREATED_AGENT_ID,
      interaction: {
        addresseeAgentId: "agent-other-reviewer",
        createdByAgentId: CREATED_AGENT_ID,
        sourceRunId: "run-1",
      },
      error: "Only the addressed agent or a board user may resolve this issue-thread interaction",
    },
    {
      name: "the agent created it",
      requesterAgentId: ASSIGNEE_AGENT_ID,
      interaction: { createdByAgentId: ASSIGNEE_AGENT_ID, sourceRunId: "run-1" },
      error: "Agents cannot resolve interactions they created",
    },
    {
      name: "the same run created it",
      requesterAgentId: CREATED_AGENT_ID,
      interaction: { createdByAgentId: CREATED_AGENT_ID, sourceRunId: "run-2" },
      error: "Agents cannot resolve interactions created by the same run",
    },
  ])("rejects an agent review verdict when $name", async ({ interaction, error, requesterAgentId }) => {
    mockReviewTransition.value = {
      actorType: "agent",
      actorId: requesterAgentId,
      details: { reviewInteractionId: "interaction-agent-review-scope" },
    };
    mockIssueService.getById.mockResolvedValueOnce(createIssue({
      status: "in_review",
      reviewPolicy: null,
      createdByAgentId: requesterAgentId,
      createdByUserId: null,
    }));
    mockInteractionService.getForIssue.mockResolvedValueOnce({
      id: "interaction-agent-review-scope",
      kind: "request_confirmation",
      status: "pending",
      requestedResolverPolicy: "board_only",
      effectiveResolverPolicy: "board_only",
      payload: { version: 1, prompt: "Approve this review?" },
      ...interaction,
    });
    const app = await createApp({
      type: "agent",
      agentId: ASSIGNEE_AGENT_ID,
      companyId: "company-1",
      runId: "run-2",
    });

    const res = await request(app)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-agent-review-scope/accept")
      .send({});

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error });
    expect(mockInteractionService.acceptInteraction).not.toHaveBeenCalled();
  });

  it("rejects an agent review-confirmation verdict under human_only with actionable copy", async () => {
    mockReviewTransition.value = {
      actorType: "agent",
      actorId: CREATED_AGENT_ID,
      details: { reviewInteractionId: "interaction-human-only" },
    };
    mockIssueService.getById.mockResolvedValueOnce(createIssue({
      status: "in_review",
      reviewPolicy: "human_only",
      createdByAgentId: CREATED_AGENT_ID,
      createdByUserId: null,
    }));
    mockInteractionService.getForIssue.mockResolvedValueOnce({
      id: "interaction-human-only",
      kind: "request_confirmation",
      status: "pending",
      createdByAgentId: CREATED_AGENT_ID,
      sourceRunId: "run-1",
      requestedResolverPolicy: "board_only",
      effectiveResolverPolicy: "board_only",
      payload: { version: 1, prompt: "Approve this review?" },
    });
    const app = await createApp({
      type: "agent",
      agentId: ASSIGNEE_AGENT_ID,
      companyId: "company-1",
      runId: "run-2",
    });

    const res = await request(app)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-human-only/accept")
      .send({});

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: expect.stringContaining("only an authenticated user"),
      details: {
        code: "review_policy_denied",
        policy: "human_only",
        allowedActor: "authenticated_user_with_issue_write_access",
        remediation: expect.stringContaining("Have an authenticated user"),
      },
    });
    expect(mockInteractionService.acceptInteraction).not.toHaveBeenCalled();
  });

  it.each([
    { action: "accept", body: {} },
    { action: "reject", body: { reason: "Needs changes" } },
  ])("rejects an agent $action verdict under human_only when a user review transition omitted the interaction binding", async ({ action, body }) => {
    mockReviewTransition.value = {
      actorType: "user",
      actorId: "local-board",
      details: { status: "in_review", _previous: { status: "in_progress" } },
    };
    mockIssueService.getById.mockResolvedValueOnce(createIssue({
      status: "in_review",
      reviewPolicy: "human_only",
      createdByAgentId: null,
      createdByUserId: "local-board",
    }));
    mockInteractionService.getForIssue.mockResolvedValueOnce({
      id: "interaction-user-review-unbound",
      kind: "request_confirmation",
      status: "pending",
      createdByAgentId: null,
      createdByUserId: "local-board",
      sourceRunId: null,
      requestedResolverPolicy: "board_or_agents",
      effectiveResolverPolicy: "board_or_agents",
      payload: { version: 1, prompt: "Approve this review?" },
    });
    const app = await createApp({
      type: "agent",
      agentId: ASSIGNEE_AGENT_ID,
      companyId: "company-1",
      runId: "run-2",
    });

    const res = await request(app)
      .post(`/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-user-review-unbound/${action}`)
      .send(body);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      details: {
        code: "review_policy_denied",
        policy: "human_only",
      },
    });
    expect(mockInteractionService.acceptInteraction).not.toHaveBeenCalled();
    expect(mockInteractionService.rejectInteraction).not.toHaveBeenCalled();
  });

  it("allows an unrelated agent-resolvable confirmation under a restrictive issue review policy", async () => {
    mockReviewTransition.value = {
      actorType: "user",
      actorId: "local-board",
      details: { status: "in_review", _previous: { status: "in_progress" } },
    };
    mockIssueService.getById.mockResolvedValueOnce(createIssue({
      status: "in_review",
      reviewPolicy: "human_only",
      createdByAgentId: null,
      createdByUserId: "local-board",
    }));
    mockInteractionService.getForIssue.mockResolvedValueOnce({
      id: "interaction-unrelated",
      kind: "request_confirmation",
      status: "pending",
      createdByAgentId: UNRELATED_AGENT_ID,
      createdByUserId: null,
      sourceRunId: "run-1",
      requestedResolverPolicy: "board_or_agents",
      effectiveResolverPolicy: "board_or_agents",
      payload: { version: 1, prompt: "Confirm an independent action?" },
    });
    mockInteractionService.acceptInteraction.mockResolvedValueOnce({
      interaction: {
        id: "interaction-unrelated",
        companyId: "company-1",
        issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        kind: "request_confirmation",
        status: "accepted",
        continuationPolicy: "none",
        idempotencyKey: null,
        sourceCommentId: null,
        sourceRunId: "run-1",
        payload: { version: 1, prompt: "Confirm an independent action?" },
        result: { version: 1, outcome: "accepted" },
        createdAt: "2026-04-20T12:00:00.000Z",
        updatedAt: "2026-04-20T12:05:00.000Z",
        resolvedAt: "2026-04-20T12:05:00.000Z",
      },
      createdIssues: [],
    });
    const app = await createApp({
      type: "agent",
      agentId: ASSIGNEE_AGENT_ID,
      companyId: "company-1",
      runId: "run-2",
    });

    const res = await request(app)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-unrelated/accept")
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockInteractionService.acceptInteraction).toHaveBeenCalled();
  });

  it("allows only the addressed agent or board to resolve an addressed interaction", async () => {
    const addressed = {
      id: "interaction-addressed",
      kind: "ask_user_questions",
      createdByAgentId: CREATED_AGENT_ID,
      addresseeAgentId: ASSIGNEE_AGENT_ID,
      sourceRunId: "run-1",
      requestedResolverPolicy: "board_or_agents",
      effectiveResolverPolicy: "board_or_agents",
      payload: { version: 1, questions: [] },
    };
    mockInteractionService.getForIssue
      .mockResolvedValueOnce(addressed)
      .mockResolvedValueOnce(addressed)
      .mockResolvedValueOnce(addressed);
    mockIssueService.getById
      .mockResolvedValueOnce(createIssue({ status: "todo" }))
      .mockResolvedValueOnce(createIssue({ status: "todo" }))
      .mockResolvedValueOnce(createIssue({ status: "todo" }));

    const addresseeApp = await createApp({
      type: "agent",
      agentId: ASSIGNEE_AGENT_ID,
      companyId: "company-1",
      runId: "run-2",
    });
    const addressee = await request(addresseeApp)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-addressed/respond")
      .send({ answers: [] });
    expect(addressee.status).toBe(200);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({ idempotencyKey: "interaction:interaction-2:answered" }),
    );

    const unrelatedApp = await createApp({
      type: "agent",
      agentId: UNRELATED_AGENT_ID,
      companyId: "company-1",
      runId: "run-3",
    });
    const unrelated = await request(unrelatedApp)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-addressed/respond")
      .send({ answers: [] });
    expect(unrelated.status).toBe(403);
    expect(unrelated.body.error).toContain("addressed agent");

    const boardApp = await createApp();
    const board = await request(boardApp)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-addressed/respond")
      .send({ answers: [] });
    expect(board.status).toBe(200);
  });

  it("blocks creator-agent self-resolution", async () => {
    mockIssueService.getById.mockResolvedValueOnce(createIssue({
      status: "todo",
      assigneeAgentId: CREATED_AGENT_ID,
    }));
    const app = await createApp({
      type: "agent",
      agentId: CREATED_AGENT_ID,
      companyId: "company-1",
      runId: "run-9",
    });
    const res = await request(app)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-2/respond")
      .send({ answers: [] });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("created");
    expect(mockInteractionService.answerQuestions).not.toHaveBeenCalled();
  });

  it("blocks same-run resolution and requires a resolver run id", async () => {
    mockInteractionService.getForIssue.mockResolvedValueOnce({
      id: "interaction-2",
      kind: "ask_user_questions",
      createdByAgentId: CREATED_AGENT_ID,
      sourceRunId: "run-2",
      requestedResolverPolicy: "board_or_agents",
      effectiveResolverPolicy: "board_or_agents",
      payload: { version: 1, questions: [] },
    });
    mockIssueService.getById.mockResolvedValueOnce(createIssue({ status: "todo" }));
    const sameRunApp = await createApp({
      type: "agent",
      agentId: ASSIGNEE_AGENT_ID,
      companyId: "company-1",
      runId: "run-2",
    });
    const sameRun = await request(sameRunApp)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-2/respond")
      .send({ answers: [] });
    expect(sameRun.status).toBe(403);
    expect(sameRun.body.error).toContain("same run");

    mockIssueService.getById.mockResolvedValueOnce(createIssue({ status: "todo" }));
    const missingRunApp = await createApp({
      type: "agent",
      agentId: ASSIGNEE_AGENT_ID,
      companyId: "company-1",
    });
    const missingRun = await request(missingRunApp)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-2/respond")
      .send({ answers: [] });
    expect(missingRun.status).toBe(401);
  });

  it("blocks board-only and tool-action interactions for agents", async () => {
    mockInteractionService.getForIssue
      .mockResolvedValueOnce({
        id: "interaction-1",
        kind: "request_confirmation",
        createdByAgentId: CREATED_AGENT_ID,
        sourceRunId: "run-1",
        requestedResolverPolicy: "board_or_agents",
        effectiveResolverPolicy: "board_only",
        payload: { version: 1, prompt: "Proceed?" },
      })
      .mockResolvedValueOnce({
        id: "interaction-tool",
        kind: "request_confirmation",
        createdByAgentId: CREATED_AGENT_ID,
        sourceRunId: "run-1",
        requestedResolverPolicy: "board_or_agents",
        effectiveResolverPolicy: "board_or_agents",
        payload: { version: 1, prompt: "Run?", toolAction: { actionRequestId: "action-1" } },
      });
    mockIssueService.getById
      .mockResolvedValueOnce(createIssue({ status: "todo" }))
      .mockResolvedValueOnce(createIssue({ status: "todo" }));
    const app = await createApp({
      type: "agent",
      agentId: ASSIGNEE_AGENT_ID,
      companyId: "company-1",
      runId: "run-2",
    });

    const capped = await request(app)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-1/accept")
      .send({});
    expect(capped.status).toBe(403);
    expect(capped.body.error).toContain("board-only");

    const toolAction = await request(app)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-tool/accept")
      .send({});
    expect(toolAction.status).toBe(403);
    expect(toolAction.body.error).toContain("Tool-action");
  });

  it("explicitly blocks watchdog-scoped and low-trust resolver agents", async () => {
    mockIssueService.getById.mockResolvedValue(createIssue({ status: "todo" }));
    const actor = {
      type: "agent",
      agentId: ASSIGNEE_AGENT_ID,
      companyId: "company-1",
      runId: "run-2",
    };

    mockResolveTaskWatchdogMutationScope.mockResolvedValueOnce({
      kind: "watchdog",
      watchdogId: "watchdog-1",
      companyId: "company-1",
      watchedIssueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      watchdogIssueId: null,
      stopFingerprint: "stop-1",
    });
    const watchdogApp = await createApp(actor);
    const watchdog = await request(watchdogApp)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-2/respond")
      .send({ answers: [] });
    expect(watchdog.status).toBe(403);
    expect(watchdog.body.error).toContain("watchdog");

    mockResolveCoreTrustPreset.mockReturnValueOnce({ kind: "low_trust_review" });
    const lowTrustApp = await createApp(actor);
    const lowTrust = await request(lowTrustApp)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/interaction-2/respond")
      .send({ answers: [] });
    expect(lowTrust.status).toBe(403);
    expect(lowTrust.body.error).toContain("Low-trust");
    expect(mockInteractionService.answerQuestions).not.toHaveBeenCalled();
  });
});
