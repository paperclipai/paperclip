import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ASSIGNEE_AGENT_ID = "11111111-1111-4111-8111-111111111111";
const PREVIOUS_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const MENTIONED_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const SOURCE_RUN_ID = "44444444-4444-4444-8444-444444444444";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  getByIdForUpdate: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  getDependencyReadiness: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  getCurrentScheduledRetry: vi.fn(),
  listReviewAttention: vi.fn(),
}));

const mockPauseGate = vi.hoisted(() => vi.fn(async (): Promise<Record<string, unknown> | null> => null));
const mockAccessDecide = vi.hoisted(() => vi.fn(async (input: { action?: string; resource?: { issueId?: string } }) => ({
  allowed: true,
  action: input.action,
  reason: "allow_explicit_grant",
  explanation: "Allowed by test grant.",
})));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
  repairBlockedWithNoBlockers: vi.fn(async () => ({ repaired: 0, issueIds: [] })),
}));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expirePendingInteractionsForTerminalIssue: vi.fn(async () => []),
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));
const mockRunnerGoalService = vi.hoisted(() => ({
  projection: vi.fn(async () => null),
  act: vi.fn(),
}));

vi.mock("../services/native-runtime/native-question-bridge.js", () => ({
  deliverNativeQuestionResponse: vi.fn(async () => "not_native"),
  nativeQuestionRunToCancel: vi.fn(async () => null),
  validateNativeQuestionResponseInput: vi.fn(),
}));

vi.mock("../services/runner-goals.js", () => ({
  runnerGoalService: () => mockRunnerGoalService,
  RunnerGoalActionError: class RunnerGoalActionError extends Error {},
  RunnerGoalConflictError: class RunnerGoalConflictError extends Error {},
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1" })),
  }),
  accessService: () => ({
    canUser: vi.fn(async () => true),
    decide: mockAccessDecide,
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => ({
    getById: vi.fn(async () => null),
    resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
      ambiguous: false,
      agent: { id: raw },
    })),
  }),
  companySkillService: () => ({
    completeTestRunForIssue: vi.fn(async () => null),
  }),
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
  issueTreeControlService: () => ({ getActivePauseHoldGate: mockPauseGate }),
  issueService: () => mockIssueService,
  issueThreadInteractionService: () => mockIssueThreadInteractionService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({}),
  questionResponseDeliveryService: () => ({
    deliver: vi.fn(async () => undefined),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

function registerModuleMocks() {
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
      getById: vi.fn(async () => null),
      resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
        ambiguous: false,
        agent: { id: raw },
      })),
    }),
    companySkillService: () => ({
      completeTestRunForIssue: vi.fn(async () => null),
    }),
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
    issueTreeControlService: () => ({ getActivePauseHoldGate: mockPauseGate }),
  issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: vi.fn(async () => undefined),
    projectService: () => ({}),
    questionResponseDeliveryService: () => ({
      deliver: vi.fn(async () => undefined),
    }),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  }));
}

async function createApp(transaction: (callback: (tx: Record<string, never>) => Promise<unknown>) => Promise<unknown> =
  async (callback) => callback({})) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      runId: req.header("x-paperclip-run-id") ?? null,
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({
    transaction,
  } as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    companyId: "company-1",
    status: "todo",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: null,
    assigneeUserId: "local-board",
    createdByUserId: "local-board",
    identifier: "PAP-999",
    title: "Wake test",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    ...overrides,
  };
}

describe("issue update comment wakeups", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockAccessDecide.mockImplementation(async (input) => ({ allowed: true, action: input.action, reason: "allow_explicit_grant", explanation: "Allowed by test grant." }));
    mockPauseGate.mockResolvedValue(null);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockIssueService.getByIdForUpdate.mockImplementation(async () => mockIssueService.getById());
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.getDependencyReadiness.mockResolvedValue({ unresolvedBlockerCount: 1 });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.getCurrentScheduledRetry.mockResolvedValue(null);
    mockIssueService.listReviewAttention.mockResolvedValue(new Map());
  });

  it.each(["post", "patch"] as const)("rejects %s board messages under an inherited pause before any mutation", async (method) => {
    const existing = makeIssue();
    mockIssueService.getById.mockResolvedValue(existing);
    mockPauseGate.mockResolvedValue({ holdId: "hold-1", rootIssueId: "parent-1" });
    const app = await createApp();
    const res = method === "post"
      ? await request(app).post(`/api/issues/${existing.id}/comments`).send({ body: "go", reopen: true, interrupt: true })
      : await request(app).patch(`/api/issues/${existing.id}`).send({ comment: "go", assigneeAgentId: ASSIGNEE_AGENT_ID, status: "todo" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Task is paused. Resume it before sending a message.");
    expect(res.body.details.rootIssueId).toBe("parent-1");
    expect(mockPauseGate).toHaveBeenCalledWith(existing.companyId, existing.id);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it.each(["done", "cancelled"])(
    "keeps %s assignment-only updates from waking completed work",
    async (status) => {
      // A parent may restore the assignee after releasing a completed child.
      // That is recordkeeping, not a request to execute the child again.
      const existing = makeIssue({ status, assigneeAgentId: null, assigneeUserId: null });
      const updated = makeIssue({ status, assigneeAgentId: ASSIGNEE_AGENT_ID, assigneeUserId: null });
      mockIssueService.getById.mockResolvedValue(existing);
      mockIssueService.update.mockResolvedValue(updated);

      const res = await request(await createApp())
        .patch(`/api/issues/${existing.id}`)
        .send({ assigneeAgentId: ASSIGNEE_AGENT_ID });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status, assigneeAgentId: ASSIGNEE_AGENT_ID });
      await new Promise((resolve) => setImmediate(resolve));
      expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])("still wakes explicitly reopened work (reassigned: %s)", async (reassigned) => {
    const existing = makeIssue({ status: "done", assigneeAgentId: PREVIOUS_AGENT_ID, assigneeUserId: null });
    const agentId = reassigned ? ASSIGNEE_AGENT_ID : PREVIOUS_AGENT_ID;
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(makeIssue({ status: "todo", assigneeAgentId: agentId, assigneeUserId: null }));

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({ status: "todo", ...(reassigned ? { assigneeAgentId: agentId } : {}) });

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      reason: reassigned ? "issue_assigned" : "issue_status_changed",
      payload: expect.objectContaining({ issueId: existing.id }),
    }));
  });

  it.each([null, "active"] as const)("includes the new comment and shared session key in assignment wakes (external: %s)", async (externalConversationState) => {
    const existing = makeIssue({ externalConversationState });
    const updated = makeIssue({
      externalConversationState,
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
      assigneeAdapterOverrides: { adapterConfig: { model: "gpt-6-astra", modelReasoningEffort: "ultra", fastMode: true } },
    });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: existing.id,
      companyId: existing.companyId,
      body: "write the whole thing",
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        assigneeUserId: null,
        comment: "write the whole thing",
        commentClientRequestId: "55555555-5555-4555-8555-555555555555",
        assigneeAdapterOverrides: updated.assigneeAdapterOverrides,
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(existing.id, expect.objectContaining({
      assigneeAdapterOverrides: updated.assigneeAdapterOverrides,
    }), expect.anything());
    expect(mockIssueService.addComment).toHaveBeenCalledWith(existing.id, "write the whole thing", expect.anything(),
      expect.objectContaining({ clientRequestId: "55555555-5555-4555-8555-555555555555" }), expect.anything());
    expect(mockIssueService.update.mock.calls[0]?.[2]).toBe(mockIssueService.addComment.mock.calls[0]?.[4]);
    // The route dispatches the wake after it sends the response, so wait for
    // the fire-and-forget dispatch to settle. This keeps the wake inside this
    // test and stops it from leaking into the next test as an extra call.
    await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        source: "assignment",
        reason: "issue_assigned",
        payload: expect.objectContaining({
          issueId: existing.id,
          commentId: "comment-1",
          mutation: "update",
        }),
        contextSnapshot: expect.objectContaining({
          issueId: existing.id,
          taskId: existing.id,
          commentId: "comment-1",
          wakeCommentId: "comment-1",
          ...(externalConversationState ? { taskKey: existing.identifier } : {}),
          source: "issue.update",
        }),
      }),
    );
  });

  it("rolls back adapter settings if the accompanying comment fails", async () => {
    const existing = makeIssue({ assigneeAgentId: ASSIGNEE_AGENT_ID, assigneeUserId: null });
    let persistedModel = "gpt-6-sol";
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockImplementation(async (_id, fields) => {
      persistedModel = fields.assigneeAdapterOverrides.adapterConfig.model;
      return { ...existing, ...fields };
    });
    mockIssueService.addComment.mockRejectedValue(new Error("comment write failed"));
    const transaction = vi.fn(async (callback: (tx: Record<string, never>) => Promise<unknown>) => {
      const previousModel = persistedModel;
      try {
        return await callback({});
      } catch (error) {
        persistedModel = previousModel;
        throw error;
      }
    });

    const res = await request(await createApp(transaction))
      .patch(`/api/issues/${existing.id}`)
      .send({ comment: "use Astra", assigneeAdapterOverrides: { adapterConfig: { model: "gpt-6-astra" } } });

    expect(res.status).toBe(500);
    expect(transaction).toHaveBeenCalledOnce();
    expect(persistedModel).toBe("gpt-6-sol");
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("interrupts the active run and wakes the newly assigned agent with handoff context", async () => {
    const existing = makeIssue({
      assigneeAgentId: PREVIOUS_AGENT_ID,
      assigneeUserId: null,
      executionRunId: "run-1",
      status: "in_progress",
    });
    const updated = makeIssue({
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
      executionRunId: "run-1",
      status: "in_progress",
    });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-interrupt-agent",
      issueId: existing.id,
      companyId: existing.companyId,
      body: "stop and hand this to CodexCoder",
    });
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: existing.companyId,
      agentId: PREVIOUS_AGENT_ID,
      status: "running",
      contextSnapshot: { issueId: existing.id },
    });
    mockHeartbeatService.cancelRun.mockResolvedValue({
      id: "run-1",
      companyId: existing.companyId,
      agentId: PREVIOUS_AGENT_ID,
      status: "cancelled",
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        assigneeUserId: null,
        comment: "stop and hand this to CodexCoder",
        interrupt: true,
      });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith(
      "run-1",
      "Interrupted by board comment",
      expect.objectContaining({
        errorCode: "operator_interrupted",
        resultJson: expect.objectContaining({
          operatorInterrupted: true,
          interruptionSource: "issue_comment_interrupt",
          interruptedIssueId: existing.id,
        }),
        eventMessage: "run interrupted by board comment",
        eventPayload: expect.objectContaining({
          issueId: existing.id,
          source: "issue_comment_interrupt",
        }),
      }),
    );
    await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        source: "assignment",
        reason: "issue_assigned",
        payload: expect.objectContaining({
          issueId: existing.id,
          commentId: "comment-interrupt-agent",
          interruptedRunId: "run-1",
          mutation: "update",
        }),
        contextSnapshot: expect.objectContaining({
          issueId: existing.id,
          taskId: existing.id,
          commentId: "comment-interrupt-agent",
          wakeCommentId: "comment-interrupt-agent",
          interruptedRunId: "run-1",
          source: "issue.update",
        }),
      }),
    );
  });

  it("interrupts the active run without waking an agent when the handoff assigns a user", async () => {
    const existing = makeIssue({
      assigneeAgentId: PREVIOUS_AGENT_ID,
      assigneeUserId: null,
      executionRunId: "run-2",
      status: "in_progress",
    });
    const updated = makeIssue({
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      executionRunId: "run-2",
      status: "in_progress",
    });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-interrupt-user",
      issueId: existing.id,
      companyId: existing.companyId,
      body: "stop here, I will take it",
    });
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-2",
      companyId: existing.companyId,
      agentId: PREVIOUS_AGENT_ID,
      status: "running",
      contextSnapshot: { issueId: existing.id },
    });
    mockHeartbeatService.cancelRun.mockResolvedValue({
      id: "run-2",
      companyId: existing.companyId,
      agentId: PREVIOUS_AGENT_ID,
      status: "cancelled",
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({
        assigneeAgentId: null,
        assigneeUserId: "local-board",
        comment: "stop here, I will take it",
        interrupt: true,
      });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith(
      "run-2",
      "Interrupted by board comment",
      expect.objectContaining({
        errorCode: "operator_interrupted",
        resultJson: expect.objectContaining({
          operatorInterrupted: true,
          interruptionSource: "issue_comment_interrupt",
          interruptedIssueId: existing.id,
        }),
        eventMessage: "run interrupted by board comment",
      }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("defers the assignment wake when a structured goal owns the next run", async () => {
    const existing = makeIssue({ assigneeAgentId: null, assigneeUserId: null, status: "todo" });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(makeIssue({ assigneeAgentId: ASSIGNEE_AGENT_ID, status: "todo" }));
    const res = await request(await createApp()).patch(`/api/issues/${existing.id}`).send({
      assigneeAgentId: ASSIGNEE_AGENT_ID, assigneeUserId: null, deferWakeForGoal: true,
    });
    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("does not allow goal wake deferral to suppress an unrelated status change", async () => {
    const existing = makeIssue({ assigneeAgentId: ASSIGNEE_AGENT_ID, status: "todo" });
    mockIssueService.getById.mockResolvedValue(existing);
    const res = await request(await createApp()).patch(`/api/issues/${existing.id}`).send({
      assigneeAgentId: ASSIGNEE_AGENT_ID, status: "in_progress", deferWakeForGoal: true,
    });
    expect(res.status).toBe(400);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("wakes the assignee on comment-only issue updates", async () => {
    const existing = makeIssue({
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
      status: "in_progress",
    });
    const updated = { ...existing };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-2",
      issueId: existing.id,
      companyId: existing.companyId,
      body: "please revise this",
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({
        comment: "please revise this",
      });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        source: "automation",
        reason: "issue_commented",
        payload: expect.objectContaining({
          issueId: existing.id,
          commentId: "comment-2",
          mutation: "comment",
        }),
        contextSnapshot: expect.objectContaining({
          issueId: existing.id,
          taskId: existing.id,
          commentId: "comment-2",
          wakeCommentId: "comment-2",
          wakeReason: "issue_commented",
          source: "issue.comment",
        }),
      }),
    );
  });

  it.each([null, "active"] as const)("wakes the assignee on top-level board comments with external conversation %s", async (externalConversationState) => {
    const existing = makeIssue({
      externalConversationState,
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
      status: "in_progress",
    });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-3",
      issueId: existing.id,
      companyId: existing.companyId,
      body: "please handle this top-level thread comment",
    });

    const res = await request(await createApp())
      .post(`/api/issues/${existing.id}/comments`)
      .send({
        body: "please handle this top-level thread comment",
        clientRequestId: "66666666-6666-4666-8666-666666666666",
      });

    expect(res.status).toBe(201);
    if (externalConversationState) expect(mockRunnerGoalService.projection).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).toHaveBeenCalledWith(existing.id, "please handle this top-level thread comment", expect.anything(),
      expect.objectContaining({ clientRequestId: "66666666-6666-4666-8666-666666666666", mirrorToSlack: true }), expect.anything());
    await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        source: "automation",
        reason: "issue_commented",
        payload: expect.objectContaining({
          issueId: existing.id,
          commentId: "comment-3",
          mutation: "comment",
        }),
        contextSnapshot: expect.objectContaining({
          issueId: existing.id,
          taskId: existing.id,
          commentId: "comment-3",
          wakeCommentId: "comment-3",
          ...(externalConversationState ? { taskKey: existing.identifier } : {}),
          wakeReason: "issue_commented",
          source: "issue.comment",
        }),
      }),
    );
  });

  it("retains the Slack session key when reopening strips the read-only conversation projection", async () => {
    const existing = makeIssue({ externalConversationState: "active", status: "done", assigneeAgentId: ASSIGNEE_AGENT_ID });
    const updated = makeIssue({ status: "todo", assigneeAgentId: ASSIGNEE_AGENT_ID });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);
    mockIssueService.addComment.mockResolvedValue({ id: "comment-reopen-slack", issueId: existing.id, companyId: existing.companyId, body: "Continue from Paperclip" });
    const res = await request(await createApp()).post(`/api/issues/${existing.id}/comments`).send({ body: "Continue from Paperclip", reopen: true });
    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(ASSIGNEE_AGENT_ID, expect.objectContaining({
      contextSnapshot: expect.objectContaining({ source: "issue.comment.reopen", taskKey: existing.identifier, wakeCommentId: "comment-reopen-slack" }),
    }));
  });

  it("does not wake the assignee for its own run-authenticated top-level comment", async () => {
    const existing = makeIssue({
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
      status: "in_progress",
    });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-self-top-level",
      issueId: existing.id,
      companyId: existing.companyId,
      body: "Plan ready for review.",
      createdByRunId: SOURCE_RUN_ID,
    });
    mockHeartbeatService.getRun.mockResolvedValue({
      id: SOURCE_RUN_ID,
      companyId: existing.companyId,
      agentId: ASSIGNEE_AGENT_ID,
      status: "running",
    });

    const res = await request(await createApp())
      .post(`/api/issues/${existing.id}/comments`)
      .set("X-Paperclip-Run-Id", SOURCE_RUN_ID)
      .send({ body: "Plan ready for review." });

    expect(res.status).toBe(201);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it.each((["post", "patch"] as const).flatMap((method) =>
    ["assignee_comment", "board_comment", "human_owned", "unassigned", "blocked_parent", "done_parent", "done_comment", ...(method === "patch" ? ["closing_comment"] : [])].map((scenario) => ({ method, scenario })),
  ))("keeps $method mentions as context for $scenario", async ({ method, scenario }) => {
    const selfComment = ["assignee_comment", "blocked_parent", "done_parent", "done_comment", "closing_comment"].includes(scenario);
    const existing = makeIssue({
      assigneeAgentId: ["human_owned", "unassigned"].includes(scenario) ? null : ASSIGNEE_AGENT_ID,
      assigneeUserId: scenario === "human_owned" ? "local-board" : null,
      status: scenario === "blocked_parent" ? "blocked" : ["done_parent", "done_comment"].includes(scenario) ? "done" : "in_progress",
      executionRunId: selfComment ? SOURCE_RUN_ID : null,
    });
    const child = makeIssue({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", identifier: "PAP-1000", parentId: existing.id,
      assigneeAgentId: MENTIONED_AGENT_ID, assigneeUserId: null,
      status: scenario === "done_parent" ? "done" : "in_progress",
      executionRunId: "55555555-5555-4555-8555-555555555555",
    });
    const body = ["blocked_parent", "done_parent"].includes(scenario)
      ? `[@QA](agent://${MENTIONED_AGENT_ID}) is relevant; see [${child.identifier}](/PAP/issues/${child.identifier}).`
      : `Finished the task. [@QA](agent://${MENTIONED_AGENT_ID}) has relevant context.`;
    const originalComment = {
      id: "context-note", issueId: existing.id, companyId: existing.companyId, body,
      createdByRunId: selfComment ? SOURCE_RUN_ID : null,
    };
    mockIssueService.getById.mockImplementation(async (id) => id === child.id ? child : existing);
    mockIssueService.getByIdentifier.mockResolvedValue(child);
    mockIssueService.update.mockResolvedValue(scenario === "closing_comment" ? { ...existing, status: "done" } : existing);
    mockIssueService.addComment.mockResolvedValue(originalComment);
    mockIssueService.findMentionedAgents.mockResolvedValue([MENTIONED_AGENT_ID]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [child], blocks: [] });
    mockHeartbeatService.getRun.mockImplementation(async (id) => ({
      id, companyId: existing.companyId, status: "running",
      agentId: id === SOURCE_RUN_ID ? ASSIGNEE_AGENT_ID : MENTIONED_AGENT_ID,
      contextSnapshot: { issueId: id === SOURCE_RUN_ID ? existing.id : child.id },
    }));
    const app = await createApp();
    const req = method === "post"
      ? request(app).post(`/api/issues/${existing.id}/comments`)
      : request(app).patch(`/api/issues/${existing.id}`);
    if (selfComment) req.set("X-Paperclip-Run-Id", SOURCE_RUN_ID);
    const res = await req.send(method === "post" ? { body } : { comment: body, ...(scenario === "closing_comment" ? { status: "done" } : {}) });
    expect(res.status).toBe(method === "post" ? 201 : 200);
    // Wake scheduling runs after sending the response. Drain its resolved
    // mock promises before asserting that no extra work was dispatched.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
    expect(mockIssueService.addComment.mock.calls[0].slice(0, 2)).toEqual([existing.id, body]);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(scenario === "board_comment" ? 1 : 0);
    if (scenario === "board_comment") {
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(ASSIGNEE_AGENT_ID, expect.objectContaining({
        reason: "issue_commented", contextSnapshot: expect.objectContaining({ issueId: existing.id }),
      }));
    }
    expect(mockIssueService.update.mock.calls.every(([id]) => id === existing.id)).toBe(true);
  });

  it("preserves an explicit resume on a run-authenticated top-level comment", async () => {
    const existing = makeIssue({
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
      status: "in_progress",
    });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-self-resume",
      issueId: existing.id,
      companyId: existing.companyId,
      body: "Resume intentionally.",
      createdByRunId: SOURCE_RUN_ID,
    });
    mockHeartbeatService.getRun.mockResolvedValue({
      id: SOURCE_RUN_ID,
      companyId: existing.companyId,
      agentId: ASSIGNEE_AGENT_ID,
      status: "succeeded",
    });

    const res = await request(await createApp())
      .post(`/api/issues/${existing.id}/comments`)
      .set("X-Paperclip-Run-Id", SOURCE_RUN_ID)
      .send({ body: "Resume intentionally.", resume: true });

    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        reason: "issue_commented",
        contextSnapshot: expect.objectContaining({
          resumeIntent: true,
        }),
      }),
    );
  });

  it("tags the wake when a board comment supersedes the last review interaction", async () => {
    const existing = makeIssue({
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
      status: "in_review",
    });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-review-path",
      issueId: existing.id,
      companyId: existing.companyId,
      body: "one more review note",
    });
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByComment.mockResolvedValue([{
      id: "interaction-review-path",
      kind: "request_confirmation",
      status: "expired",
    }]);
    mockIssueService.listReviewAttention.mockResolvedValue(new Map([[
      existing.id,
      { state: "stalled", paths: [], reason: "review path consumed" },
    ]]));

    const res = await request(await createApp())
      .post(`/api/issues/${existing.id}/comments`)
      .send({ body: "one more review note" });

    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        payload: expect.objectContaining({
          reviewPathLost: true,
          reviewPathConsumedRef: "interaction-review-path",
          reviewPathInstruction: expect.stringContaining("Restore a reviewer"),
        }),
        contextSnapshot: expect.objectContaining({
          reviewPathLost: true,
          reviewPathConsumedRef: "interaction-review-path",
        }),
      }),
    );
  });

  it("does not route a plain-text agent name on a human-owned issue comment", async () => {
    const existing = makeIssue({
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      status: "in_progress",
    });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-plain-agent-name",
      issueId: existing.id,
      companyId: existing.companyId,
      body: "QA please take the screenshot",
    });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);

    const res = await request(await createApp())
      .post(`/api/issues/${existing.id}/comments`)
      .send({
        body: "QA please take the screenshot",
      });

    expect(res.status).toBe(201);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

});
