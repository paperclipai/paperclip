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

async function createApp() {
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
    transaction: async (callback: (tx: Record<string, never>) => Promise<unknown>) => callback({}),
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

  it("includes the new comment in assignment wakes from issue updates", async () => {
    const existing = makeIssue();
    const updated = makeIssue({
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
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
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.addComment).toHaveBeenCalledWith(existing.id, "write the whole thing", expect.anything(),
      expect.objectContaining({ clientRequestId: "55555555-5555-4555-8555-555555555555" }));
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
          source: "issue.update",
        }),
      }),
    );
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
    await vi.waitFor(() => expect(mockIssueService.findMentionedAgents).toHaveBeenCalledWith(
      existing.companyId,
      "stop here, I will take it",
    ));
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

  it("wakes the assignee on top-level board issue comments", async () => {
    const existing = makeIssue({
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
    expect(mockIssueService.addComment).toHaveBeenCalledWith(existing.id, "please handle this top-level thread comment", expect.anything(),
      expect.objectContaining({ clientRequestId: "66666666-6666-4666-8666-666666666666" }), expect.anything());
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
          wakeReason: "issue_commented",
          source: "issue.comment",
        }),
      }),
    );
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
    await vi.waitFor(() => expect(mockIssueService.findMentionedAgents).toHaveBeenCalled());
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("still wakes a different mentioned agent from a run-authenticated comment", async () => {
    const existing = makeIssue({
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
      status: "in_progress",
    });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-self-cross-mention",
      issueId: existing.id,
      companyId: existing.companyId,
      body: "[@QA](/agents/33333333-3333-4333-8333-333333333333) please verify.",
      createdByRunId: SOURCE_RUN_ID,
    });
    mockIssueService.findMentionedAgents.mockResolvedValue([
      MENTIONED_AGENT_ID,
    ]);
    mockHeartbeatService.getRun.mockResolvedValue({
      id: SOURCE_RUN_ID,
      companyId: existing.companyId,
      agentId: ASSIGNEE_AGENT_ID,
      status: "running",
    });

    const res = await request(await createApp())
      .post(`/api/issues/${existing.id}/comments`)
      .set("X-Paperclip-Run-Id", SOURCE_RUN_ID)
      .send({
        body: "[@QA](/agents/33333333-3333-4333-8333-333333333333) please verify.",
      });

    expect(res.status).toBe(201);
    await vi.waitFor(() =>
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1),
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      MENTIONED_AGENT_ID,
      expect.objectContaining({
        reason: "issue_comment_mentioned",
      }),
    );
  });

  it.each((["post", "patch"] as const).flatMap((method) => [
    "active_delegation", "completed_delegation", "human_comment", "completed_human_comment", "unrelated_comment", "completed_child",
    "active_feedback", "ambiguous_delegation", "child_access_denied", "child_mutation_denied", "forwarding_failure",
    "source_run_other_issue", "completed_source_run_other_issue",
    "completed_explicit_resume", "completed_parent_reference", "completed_mixed_reference",
    "completed_delegation_without_blocker", "completed_foreign_company", "completed_unrelated_child", "completed_other_assignee", "completed_lookup_failure",
    "unrelated_child", "foreign_company", "stopped_run", "foreign_run", "unrelated_run", "lookup_failure",
  ].map((scenario) => ({ method, scenario }))))("routes $method mentions correctly for $scenario", async ({ method, scenario }) => {
    const existing = makeIssue({ assigneeAgentId: ASSIGNEE_AGENT_ID, assigneeUserId: null, status: "blocked", executionRunId: SOURCE_RUN_ID });
    const child = makeIssue({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", identifier: "PAP-1000",
      parentId: existing.id, assigneeAgentId: MENTIONED_AGENT_ID, assigneeUserId: null,
      status: "in_progress", executionRunId: "55555555-5555-4555-8555-555555555555",
    });
    const secondChild = { ...child, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", identifier: "PAP-1001", executionRunId: "66666666-6666-4666-8666-666666666666" };
    const delegationBody = scenario === "completed_parent_reference"
      ? `${existing.identifier} is done thanks to [@QA](agent://${MENTIONED_AGENT_ID}) completing ${child.identifier}.`
      : scenario === "completed_mixed_reference"
      ? `[@QA](agent://${MENTIONED_AGENT_ID}) completed ${child.identifier}; now investigate PAP-9999.`
      : scenario === "active_feedback"
      ? `${child.identifier} is still failing; [@QA](agent://${MENTIONED_AGENT_ID}) please investigate the new error.`
      : scenario === "unrelated_comment"
      ? `[@QA](agent://${MENTIONED_AGENT_ID}) please review the parent task separately.`
      : `Delegated to [@QA](agent://${MENTIONED_AGENT_ID}) via [${child.identifier}](/PAP/issues/${child.identifier}). Waiting for that task to finish.`;
    // This unrelated mention must wake after the worker's routing decision.
    // It gives the test an observable completion point for the async loop.
    const body = `${delegationBody}${scenario === "ambiguous_delegation" ? ` Also check ${secondChild.identifier}.` : ""} [@Observer](agent://${PREVIOUS_AGENT_ID}) please review the parent separately.`;
    const completedDelegation = scenario.startsWith("completed_") && scenario !== "completed_child";
    const humanComment = scenario === "human_comment" || scenario === "completed_human_comment";
    if (scenario === "completed_child" || completedDelegation) child.status = "done";
    if (completedDelegation) existing.status = "done";
    if (scenario === "unrelated_child" || scenario === "completed_unrelated_child") child.parentId = "other-parent";
    if (scenario === "foreign_company" || scenario === "completed_foreign_company") child.companyId = "other-company";
    if (scenario === "completed_other_assignee") child.assigneeAgentId = "other-agent";
    mockIssueService.getById.mockImplementation(async (id) => {
      if (id === child.id && scenario === "lookup_failure") throw new Error("temporary read failure");
      if (id === secondChild.id) return secondChild;
      return id === child.id ? child : existing;
    });
    mockIssueService.getByIdentifier.mockImplementation(async (identifier) => {
      if (scenario === "completed_lookup_failure") throw new Error("temporary identifier lookup failure");
      return identifier === child.identifier ? child : null;
    });
    mockIssueService.update.mockImplementation(async (_id, patch) => scenario === "completed_explicit_resume" ? { ...existing, ...patch } : existing);
    const originalComment = {
      id: "delegation-note", issueId: existing.id, companyId: existing.companyId, body,
      createdByRunId: humanComment ? null : SOURCE_RUN_ID,
      authorAgentId: null, authorUserId: "local-board", authorType: "user", onBehalfOfUserId: "responsible-user",
      sourceTrust: { preset: "low_trust_review", disposition: "quarantined", sourceIssueId: existing.id, sourceRunId: SOURCE_RUN_ID },
    };
    mockIssueService.addComment.mockImplementation(async (issueId, commentBody) => {
      if (issueId === child.id && scenario === "forwarding_failure") throw new Error("temporary child comment failure");
      return issueId === child.id ? { ...originalComment, id: "forwarded-note", issueId, body: commentBody } : originalComment;
    });
    mockIssueService.findMentionedAgents.mockResolvedValue([MENTIONED_AGENT_ID, PREVIOUS_AGENT_ID]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: completedDelegation && scenario !== "completed_delegation" ? [] : scenario === "ambiguous_delegation" ? [child, secondChild] : [child], blocks: [] });
    if (scenario === "child_access_denied") {
      mockAccessDecide.mockImplementation(async (input) => ({ allowed: input.resource?.issueId !== child.id, action: input.action, reason: "test_access_decision", explanation: "Test child access decision." }));
    }
    if (scenario === "child_mutation_denied") {
      mockAccessDecide.mockImplementation(async (input) => ({ allowed: input.resource?.issueId !== child.id || input.action !== "issue:mutate", action: input.action, reason: "test_access_decision", explanation: "Test child mutation decision." }));
    }
    mockHeartbeatService.getRun.mockImplementation(async (id) => ({
      id, companyId: id === child.executionRunId && scenario === "foreign_run" ? "other-company" : existing.companyId,
      status: id === child.executionRunId && scenario === "stopped_run" ? "succeeded" : "running",
      agentId: id === child.executionRunId || id === secondChild.executionRunId ? MENTIONED_AGENT_ID : ASSIGNEE_AGENT_ID,
      contextSnapshot: { issueId: id === secondChild.executionRunId ? secondChild.id : id === child.executionRunId && scenario !== "unrelated_run" ? child.id : scenario.endsWith("source_run_other_issue") ? "other-source-issue" : existing.id },
    }));
    const app = await createApp();
    const req = method === "post"
      ? request(app).post(`/api/issues/${existing.id}/comments`)
      : request(app).patch(`/api/issues/${existing.id}`);
    if (!humanComment) req.set("X-Paperclip-Run-Id", SOURCE_RUN_ID);
    const explicitResume = scenario === "completed_explicit_resume" ? { resume: true } : {};
    const res = await req.send(method === "post" ? { body, ...explicitResume } : { comment: body, ...explicitResume });
    expect(res.status).toBe(method === "post" ? 201 : 200);
    await vi.waitFor(() => {
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(PREVIOUS_AGENT_ID, expect.objectContaining({ reason: "issue_comment_mentioned" }));
    });
    if (scenario === "active_delegation" || scenario === "active_feedback") {
      expect(mockIssueService.addComment).toHaveBeenCalledWith(
        child.id,
        `Forwarded from [${existing.identifier}](/issues/${existing.identifier}#comment-${originalComment.id}):\n\n${body}`,
        { agentId: undefined, userId: "local-board", runId: SOURCE_RUN_ID, onBehalfOfUserId: "responsible-user" },
        expect.objectContaining({ authorType: "user", sourceTrust: originalComment.sourceTrust }),
      );
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(MENTIONED_AGENT_ID, expect.objectContaining({
        reason: "issue_comment_mentioned",
        payload: expect.objectContaining({ issueId: child.id, commentId: "forwarded-note", resumeIntent: true, followUpRequested: true }),
        contextSnapshot: expect.objectContaining({ issueId: child.id, taskId: child.id, commentId: "forwarded-note", wakeCommentId: "forwarded-note", source: "comment.mention.delegation", resumeIntent: true, followUpRequested: true }),
      }));
      expect(mockHeartbeatService.wakeup).not.toHaveBeenCalledWith(MENTIONED_AGENT_ID, expect.objectContaining({ payload: expect.objectContaining({ issueId: existing.id }) }));
    } else if (["completed_delegation", "completed_delegation_without_blocker", "completed_parent_reference"].includes(scenario)) {
      expect(mockHeartbeatService.wakeup).not.toHaveBeenCalledWith(MENTIONED_AGENT_ID, expect.objectContaining({ reason: "issue_comment_mentioned" }));
    } else {
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(MENTIONED_AGENT_ID, expect.objectContaining({ reason: "issue_comment_mentioned", payload: expect.objectContaining({ issueId: existing.id }) }));
      if (scenario !== "forwarding_failure") {
        expect(mockIssueService.addComment.mock.calls.some(([issueId]) => issueId === child.id)).toBe(false);
      }
    }
    expect(mockIssueService.addComment).toHaveBeenCalled();
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
    await vi.waitFor(() => expect(mockIssueService.findMentionedAgents).toHaveBeenCalledWith(
      existing.companyId,
      "QA please take the screenshot",
    ));
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("routes a structured mentioned agent without making that agent the issue owner", async () => {
    const existing = makeIssue({
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      status: "in_progress",
    });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-structured-mention",
      issueId: existing.id,
      companyId: existing.companyId,
      body: "[@QA](/agents/33333333-3333-4333-8333-333333333333) please inspect this",
    });
    mockIssueService.findMentionedAgents.mockResolvedValue([MENTIONED_AGENT_ID]);

    const res = await request(await createApp())
      .post(`/api/issues/${existing.id}/comments`)
      .send({
        body: "[@QA](/agents/33333333-3333-4333-8333-333333333333) please inspect this",
      });

    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1));
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      MENTIONED_AGENT_ID,
      expect.objectContaining({
        source: "automation",
        reason: "issue_comment_mentioned",
        payload: {
          issueId: existing.id,
          commentId: "comment-structured-mention",
        },
        contextSnapshot: expect.objectContaining({
          issueId: existing.id,
          taskId: existing.id,
          commentId: "comment-structured-mention",
          wakeCommentId: "comment-structured-mention",
          wakeReason: "issue_comment_mentioned",
          source: "comment.mention",
        }),
      }),
    );
  });
});
