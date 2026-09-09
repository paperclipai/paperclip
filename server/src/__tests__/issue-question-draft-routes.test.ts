import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";

const CREATED_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const ISSUE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INTERACTION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RUN_1 = "d1111111-1111-4111-8111-111111111111";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  listReviewAttention: vi.fn(),
  addComment: vi.fn(),
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
  skipInteraction: vi.fn(),
  withdrawInteraction: vi.fn(),
  recordSecretProposalExecutionResult: vi.fn(),
}));

const mockDraftService = vi.hoisted(() => ({
  get: vi.fn(),
  upsert: vi.fn(),
  remove: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  cancelRun: vi.fn(async () => null),
}));
const mockRequestNativeQuestionRunCancellation = vi.hoisted(() =>
  vi.fn(async () => null as string | null)
);

vi.mock("../services/native-runtime/native-question-bridge.js", () => ({
  deliverNativeQuestionResponse: vi.fn(async () => "not_native"),
  requestNativeQuestionRunCancellation: mockRequestNativeQuestionRunCancellation,
  validateNativeQuestionResponseInput: vi.fn(),
}));
const mockQuestionResponseDeliveries = vi.hoisted(() => ({
  deliver: vi.fn(async () => null),
}));
const mockResolveTaskWatchdogMutationScope = vi.hoisted(() => vi.fn(async () => ({ kind: "none" })));
const mockResolveCoreTrustPreset = vi.hoisted(() => vi.fn(() => ({ kind: "standard" })));
const mockRunAttribution = vi.hoisted(() => ({
  value: {
    companyId: "company-1",
    agentId: "22222222-2222-4222-8222-222222222222",
    responsibleUserId: null,
  } as Record<string, unknown> | null,
}));
const mockAccessDecide = vi.hoisted(() => vi.fn(async (input: { action?: string }) => ({
  allowed: true,
  action: input.action,
  reason: "allow_explicit_grant",
  explanation: "Allowed by test grant.",
})));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockDbSelectWhere = vi.hoisted(() => vi.fn(() => ({
  then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve([{ companyId: "company-1", agentId: CREATED_AGENT_ID, contextSnapshot: null }]).then(
      onFulfilled,
      onRejected,
    ),
})));
const mockDbSelectFrom = vi.hoisted(() => vi.fn(() => ({ where: mockDbSelectWhere })));
const mockDbSelect = vi.hoisted(() => vi.fn(() => ({ from: mockDbSelectFrom })));

const mockCrossIssueInfluence = vi.hoisted(() => ({
  sourceIssueId: null as string | null,
  priorCount: 0,
  inserted: [] as Array<Record<string, unknown>>,
}));
const mockDbTransaction = vi.hoisted(() => vi.fn(async (callback: (tx: unknown) => unknown) => callback({
  select: (selection: Record<string, unknown>) => ({
    from: () => ({
      where: () => {
        if (Object.keys(selection).includes("count")) {
          return {
            then: (resolve: (rows: unknown[]) => unknown) =>
              resolve([{ count: mockCrossIssueInfluence.priorCount }]),
          };
        }
        const run = mockRunAttribution.value;
        return {
          for: () => ({
            then: (resolve: (rows: unknown[]) => unknown) => resolve(run
              ? [{
                  id: run.runId ?? null,
                  companyId: run.companyId ?? null,
                  agentId: run.agentId ?? null,
                  responsibleUserId: run.responsibleUserId ?? null,
                  contextSnapshot: { issueId: mockCrossIssueInfluence.sourceIssueId },
                }]
              : []),
          }),
        };
      },
    }),
  }),
  insert: () => ({
    values: async (value: Record<string, unknown>) => {
      mockCrossIssueInfluence.inserted.push(value);
      if (value.action === "issue.cross_issue_influence_observed") mockCrossIssueInfluence.priorCount += 1;
    },
  }),
})));
const mockDb = vi.hoisted(() => ({
  select: mockDbSelect,
  transaction: mockDbTransaction,
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
  vi.doMock("../services/question-response-delivery.js", () => ({
    questionResponseDeliveryService: () => mockQuestionResponseDeliveries,
  }));
  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1" })),
    }),
    accessService: () => ({
      canUser: vi.fn(async () => true),
      decide: mockAccessDecide,
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
    questionDraftService: () => mockDraftService,
    taskWatchdogService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      upsertForIssue: vi.fn(),
      disableForIssue: vi.fn(async () => null),
      revalidateMutationScope: vi.fn(async (scope: unknown) => ({ allowed: true, scope })),
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
    id: ISSUE_ID,
    companyId: "company-1",
    status: "in_progress",
    workMode: "standard",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-1714",
    title: "Persist drafts",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    ...overrides,
  };
}

function pendingQuestionInteraction(overrides: Record<string, unknown> = {}) {
  return {
    id: INTERACTION_ID,
    companyId: "company-1",
    issueId: ISSUE_ID,
    kind: "ask_user_questions",
    status: "pending",
    continuationPolicy: "wake_assignee",
    requestedResolverPolicy: "human_only",
    effectiveResolverPolicy: "human_only",
    resolverPolicyProvenance: "requested",
    createdByAgentId: CREATED_AGENT_ID,
    createdByUserId: null,
    sourceRunId: RUN_1,
    addresseeAgentId: null,
    addresseeUserId: null,
    payload: {
      version: 1,
      questions: [
        {
          id: "q1",
          prompt: "Pick one",
          selectionMode: "single",
          options: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
        },
      ],
    },
    result: null,
    ...overrides,
  };
}

const BOARD_ACTOR = {
  type: "board",
  userId: "local-board",
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
};

const AGENT_ACTOR = {
  type: "agent",
  agentId: CREATED_AGENT_ID,
  companyId: "company-1",
  runId: RUN_1,
  source: "agent_key",
};

async function createApp(actor: Record<string, unknown> = BOARD_ACTOR) {
  if (actor.type === "agent") {
    mockRunAttribution.value = {
      runId: actor.runId,
      companyId: actor.companyId ?? "company-1",
      agentId: actor.agentId,
      responsibleUserId: actor.onBehalfOfUserId ?? null,
    };
  }
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
  app.use("/api", issueRoutes(mockDb as any, {} as any, {}));
  app.use(errorHandler);
  return app;
}

describe.sequential("issue question draft routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../services/index.js");
    registerModuleMocks();
    vi.resetAllMocks();
    mockRunAttribution.value = {
      companyId: "company-1",
      agentId: CREATED_AGENT_ID,
      responsibleUserId: null,
    };
    mockResolveTaskWatchdogMutationScope.mockResolvedValue({ kind: "none" });
    mockResolveCoreTrustPreset.mockReturnValue({ kind: "standard" });
    mockAccessDecide.mockImplementation(async (input: { action?: string }) => ({
      allowed: true,
      action: input.action,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant.",
    }));
    mockIssueService.getById.mockResolvedValue(createIssue());
    mockInteractionService.getForIssue.mockResolvedValue(pendingQuestionInteraction());
    mockDraftService.get.mockResolvedValue(null);
    mockDraftService.remove.mockResolvedValue(true);
    mockDraftService.upsert.mockImplementation(async (args: {
      companyId: string;
      issueId: string;
      interaction: { id: string };
      userId: string;
      input: { answers: unknown[]; expectedRevision: number };
    }) => ({
      interactionId: args.interaction.id,
      issueId: args.issueId,
      revision: 1,
      answers: args.input.answers,
      updatedAt: new Date().toISOString(),
    }));
  });

  it("returns the caller's draft scoped to company, issue, interaction, and user", async () => {
    mockDraftService.get.mockResolvedValue({
      interactionId: INTERACTION_ID,
      issueId: ISSUE_ID,
      revision: 2,
      answers: [{ questionId: "q1", optionIds: ["a"] }],
      updatedAt: "2026-09-09T08:00:00.000Z",
    });
    const app = await createApp();

    const res = await request(app).get(`/api/issues/${ISSUE_ID}/interactions/${INTERACTION_ID}/draft`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ revision: 2, interactionId: INTERACTION_ID });
    expect(mockDraftService.get).toHaveBeenCalledWith({
      companyId: "company-1",
      issueId: ISSUE_ID,
      interactionId: INTERACTION_ID,
      userId: "local-board",
    });
  });

  it("returns 404 when the caller has no draft", async () => {
    const app = await createApp();

    const res = await request(app).get(`/api/issues/${ISSUE_ID}/interactions/${INTERACTION_ID}/draft`);

    expect(res.status).toBe(404);
  });

  it("rejects agent reads and writes, including draft reads", async () => {
    const app = await createApp(AGENT_ACTOR);

    const read = await request(app).get(`/api/issues/${ISSUE_ID}/interactions/${INTERACTION_ID}/draft`);
    const write = await request(app)
      .put(`/api/issues/${ISSUE_ID}/interactions/${INTERACTION_ID}/draft`)
      .send({ answers: [], expectedRevision: 0 });
    const remove = await request(app).delete(`/api/issues/${ISSUE_ID}/interactions/${INTERACTION_ID}/draft`);

    expect(read.status).toBe(403);
    expect(write.status).toBe(403);
    expect(remove.status).toBe(403);
    expect(mockDraftService.get).not.toHaveBeenCalled();
    expect(mockDraftService.upsert).not.toHaveBeenCalled();
    expect(mockDraftService.remove).not.toHaveBeenCalled();
  });

  it("saves partial drafts without activity or continuation side effects", async () => {
    const app = await createApp();

    const res = await request(app)
      .put(`/api/issues/${ISSUE_ID}/interactions/${INTERACTION_ID}/draft`)
      .send({ answers: [{ questionId: "q1", optionIds: [] }], expectedRevision: 0 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ revision: 1 });
    expect(mockDraftService.upsert).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "company-1",
      issueId: ISSUE_ID,
      userId: "local-board",
    }));
    expect(mockLogActivity).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    expect(mockInteractionService.answerQuestions).not.toHaveBeenCalled();
  });


  it("rejects draft writes once the question is terminal", async () => {
    mockInteractionService.getForIssue.mockResolvedValue(
      pendingQuestionInteraction({ status: "answered", result: { version: 1, answers: [] } }),
    );
    const app = await createApp();

    const write = await request(app)
      .put(`/api/issues/${ISSUE_ID}/interactions/${INTERACTION_ID}/draft`)
      .send({ answers: [], expectedRevision: 0 });
    const read = await request(app).get(`/api/issues/${ISSUE_ID}/interactions/${INTERACTION_ID}/draft`);

    expect(write.status).toBe(409);
    expect(read.status).toBe(404);
    expect(mockDraftService.upsert).not.toHaveBeenCalled();
  });


  it("rejects malformed draft bodies before reaching storage", async () => {
    const app = await createApp();

    const res = await request(app)
      .put(`/api/issues/${ISSUE_ID}/interactions/${INTERACTION_ID}/draft`)
      .send({ answers: [{ questionId: "q1" }], expectedRevision: 0 });

    expect(res.status).toBe(400);
    expect(mockDraftService.upsert).not.toHaveBeenCalled();
  });

  it("rejects non-question interactions and enforces the addressed audience", async () => {
    const app = await createApp();

    mockInteractionService.getForIssue.mockResolvedValue(
      pendingQuestionInteraction({ kind: "request_confirmation" }),
    );
    const wrongKind = await request(app)
      .put(`/api/issues/${ISSUE_ID}/interactions/${INTERACTION_ID}/draft`)
      .send({ answers: [], expectedRevision: 0 });
    expect(wrongKind.status).toBe(422);

    mockInteractionService.getForIssue.mockResolvedValue(
      pendingQuestionInteraction({ addresseeUserId: "someone-else" }),
    );
    const wrongUser = await request(app).get(
      `/api/issues/${ISSUE_ID}/interactions/${INTERACTION_ID}/draft`,
    );
    expect(wrongUser.status).toBe(403);
  });

  it("deletes the caller's draft idempotently", async () => {
    const app = await createApp();

    const first = await request(app).delete(`/api/issues/${ISSUE_ID}/interactions/${INTERACTION_ID}/draft`);
    mockDraftService.remove.mockResolvedValue(false);
    const second = await request(app).delete(`/api/issues/${ISSUE_ID}/interactions/${INTERACTION_ID}/draft`);

    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    expect(mockDraftService.remove).toHaveBeenCalledWith({
      companyId: "company-1",
      issueId: ISSUE_ID,
      interactionId: INTERACTION_ID,
      userId: "local-board",
    });
  });
});
