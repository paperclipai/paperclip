import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  getDependencyReadiness: vi.fn(),
  getCurrentScheduledRetry: vi.fn(),
  findMentionedAgents: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockTxInsertValues = vi.hoisted(() => vi.fn(async () => undefined));
const mockTxInsert = vi.hoisted(() => vi.fn(() => ({ values: mockTxInsertValues })));
const mockTx = vi.hoisted(() => ({
  insert: mockTxInsert,
}));
const mockDbSelectOrderBy = vi.hoisted(() => vi.fn(async () => []));
const mockDbSelectWhere = vi.hoisted(() => vi.fn(() => ({
  orderBy: mockDbSelectOrderBy,
  then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve([]).then(onFulfilled, onRejected),
})));
const mockDbSelectFrom = vi.hoisted(() => vi.fn(() => ({ where: mockDbSelectWhere })));
const mockDbSelect = vi.hoisted(() => vi.fn(() => ({ from: mockDbSelectFrom })));
const mockDb = vi.hoisted(() => ({
  select: mockDbSelect,
  transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
}));
const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(async () => []),
  saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
}));
const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(async () => ({
    id: "instance-settings-1",
    general: {
      censorUsernameInLogs: false,
      feedbackDataSharingPreference: "prompt",
    },
  })),
  listCompanyIds: vi.fn(async () => ["company-1"]),
}));
const mockRoutineService = vi.hoisted(() => ({
  syncRunStatusForIssue: vi.fn(async () => undefined),
}));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));
const mockIssueRecoveryActionService = vi.hoisted(() => ({
  getActiveForIssue: vi.fn(async () => null),
}));
const mockIssueTreeControlService = vi.hoisted(() => ({
  getActivePauseHoldGate: vi.fn(async () => null),
}));

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentTaskCompleted: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
}));

vi.mock("../services/access.js", () => ({
  accessService: () => mockAccessService,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => mockAgentService,
}));

vi.mock("../services/feedback.js", () => ({
  feedbackService: () => mockFeedbackService,
}));

vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: () => mockHeartbeatService,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => mockIssueService,
}));

vi.mock("../services/routines.js", () => ({
  routineService: () => mockRoutineService,
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => mockFeedbackService,
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => mockInstanceSettingsService,
  issueApprovalService: () => ({}),
  issueRecoveryActionService: () => mockIssueRecoveryActionService,
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
  issueThreadInteractionService: () => mockIssueThreadInteractionService,
  issueTreeControlService: () => mockIssueTreeControlService,
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => mockRoutineService,
  workProductService: () => ({}),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  return app;
}

async function installActor(app: express.Express, actor?: Record<string, unknown>) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/issues.js"),
    import("../middleware/index.js"),
  ]);
  app.use((req, _res, next) => {
    (req as any).actor = actor ?? {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes(mockDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

async function normalizePolicy(input: {
  stages: Array<{
    id: string;
    type: "review" | "approval";
    participants: Array<{ type: "agent"; agentId: string } | { type: "user"; userId: string }>;
  }>;
}) {
  const { normalizeIssueExecutionPolicy } = await import("../services/issue-execution-policy.js");
  return normalizeIssueExecutionPolicy(input);
}

function makeIssue(status: "todo" | "done" | "blocked" | "cancelled" | "in_progress") {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    status,
    assigneeAgentId: "22222222-2222-4222-8222-222222222222",
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-580",
    title: "Comment reopen default",
  };
}

function agentActor(agentId = "22222222-2222-4222-8222-222222222222") {
  return {
    type: "agent",
    agentId,
    companyId: "company-1",
    source: "agent_key",
    runId: "run-1",
  };
}

async function waitForWakeup(assertion: () => void) {
  await vi.waitFor(assertion);
}

describe.sequential("issue comment reopen routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockReset();
    mockIssueService.assertCheckoutOwner.mockReset();
    mockIssueService.update.mockReset();
    mockIssueService.addComment.mockReset();
    mockIssueService.getDependencyReadiness.mockReset();
    mockIssueService.getCurrentScheduledRetry.mockReset();
    mockIssueService.findMentionedAgents.mockReset();
    mockIssueService.listWakeableBlockedDependents.mockReset();
    mockIssueService.getWakeableParentAfterChildCompletion.mockReset();
    mockAccessService.canUser.mockReset();
    mockAccessService.decide.mockReset();
    mockAccessService.hasPermission.mockReset();
    mockHeartbeatService.wakeup.mockReset();
    mockHeartbeatService.reportRunActivity.mockReset();
    mockHeartbeatService.getRun.mockReset();
    mockHeartbeatService.getActiveRunForAgent.mockReset();
    mockHeartbeatService.cancelRun.mockReset();
    mockAgentService.getById.mockReset();
    mockAgentService.list.mockReset();
    mockAgentService.resolveByReference.mockReset();
    mockLogActivity.mockReset();
    mockFeedbackService.listIssueVotesForUser.mockReset();
    mockFeedbackService.saveIssueVote.mockReset();
    mockInstanceSettingsService.get.mockReset();
    mockInstanceSettingsService.listCompanyIds.mockReset();
    mockRoutineService.syncRunStatusForIssue.mockReset();
    mockIssueRecoveryActionService.getActiveForIssue.mockReset();
    mockIssueTreeControlService.getActivePauseHoldGate.mockReset();
    mockTxInsertValues.mockReset();
    mockTxInsert.mockReset();
    mockDbSelect.mockReset();
    mockDbSelectFrom.mockReset();
    mockDbSelectWhere.mockReset();
    mockDbSelectOrderBy.mockReset();
    mockDb.transaction.mockReset();
    mockTxInsertValues.mockResolvedValue(undefined);
    mockTxInsert.mockImplementation(() => ({ values: mockTxInsertValues }));
    mockDbSelectOrderBy.mockResolvedValue([]);
    mockDbSelectWhere.mockImplementation(() => ({
      orderBy: mockDbSelectOrderBy,
      then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve([]).then(onFulfilled, onRejected),
    }));
    mockDbSelectFrom.mockImplementation(() => ({ where: mockDbSelectWhere }));
    mockDbSelect.mockImplementation(() => ({ from: mockDbSelectFrom }));
    mockDb.transaction.mockImplementation(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx));
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockHeartbeatService.reportRunActivity.mockResolvedValue(undefined);
    mockHeartbeatService.getRun.mockResolvedValue(null);
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue(null);
    mockHeartbeatService.cancelRun.mockResolvedValue(null);
    mockLogActivity.mockResolvedValue(undefined);
    mockFeedbackService.listIssueVotesForUser.mockResolvedValue([]);
    mockFeedbackService.saveIssueVote.mockResolvedValue({
      vote: null,
      consentEnabledNow: false,
      sharingEnabled: false,
    });
    mockInstanceSettingsService.get.mockResolvedValue({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    });
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1"]);
    mockRoutineService.syncRunStatusForIssue.mockResolvedValue(undefined);
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(null);
    mockIssueTreeControlService.getActivePauseHoldGate.mockResolvedValue(null);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      body: "hello",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: null,
      authorUserId: "local-board",
    });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: "11111111-1111-4111-8111-111111111111",
      blockerIssueIds: [],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      allBlockersDone: true,
      isDependencyReady: true,
    });
    mockIssueService.getCurrentScheduledRetry.mockResolvedValue(null);
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.decide.mockImplementation(async (input: { action?: string }) => {
      const allowed = input.action !== "tasks:manage_active_checkouts";
      return {
        allowed,
        action: input.action,
        reason: allowed ? "allow_explicit_grant" : "deny_missing_grant",
        explanation: allowed ? "Allowed by test grant." : "Missing active checkout override.",
      };
    });
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAgentService.getById.mockResolvedValue(null);
    mockAgentService.list.mockResolvedValue([
      {
        id: "22222222-2222-4222-8222-222222222222",
        reportsTo: null,
        permissions: { canCreateAgents: false },
      },
      {
        id: "44444444-4444-4444-8444-444444444444",
        reportsTo: null,
        permissions: { canCreateAgents: false },
      },
    ]);
    mockAgentService.resolveByReference.mockImplementation(async (_companyId: string, reference: string) => {
      if (reference === "ambiguous-codex") {
        return { ambiguous: true, agent: null };
      }
      if (reference === "missing-codex") {
        return { ambiguous: false, agent: null };
      }
      if (reference === "codexcoder") {
        return {
          ambiguous: false,
          agent: { id: "33333333-3333-4333-8333-333333333333" },
        };
      }
      return {
        ambiguous: false,
        agent: { id: reference },
      };
    });
  });

  it("treats reopen=true as a no-op when the issue is already open", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("todo"),
      ...patch,
    }));

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "hello", reopen: true, assigneeAgentId: "33333333-3333-4333-8333-333333333333" });

    expect(res.status).toBe(200);
    expect(res.body.assigneeAgentId).toBe("33333333-3333-4333-8333-333333333333");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        details: expect.not.objectContaining({ reopened: true }),
      }),
    );
  });

  it("implicitly reopens closed issues via the PATCH comment path when reassigning to an agent", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("done"),
      ...patch,
    }));

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "hello", assigneeAgentId: "33333333-3333-4333-8333-333333333333" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        status: "todo",
        actorAgentId: null,
        actorUserId: "local-board",
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        details: expect.objectContaining({
          reopened: true,
          reopenedFrom: "done",
          status: "todo",
        }),
      }),
    );
  });

  it("resolves assignee shortnames before updating an issue", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("todo"),
      ...patch,
    }));

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "hello", assigneeAgentId: "codexcoder" });

    expect(res.status).toBe(200);
    expect(mockAgentService.resolveByReference).toHaveBeenCalledWith("company-1", "codexcoder");
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      }),
    );
  });

  it("rejects ambiguous assignee shortnames", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ assigneeAgentId: "ambiguous-codex" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("ambiguous");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects missing assignee shortnames", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ assigneeAgentId: "missing-codex" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Agent not found");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });
  it("reopens closed issues via the PATCH comment path", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("done"),
      ...patch,
    }));

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "hello", reopen: true, assigneeAgentId: "33333333-3333-4333-8333-333333333333" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        status: "todo",
        actorAgentId: null,
        actorUserId: "local-board",
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        details: expect.objectContaining({
          reopened: true,
          reopenedFrom: "done",
          status: "todo",
        }),
      }),
    );
  });

  it("implicitly reopens closed issues via POST comments when an agent is assigned", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("done"),
      ...patch,
    }));

    const res = await request(await installActor(createApp()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "hello" });

    expect(res.status).toBe(201);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { status: "todo" },
    );
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        reason: "issue_reopened_via_comment",
        payload: expect.objectContaining({
          reopenedFrom: "done",
        }),
      }),
    ));
  });

  it("allows non-assignee agent POST comments on closed issues without reopening", async () => {
    // issue:comment split: plain comments by same-company agents are
    // communicative and inert — the issue stays closed and nothing wakes.
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      body: "hello",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: "33333333-3333-4333-8333-333333333333",
      authorUserId: null,
    });

    const res = await request(await installActor(createApp(), {
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      source: "agent_key",
      runId: "77777777-7777-4777-8777-777777777777",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "hello" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  // POST self-comment from the assignee agent on a done issue with explicit
  // reopen=true is the same log-class signal — the guard must suppress reopen.
  it("does not reopen via POST comment+reopen when the assignee agent is the actor on a done issue", async () => {
    const assigneeAgentId = "22222222-2222-4222-8222-222222222222";
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("done"),
      ...patch,
    }));
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      body: "log line",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: assigneeAgentId,
      authorUserId: null,
    });

    const res = await request(
      await installActor(createApp(), {
        type: "agent",
        agentId: assigneeAgentId,
        companyId: "company-1",
        runId: "run-self",
      }),
    )
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "log line", reopen: true });

    expect(res.status).toBe(201);
    expect(mockIssueService.update).not.toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ status: "todo" }),
    );
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: "issue_reopened_via_comment" }),
    );
  });

  // Same guard on cancelled status — explicit resume must use `resume: true`,
  // a log-class self-comment with `reopen: true` is not a reopen signal.
  it("does not reopen via POST comment+reopen when the assignee agent is the actor on a cancelled issue", async () => {
    const assigneeAgentId = "22222222-2222-4222-8222-222222222222";
    mockIssueService.getById.mockResolvedValue(makeIssue("cancelled"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("cancelled"),
      ...patch,
    }));
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      body: "log line",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: assigneeAgentId,
      authorUserId: null,
    });

    const res = await request(
      await installActor(createApp(), {
        type: "agent",
        agentId: assigneeAgentId,
        companyId: "company-1",
        runId: "run-self",
      }),
    )
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      // Cancelled issues reject explicit resume entirely, so only reopen=true
      // is observable here — the guard is what keeps it from flipping back.
      .send({ body: "log line", reopen: true });

    // Cancelled issues are rejected at assertExplicitResumeIntentAllowed for
    // agent actors with reopen=true (409). The guard runs after that, but
    // either way no reopen wakeup must fire and no status update to todo.
    expect([200, 201, 409]).toContain(res.status);
    expect(mockIssueService.update).not.toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ status: "todo" }),
    );
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: "issue_reopened_via_comment" }),
    );
  });

  // The guard must block explicit reopen=true + comment by the assignee agent
  // on their own done issue (assignee self-comments are log lines, not reopen
  // signals; explicit resume intent is delivered via `resume: true` instead).
  it("does not reopen via PATCH comment+reopen when the assignee agent is the actor on a done issue", async () => {
    const assigneeAgentId = "22222222-2222-4222-8222-222222222222";
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("done"),
      ...patch,
    }));

    const res = await request(
      await installActor(createApp(), {
        type: "agent",
        agentId: assigneeAgentId,
        companyId: "company-1",
        runId: "run-self",
      }),
    )
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "log line", reopen: true });

    expect(res.status).toBe(200);
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        details: expect.objectContaining({ reopened: true }),
      }),
    );
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: "issue_reopened_via_comment" }),
    );
  });

  // The guard compares against the issue's current assignee, not the requested
  // one — so an admin agent reassigning a different agent's terminal issue to
  // themselves with comment + reopen=true still reopens as today (AC-3).
  it("still reopens a done issue via PATCH when a different agent reassigns to self with reopen=true", async () => {
    const otherAgentId = "33333333-3333-4333-8333-333333333333";
    mockAccessService.decide.mockImplementation(async (input: { action?: string }) => ({
      allowed: true,
      action: input.action,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant.",
    }));
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("done"),
      ...patch,
    }));

    const res = await request(
      await installActor(createApp(), {
        type: "agent",
        agentId: otherAgentId,
        companyId: "company-1",
        runId: "run-other",
      }),
    )
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "taking over", reopen: true, assigneeAgentId: otherAgentId });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        assigneeAgentId: otherAgentId,
        status: "todo",
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        details: expect.objectContaining({
          reopened: true,
          reopenedFrom: "done",
          status: "todo",
        }),
      }),
    );
  });

  it("moves assigned blocked issues back to todo via POST comments", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("blocked"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("blocked"),
      ...patch,
    }));

    const res = await request(await installActor(createApp()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "please continue" });

    expect(res.status).toBe(201);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { status: "todo" },
    );
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        reason: "issue_reopened_via_comment",
        payload: expect.objectContaining({
          commentId: "comment-1",
          reopenedFrom: "blocked",
          mutation: "comment",
        }),
        contextSnapshot: expect.objectContaining({
          issueId: "11111111-1111-4111-8111-111111111111",
          wakeCommentId: "comment-1",
          wakeReason: "issue_reopened_via_comment",
          reopenedFrom: "blocked",
        }),
      }),
    ));
  });

  it("moves in-progress issues with a scheduled retry back to todo via POST human comments", async () => {
    const issue = {
      ...makeIssue("in_progress"),
      executionRunId: "retry-run-1",
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.getCurrentScheduledRetry.mockResolvedValue({
      runId: "retry-run-1",
      status: "scheduled_retry",
      agentId: "22222222-2222-4222-8222-222222222222",
      agentName: "CodexCoder",
      retryOfRunId: "source-run-1",
      scheduledRetryAt: new Date("2026-05-18T14:00:00.000Z"),
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "transient_failure",
      error: null,
      errorCode: null,
    });
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));
    mockHeartbeatService.cancelRun.mockResolvedValue({
      id: "retry-run-1",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "cancelled",
    });

    const res = await request(await installActor(createApp()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "I added the missing detail; please continue." });

    expect(res.status).toBe(201);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { status: "todo" },
    );
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith("retry-run-1");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        details: expect.objectContaining({
          status: "todo",
          scheduledRetrySupersededByComment: true,
          scheduledRetryRunId: "retry-run-1",
          cancelledScheduledRetryRunId: "retry-run-1",
        }),
      }),
    );
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        reason: "issue_commented",
        payload: expect.objectContaining({
          commentId: "comment-1",
          mutation: "comment",
        }),
        contextSnapshot: expect.objectContaining({
          wakeReason: "issue_commented",
          source: "issue.comment",
        }),
      }),
    ));
  });

  it("does not move scheduled-retry issues to todo when POST comment retry cancellation fails", async () => {
    const issue = {
      ...makeIssue("in_progress"),
      executionRunId: "retry-run-1",
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.getCurrentScheduledRetry.mockResolvedValue({
      runId: "retry-run-1",
      status: "scheduled_retry",
      agentId: "22222222-2222-4222-8222-222222222222",
      agentName: "CodexCoder",
      retryOfRunId: "source-run-1",
      scheduledRetryAt: new Date("2026-05-18T14:00:00.000Z"),
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "transient_failure",
      error: null,
      errorCode: null,
    });
    mockHeartbeatService.cancelRun.mockRejectedValue(new Error("cancel failed"));

    const res = await request(await installActor(createApp()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "I added the missing detail; please continue." });

    expect(res.status).toBe(500);
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith("retry-run-1");
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.updated" }),
    );
  });

  it("keeps ordinary in-progress POST human comments in progress when no scheduled retry exists", async () => {
    const issue = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await installActor(createApp()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "Checking in without retry state." });

    expect(res.status).toBe(201);
    expect(mockIssueService.getCurrentScheduledRetry).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        reason: "issue_commented",
      }),
    ));
  });

  it("passes validated comment presentation fields to trusted board comment writes", async () => {
    const app = await installActor(createApp());
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      authorType: "user",
      authorAgentId: null,
      authorUserId: "local-board",
      body: "Paperclip needs a disposition before this issue can continue.",
      presentation: { kind: "system_notice", tone: "warning", detailsDefaultOpen: false },
      metadata: {
        version: 1,
        sections: [{ rows: [{ type: "key_value", label: "Cause", value: "successful_run_missing_state" }] }],
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);

    const metadata = {
      version: 1,
      sections: [{ rows: [{ type: "key_value", label: "Cause", value: "successful_run_missing_state" }] }],
    };
    const presentation = { kind: "system_notice", tone: "warning" };
    const res = await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({
        body: "Paperclip needs a disposition before this issue can continue.",
        presentation,
        metadata,
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "Paperclip needs a disposition before this issue can continue.",
      { agentId: undefined, userId: "local-board", runId: null },
      {
        authorType: "user",
        presentation: { kind: "system_notice", tone: "warning", detailsDefaultOpen: false },
        metadata,
        sourceTrust: null,
      },
    );
  });

  it("rejects structured comment presentation fields from agent-authenticated writes", async () => {
    const app = await installActor(createApp(), agentActor());
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));

    const res = await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({
        body: "Hidden details",
        presentation: { kind: "system_notice", tone: "warning" },
        metadata: {
          version: 1,
          sections: [{ rows: [{ type: "key_value", label: "Cause", value: "covert_channel_attempt" }] }],
        },
      });

    expect(res.status).toBe(403);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("rejects invalid comment metadata before writing a comment", async () => {
    const app = await installActor(createApp());
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));

    const res = await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({
        body: "Invalid metadata",
        metadata: { version: 1, arbitrary: true },
      });

    expect(res.status).toBe(400);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("does not move dependency-blocked issues to todo via POST comments", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("blocked"));
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: "11111111-1111-4111-8111-111111111111",
      blockerIssueIds: ["33333333-3333-4333-8333-333333333333"],
      unresolvedBlockerIssueIds: ["33333333-3333-4333-8333-333333333333"],
      unresolvedBlockerCount: 1,
      allBlockersDone: false,
      isDependencyReady: false,
    });

    const res = await request(await installActor(createApp()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "what is happening?" });

    expect(res.status).toBe(201);
    expect(mockIssueService.update).not.toHaveBeenCalled();
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        reason: "issue_commented",
        payload: expect.objectContaining({
          commentId: "comment-1",
          mutation: "comment",
        }),
        contextSnapshot: expect.objectContaining({
          issueId: "11111111-1111-4111-8111-111111111111",
          wakeCommentId: "comment-1",
          wakeReason: "issue_commented",
        }),
      }),
    ));
  });

  it("does not implicitly reopen closed issues via POST comments when no agent is assigned", async () => {
    mockIssueService.getById.mockResolvedValue({
      ...makeIssue("done"),
      assigneeAgentId: null,
      assigneeUserId: "local-board",
    });

    const res = await request(await installActor(createApp()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "hello" });

    expect(res.status).toBe(201);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("does not implicitly reopen done issues via POST comments when the comment runId matches the issue's checkout run", async () => {
    mockIssueService.getById.mockResolvedValue({
      ...makeIssue("done"),
      checkoutRunId: "run-same-as-actor",
      executionRunId: null,
    });

    const res = await request(await installActor(createApp(), {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
      runId: "run-same-as-actor",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "Done — final note from the run that owns the issue" });

    expect(res.status).toBe(201);
    expect(mockIssueService.update).not.toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ status: "todo" }),
    );
  });

  it("does not implicitly reopen done issues via POST comments when the comment runId matches the issue's execution run", async () => {
    mockIssueService.getById.mockResolvedValue({
      ...makeIssue("done"),
      checkoutRunId: null,
      executionRunId: "run-same-as-actor",
    });

    const res = await request(await installActor(createApp(), {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
      runId: "run-same-as-actor",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "Done — note from the still-active execution run" });

    expect(res.status).toBe(201);
    expect(mockIssueService.update).not.toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ status: "todo" }),
    );
  });

  it("still implicitly reopens done issues via POST comments when the comment runId differs from the issue's owning run", async () => {
    mockIssueService.getById.mockResolvedValue({
      ...makeIssue("done"),
      checkoutRunId: "run-owning",
      executionRunId: "run-owning",
    });
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("done"),
      ...patch,
    }));

    const res = await request(await installActor(createApp(), {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
      runId: "run-different",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "Real human follow-up — please reopen" });

    expect(res.status).toBe(201);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { status: "todo" },
    );
  });

  it("does not implicitly reopen done issues via the PATCH comment path when actor runId matches the issue's checkout run", async () => {
    const issue = {
      ...makeIssue("done"),
      checkoutRunId: "run-same-as-actor",
      executionRunId: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
    }));

    const res = await request(await installActor(createApp(), {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
      runId: "run-same-as-actor",
    }))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "Done — final note from the run that owns the issue" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).not.toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ status: "todo" }),
    );
  });

  it("moves assigned blocked issues back to todo via the PATCH comment path", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("blocked"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("blocked"),
      ...patch,
    }));

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "please continue" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        status: "todo",
        actorAgentId: null,
        actorUserId: "local-board",
      }),
    );
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        reason: "issue_reopened_via_comment",
        payload: expect.objectContaining({
          commentId: "comment-1",
          reopenedFrom: "blocked",
          mutation: "comment",
        }),
      }),
    ));
  });

  it("moves in-progress issues with a scheduled retry back to todo via the PATCH comment path", async () => {
    const issue = {
      ...makeIssue("in_progress"),
      executionRunId: "retry-run-1",
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.getCurrentScheduledRetry.mockResolvedValue({
      runId: "retry-run-1",
      status: "scheduled_retry",
      agentId: "22222222-2222-4222-8222-222222222222",
      agentName: "CodexCoder",
      retryOfRunId: "source-run-1",
      scheduledRetryAt: new Date("2026-05-18T14:00:00.000Z"),
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "transient_failure",
      error: null,
      errorCode: null,
    });
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));
    mockHeartbeatService.cancelRun.mockResolvedValue({
      id: "retry-run-1",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "cancelled",
    });

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "Retry window is over; please continue." });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        status: "todo",
        actorAgentId: null,
        actorUserId: "local-board",
      }),
    );
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith("retry-run-1");
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        reason: "issue_commented",
        payload: expect.objectContaining({
          commentId: "comment-1",
          mutation: "comment",
        }),
      }),
    ));
  });

  it("does not move scheduled-retry issues to todo when PATCH comment retry cancellation fails", async () => {
    const issue = {
      ...makeIssue("in_progress"),
      executionRunId: "retry-run-1",
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.getCurrentScheduledRetry.mockResolvedValue({
      runId: "retry-run-1",
      status: "scheduled_retry",
      agentId: "22222222-2222-4222-8222-222222222222",
      agentName: "CodexCoder",
      retryOfRunId: "source-run-1",
      scheduledRetryAt: new Date("2026-05-18T14:00:00.000Z"),
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "transient_failure",
      error: null,
      errorCode: null,
    });
    mockHeartbeatService.cancelRun.mockRejectedValue(new Error("cancel failed"));

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "Retry window is over; please continue." });

    expect(res.status).toBe(500);
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith("retry-run-1");
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.updated" }),
    );
  });

  it("rejects non-assignee agent PATCH comments on closed issues", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      body: "hello",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: "33333333-3333-4333-8333-333333333333",
      authorUserId: null,
    });
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("done"),
      ...patch,
    }));

    const res = await request(await installActor(createApp(), {
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      source: "agent_key",
      runId: "88888888-8888-4888-8888-888888888888",
    }))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "hello" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Agent cannot mutate another agent's issue");
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("does not move dependency-blocked issues to todo via the PATCH comment path", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("blocked"));
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: "11111111-1111-4111-8111-111111111111",
      blockerIssueIds: ["33333333-3333-4333-8333-333333333333"],
      unresolvedBlockerIssueIds: ["33333333-3333-4333-8333-333333333333"],
      unresolvedBlockerCount: 1,
      allBlockersDone: false,
      isDependencyReady: false,
    });
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("blocked"),
      ...patch,
    }));

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "what is happening?" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        actorAgentId: null,
        actorUserId: "local-board",
      }),
    );
    expect(mockIssueService.update).not.toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ status: "todo" }),
    );
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        reason: "issue_commented",
        payload: expect.objectContaining({
          commentId: "comment-1",
          mutation: "comment",
        }),
      }),
    ));
  });

  it("wakes the assignee when an assigned blocked issue moves back to todo", async () => {
    const issue = makeIssue("blocked");
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "todo" });

    expect(res.status).toBe(200);
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        source: "automation",
        triggerDetail: "system",
        reason: "issue_status_changed",
        payload: expect.objectContaining({
          issueId: "11111111-1111-4111-8111-111111111111",
          mutation: "update",
        }),
      }),
    ));
  });

  it("wakes the assignee when an assigned done issue moves back to todo", async () => {
    const issue = makeIssue("done");
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "todo" });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        source: "automation",
        triggerDetail: "system",
        reason: "issue_status_changed",
        payload: expect.objectContaining({
          issueId: "11111111-1111-4111-8111-111111111111",
          mutation: "update",
        }),
        contextSnapshot: expect.objectContaining({
          issueId: "11111111-1111-4111-8111-111111111111",
          source: "issue.status_change",
        }),
      }),
    );
  });

  it("explicit same-agent resume works through the PATCH comment path", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("done"),
      ...patch,
    }));

    const res = await request(await installActor(createApp(), agentActor()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "please validate the follow-up", resume: true });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        status: "todo",
        actorAgentId: "22222222-2222-4222-8222-222222222222",
        actorUserId: null,
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.comment_added",
        details: expect.objectContaining({
          commentId: "comment-1",
          resumeIntent: true,
          followUpRequested: true,
        }),
      }),
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        reason: "issue_reopened_via_comment",
        payload: expect.objectContaining({
          commentId: "comment-1",
          reopenedFrom: "done",
          resumeIntent: true,
          followUpRequested: true,
        }),
      }),
    );
  });

  it("keeps generic same-agent comments on closed issues inert", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));

    const res = await request(await installActor(createApp(), agentActor()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "follow-up note without intent" });

    expect(res.status).toBe(201);
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("explicit same-agent resume comments reopen closed issues and mark the wake payload", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("done"),
      ...patch,
    }));

    const res = await request(await installActor(createApp(), agentActor()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "please validate the follow-up", resume: true });

    expect(res.status).toBe(201);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { status: "todo" },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.comment_added",
        details: expect.objectContaining({
          commentId: "comment-1",
          resumeIntent: true,
          followUpRequested: true,
        }),
      }),
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        reason: "issue_reopened_via_comment",
        payload: expect.objectContaining({
          commentId: "comment-1",
          reopenedFrom: "done",
          resumeIntent: true,
          followUpRequested: true,
        }),
        contextSnapshot: expect.objectContaining({
          wakeReason: "issue_reopened_via_comment",
          resumeIntent: true,
          followUpRequested: true,
        }),
      }),
    );
  });

  it("rejects explicit agent resume intent from a non-assignee", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));

    const res = await request(await installActor(createApp(), agentActor("44444444-4444-4444-8444-444444444444")))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "restart someone else's work", resume: true });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Agent cannot mutate another agent's issue");
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("rejects explicit resume intent under an active pause hold", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    mockIssueTreeControlService.getActivePauseHoldGate.mockResolvedValue({
      holdId: "hold-1",
      rootIssueId: "root-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      isRoot: false,
      mode: "pause",
      reason: "reviewing",
      releasePolicy: null,
    });

    const res = await request(await installActor(createApp(), agentActor()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "please resume", resume: true });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Issue follow-up blocked by active subtree pause hold");
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("rejects explicit resume intent on cancelled issues", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("cancelled"));

    const res = await request(await installActor(createApp(), agentActor()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "please resume", resume: true });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Cancelled issues must be restored through the dedicated restore flow");
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("interrupts an active run before a combined comment update", async () => {
    const issue = {
      ...makeIssue("todo"),
      executionRunId: "run-1",
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
    }));
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "running",
    });
    mockHeartbeatService.cancelRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "cancelled",
    });

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "hello", interrupt: true, assigneeAgentId: "33333333-3333-4333-8333-333333333333" });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.getRun).toHaveBeenCalledWith("run-1");
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith(
      "run-1",
      "Interrupted by board comment",
      expect.objectContaining({
        errorCode: "operator_interrupted",
        resultJson: expect.objectContaining({
          operatorInterrupted: true,
          interruptionSource: "issue_comment_interrupt",
          interruptedIssueId: "11111111-1111-4111-8111-111111111111",
        }),
        eventMessage: "run interrupted by board comment",
        eventPayload: expect.objectContaining({
          issueId: "11111111-1111-4111-8111-111111111111",
          source: "issue_comment_interrupt",
        }),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "heartbeat.cancelled",
        details: expect.objectContaining({
          source: "issue_comment_interrupt",
          issueId: "11111111-1111-4111-8111-111111111111",
          cancellationKind: "operator_interrupted",
          operatorInterrupted: true,
        }),
      }),
    );
  });

  it("cancels an active run when an issue is marked cancelled", async () => {
    const issue = {
      ...makeIssue("in_progress"),
      executionRunId: "run-1",
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
    }));
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "running",
    });
    mockHeartbeatService.cancelRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "cancelled",
    });

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "cancelled" });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.getRun).toHaveBeenCalledWith("run-1");
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith("run-1");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "heartbeat.cancelled",
        details: expect.objectContaining({
          source: "issue_status_cancelled",
          issueId: "11111111-1111-4111-8111-111111111111",
        }),
      }),
    );
  });

  it("does not cancel active runs when an issue is marked done", async () => {
    const issue = {
      ...makeIssue("in_progress"),
      executionRunId: "run-1",
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
    }));
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "running",
    });

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
  });

  it("writes decision ids into executionState and inserts the decision inside the transaction", async () => {
    const policy = await normalizePolicy({
      stages: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          type: "approval",
          participants: [{ type: "user", userId: "local-board" }],
        },
      ],
    })!;
    const issue = {
      ...makeIssue("todo"),
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: policy.stages[0].id,
        currentStageIndex: 0,
        currentStageType: "approval",
        currentParticipant: { type: "user", userId: "local-board" },
        returnAssignee: { type: "agent", agentId: "22222222-2222-4222-8222-222222222222" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>, tx?: unknown) => ({
      ...issue,
      ...patch,
      executionState: patch.executionState,
      status: "done",
      completedAt: new Date(),
      updatedAt: new Date(),
      _tx: tx,
    }));

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done", comment: "Approved for ship" });

    expect(res.status).toBe(200);
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        executionState: expect.objectContaining({
          status: "completed",
          lastDecisionId: expect.any(String),
          lastDecisionOutcome: "approved",
        }),
      }),
      mockTx,
    );
    const updatePatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, any>;
    const decisionId = updatePatch.executionState.lastDecisionId;
    expect(mockTxInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        id: decisionId,
        issueId: "11111111-1111-4111-8111-111111111111",
        outcome: "approved",
        body: "Approved for ship",
      }),
    );
  });

  it("auto-approves a reviewer comment with the APPROVED review marker", async () => {
    const reviewerAgentId = "33333333-3333-4333-8333-333333333333";
    const policy = await normalizePolicy({
      stages: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          type: "review",
          participants: [{ type: "agent", agentId: reviewerAgentId }],
        },
      ],
    })!;
    const issue = {
      ...makeIssue("todo"),
      status: "in_review",
      assigneeAgentId: reviewerAgentId,
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: policy.stages[0].id,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerAgentId },
        returnAssignee: { type: "agent", agentId: "22222222-2222-4222-8222-222222222222" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    const reviewBody = "## Review: PAP-580 - APPROVED\n\nLooks good.";
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-review-1",
      issueId: issue.id,
      companyId: issue.companyId,
      body: reviewBody,
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: reviewerAgentId,
      authorUserId: null,
    });
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>, tx?: unknown) => ({
      ...issue,
      ...patch,
      executionState: patch.executionState,
      status: "done",
      completedAt: new Date(),
      updatedAt: new Date(),
      _tx: tx,
    }));

    const res = await request(
      await installActor(createApp(), {
        type: "agent",
        agentId: reviewerAgentId,
        companyId: "company-1",
        source: "agent_key",
        runId: "run-review-1",
      }),
    )
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: reviewBody });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: "comment-review-1",
      issueId: issue.id,
      body: reviewBody,
    });
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        status: "done",
        actorAgentId: reviewerAgentId,
        actorUserId: null,
        executionState: expect.objectContaining({
          status: "completed",
          lastDecisionId: expect.any(String),
          lastDecisionOutcome: "approved",
        }),
      }),
      mockTx,
    );
  });

  it("auto-approves a reviewer comment with structured review metadata", async () => {
    const reviewerAgentId = "33333333-3333-4333-8333-333333333333";
    const policy = await normalizePolicy({
      stages: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          type: "review",
          participants: [{ type: "agent", agentId: reviewerAgentId }],
        },
      ],
    })!;
    const issue = {
      ...makeIssue("todo"),
      status: "in_review",
      assigneeAgentId: reviewerAgentId,
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: policy.stages[0].id,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerAgentId },
        returnAssignee: { type: "agent", agentId: "22222222-2222-4222-8222-222222222222" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    const reviewBody = "kind: review\ndecision: approved\nsummary: ship it";
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-review-2",
      issueId: issue.id,
      companyId: issue.companyId,
      body: reviewBody,
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: reviewerAgentId,
      authorUserId: null,
    });
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>, tx?: unknown) => ({
      ...issue,
      ...patch,
      executionState: patch.executionState,
      status: "done",
      completedAt: new Date(),
      updatedAt: new Date(),
      _tx: tx,
    }));

    const res = await request(
      await installActor(createApp(), {
        type: "agent",
        agentId: reviewerAgentId,
        companyId: "company-1",
        source: "agent_key",
        runId: "run-review-2",
      }),
    )
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: reviewBody });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: "comment-review-2",
      issueId: issue.id,
      body: reviewBody,
    });
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        status: "done",
        actorAgentId: reviewerAgentId,
        actorUserId: null,
        executionState: expect.objectContaining({
          status: "completed",
          lastDecisionId: expect.any(String),
          lastDecisionOutcome: "approved",
        }),
      }),
      mockTx,
    );
  });

  it("auto-approves a reviewer comment and wakes dependents when the final blocker resolves", async () => {
    const reviewerAgentId = "33333333-3333-4333-8333-333333333333";
    const dependentAgentId = "44444444-4444-4444-8444-444444444444";
    const policy = await normalizePolicy({
      stages: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          type: "review",
          participants: [{ type: "agent", agentId: reviewerAgentId }],
        },
      ],
    })!;
    const issue = {
      ...makeIssue("todo"),
      status: "in_review",
      assigneeAgentId: reviewerAgentId,
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: policy.stages[0].id,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerAgentId },
        returnAssignee: { type: "agent", agentId: "22222222-2222-4222-8222-222222222222" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
      parentId: null,
    };
    const reviewBody = "## Review: PAP-580 - APPROVED\n\nLooks good.";
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-review-3",
      issueId: issue.id,
      companyId: issue.companyId,
      body: reviewBody,
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: reviewerAgentId,
      authorUserId: null,
    });
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>, tx?: unknown) => ({
      ...issue,
      ...patch,
      executionState: patch.executionState,
      status: "done",
      completedAt: new Date(),
      updatedAt: new Date(),
      _tx: tx,
    }));
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([
      {
        id: "dependent-1",
        assigneeAgentId: dependentAgentId,
        blockerIssueIds: [issue.id],
      },
    ]);

    const res = await request(
      await installActor(createApp(), {
        type: "agent",
        agentId: reviewerAgentId,
        companyId: "company-1",
        source: "agent_key",
        runId: "run-review-3",
      }),
    )
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: reviewBody });

    expect(res.status).toBe(201);
    expect(mockIssueService.listWakeableBlockedDependents).toHaveBeenCalledWith(issue.id);
    await waitForWakeup(() => {
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
        dependentAgentId,
        expect.objectContaining({
          reason: "issue_blockers_resolved",
          payload: expect.objectContaining({
            issueId: "dependent-1",
            resolvedBlockerIssueId: issue.id,
            blockerIssueIds: [issue.id],
          }),
        }),
      );
    });
  });

  it("does not wake the returnAssignee with issue_commented when auto-approval reassigns the issue", async () => {
    const reviewerAgentId = "33333333-3333-4333-8333-333333333333";
    const returnAssigneeAgentId = "22222222-2222-4222-8222-222222222222";
    const policy = await normalizePolicy({
      stages: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          type: "review",
          participants: [{ type: "agent", agentId: reviewerAgentId }],
        },
      ],
    })!;
    const issue = {
      ...makeIssue("todo"),
      status: "in_review",
      assigneeAgentId: reviewerAgentId,
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: policy.stages[0].id,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerAgentId },
        returnAssignee: { type: "agent", agentId: returnAssigneeAgentId },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    const reviewBody = "## Review: APPROVED";
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-review-5",
      issueId: issue.id,
      companyId: issue.companyId,
      body: reviewBody,
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: reviewerAgentId,
      authorUserId: null,
    });
    // Simulate the policy transition reassigning the now-done issue back to the
    // returnAssignee so the post-mutation assignee differs from the reviewer.
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>, tx?: unknown) => ({
      ...issue,
      ...patch,
      executionState: patch.executionState,
      assigneeAgentId: returnAssigneeAgentId,
      status: "done",
      completedAt: new Date(),
      updatedAt: new Date(),
      _tx: tx,
    }));

    const res = await request(
      await installActor(createApp(), {
        type: "agent",
        agentId: reviewerAgentId,
        companyId: "company-1",
        source: "agent_key",
        runId: "run-review-stale-isclosed",
      }),
    )
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: reviewBody });

    expect(res.status).toBe(201);
    // Allow any deferred wakeup task to flush before asserting it never fired.
    await new Promise((resolve) => setImmediate(resolve));
    const issueCommentedWakeCalls = mockHeartbeatService.wakeup.mock.calls.filter(
      ([, wakeup]: [string, { reason?: string }]) => wakeup?.reason === "issue_commented",
    );
    expect(issueCommentedWakeCalls).toEqual([]);
  });

  it("does not auto-approve APPROVED comments from a non-review participant", async () => {
    const reviewerAgentId = "33333333-3333-4333-8333-333333333333";
    const policy = await normalizePolicy({
      stages: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          type: "review",
          participants: [{ type: "agent", agentId: reviewerAgentId }],
        },
      ],
    })!;
    const issue = {
      ...makeIssue("todo"),
      status: "in_review",
      assigneeAgentId: reviewerAgentId,
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: policy.stages[0].id,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerAgentId },
        returnAssignee: { type: "agent", agentId: "22222222-2222-4222-8222-222222222222" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    const reviewBody = "## Review: PAP-580 - APPROVED\n\nLooks good.";
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-review-4",
      issueId: issue.id,
      companyId: issue.companyId,
      body: reviewBody,
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: null,
      authorUserId: "local-board",
    });

    const res = await request(await installActor(createApp()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: reviewBody });

    expect(res.status).toBe(201);
    expect(mockDb.transaction).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason: "issue_blockers_resolved" }),
    );
  });

  it("does not auto-approve when actor kind disagrees with the participant kind", async () => {
    // The reviewer participant is a USER, but the request actor is an AGENT whose id collides
    // with that user's id. The auto-approval gate must dispatch on actor kind, not just id, so
    // this comment must follow the normal non-approval insert path.
    const sharedId = "33333333-3333-4333-8333-333333333333";
    const policy = await normalizePolicy({
      stages: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          type: "review",
          participants: [{ type: "user", userId: sharedId }],
        },
      ],
    })!;
    const issue = {
      ...makeIssue("todo"),
      status: "in_review",
      assigneeAgentId: null,
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: policy.stages[0].id,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "user", userId: sharedId },
        returnAssignee: { type: "agent", agentId: "22222222-2222-4222-8222-222222222222" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    const reviewBody = "## Review: PAP-580 - APPROVED\n\nShipping.";
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-mismatched-kind",
      issueId: issue.id,
      companyId: issue.companyId,
      body: reviewBody,
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: sharedId,
      authorUserId: null,
    });

    const res = await request(
      await installActor(createApp(), {
        type: "agent",
        agentId: sharedId,
        companyId: "company-1",
        source: "agent_key",
        runId: "run-kind-mismatch",
      }),
    )
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: reviewBody });

    expect(res.status).toBe(201);
    expect(mockDb.transaction).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("does not auto-approve structured metadata separated by a blank line", async () => {
    // Even though both `kind: review` and `decision: approved` appear, a blank line between
    // them means they are not on truly consecutive lines, so the strict regex must reject it.
    const reviewerAgentId = "33333333-3333-4333-8333-333333333333";
    const policy = await normalizePolicy({
      stages: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          type: "review",
          participants: [{ type: "agent", agentId: reviewerAgentId }],
        },
      ],
    })!;
    const issue = {
      ...makeIssue("todo"),
      status: "in_review",
      assigneeAgentId: reviewerAgentId,
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: policy.stages[0].id,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerAgentId },
        returnAssignee: { type: "agent", agentId: "22222222-2222-4222-8222-222222222222" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    const reviewBody = "kind: review\n\ndecision: approved";
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-blank-line-metadata",
      issueId: issue.id,
      companyId: issue.companyId,
      body: reviewBody,
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: reviewerAgentId,
      authorUserId: null,
    });

    const res = await request(
      await installActor(createApp(), {
        type: "agent",
        agentId: reviewerAgentId,
        companyId: "company-1",
        source: "agent_key",
        runId: "run-blank-line-metadata",
      }),
    )
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: reviewBody });

    expect(res.status).toBe(201);
    expect(mockDb.transaction).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("does not auto-approve reviewer comments without an approval marker", async () => {
    const reviewerAgentId = "33333333-3333-4333-8333-333333333333";
    const policy = await normalizePolicy({
      stages: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          type: "review",
          participants: [{ type: "agent", agentId: reviewerAgentId }],
        },
      ],
    })!;
    const issue = {
      ...makeIssue("todo"),
      status: "in_review",
      assigneeAgentId: reviewerAgentId,
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: policy.stages[0].id,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerAgentId },
        returnAssignee: { type: "agent", agentId: "22222222-2222-4222-8222-222222222222" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    const reviewBody = "Looks good.";
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-review-5",
      issueId: issue.id,
      companyId: issue.companyId,
      body: reviewBody,
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: reviewerAgentId,
      authorUserId: null,
    });

    const res = await request(
      await installActor(createApp(), {
        type: "agent",
        agentId: reviewerAgentId,
        companyId: "company-1",
        source: "agent_key",
        runId: "run-review-5",
      }),
    )
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: reviewBody });

    expect(res.status).toBe(201);
    expect(mockDb.transaction).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("does not auto-approve approval comments outside the in_review status", async () => {
    const reviewerAgentId = "33333333-3333-4333-8333-333333333333";
    const policy = await normalizePolicy({
      stages: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          type: "review",
          participants: [{ type: "agent", agentId: reviewerAgentId }],
        },
      ],
    })!;
    const issue = {
      ...makeIssue("todo"),
      status: "in_progress",
      assigneeAgentId: reviewerAgentId,
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: policy.stages[0].id,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerAgentId },
        returnAssignee: { type: "agent", agentId: "22222222-2222-4222-8222-222222222222" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    const reviewBody = "## Review: PAP-580 - APPROVED\n\nLooks good.";
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-review-6",
      issueId: issue.id,
      companyId: issue.companyId,
      body: reviewBody,
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: reviewerAgentId,
      authorUserId: null,
    });

    const res = await request(
      await installActor(createApp(), {
        type: "agent",
        agentId: reviewerAgentId,
        companyId: "company-1",
        source: "agent_key",
        runId: "run-review-6",
      }),
    )
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: reviewBody });

    expect(res.status).toBe(201);
    expect(mockDb.transaction).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  describe.each([
    { name: "uppercase negation", body: "## Review: NOT APPROVED" },
    { name: "uppercase negation with trailing period", body: "## Review: NOT APPROVED." },
    { name: "mixed-case negation", body: "## Review: Not approved." },
    { name: "do-not phrasing", body: "## Review: Do not approve" },
    { name: "present-progressive negation", body: "## Review: Not approving" },
    { name: "structured rejection", body: "kind: review\ndecision: rejected\nsummary: ship it" },
    { name: "structured changes_requested", body: "kind: review\ndecision: changes_requested\nsummary: ship it" },
    {
      name: "disjoint structured metadata across prose",
      body: "kind: review\n\nThe previous sprint decision: approved by stakeholders, but this round still needs work.",
    },
    {
      name: "disjoint structured metadata with summary line between",
      body: "kind: review\nsummary: needs more work\ndecision: approved",
    },
  ])("does not auto-approve negated approval phrasings ($name)", ({ body }) => {
    it("rejects the auto-approval transition and keeps the comment as a regular comment", async () => {
      const reviewerAgentId = "33333333-3333-4333-8333-333333333333";
      const policy = await normalizePolicy({
        stages: [
          {
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            type: "review",
            participants: [{ type: "agent", agentId: reviewerAgentId }],
          },
        ],
      })!;
      const issue = {
        ...makeIssue("todo"),
        status: "in_review",
        assigneeAgentId: reviewerAgentId,
        executionPolicy: policy,
        executionState: {
          status: "pending",
          currentStageId: policy.stages[0].id,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: reviewerAgentId },
          returnAssignee: { type: "agent", agentId: "22222222-2222-4222-8222-222222222222" },
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      };
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.addComment.mockResolvedValue({
        id: "comment-review-negated",
        issueId: issue.id,
        companyId: issue.companyId,
        body,
        createdAt: new Date(),
        updatedAt: new Date(),
        authorAgentId: reviewerAgentId,
        authorUserId: null,
      });

      const res = await request(
        await installActor(createApp(), {
          type: "agent",
          agentId: reviewerAgentId,
          companyId: "company-1",
          source: "agent_key",
          runId: "run-review-negated",
        }),
      )
        .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
        .send({ body });

      expect(res.status).toBe(201);
      expect(mockDb.transaction).not.toHaveBeenCalled();
      expect(mockIssueService.update).not.toHaveBeenCalled();
      expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    });
  });

  describe.each([
    { name: "uppercase approval", body: "## Review: APPROVED" },
    { name: "trailing punctuation", body: "## Review: APPROVED!" },
    { name: "ticketed approval", body: "## Review: PAP-580 - APPROVED" },
    { name: "lowercase approval", body: "## Review: LGTM, approved" },
    { name: "approval with body context", body: "## Review: APPROVED\n\nReady to ship." },
  ])("auto-approves positive approval phrasings ($name)", ({ body }) => {
    it("triggers the auto-approval transition", async () => {
      const reviewerAgentId = "33333333-3333-4333-8333-333333333333";
      const policy = await normalizePolicy({
        stages: [
          {
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            type: "review",
            participants: [{ type: "agent", agentId: reviewerAgentId }],
          },
        ],
      })!;
      const issue = {
        ...makeIssue("todo"),
        status: "in_review",
        assigneeAgentId: reviewerAgentId,
        executionPolicy: policy,
        executionState: {
          status: "pending",
          currentStageId: policy.stages[0].id,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: reviewerAgentId },
          returnAssignee: { type: "agent", agentId: "22222222-2222-4222-8222-222222222222" },
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      };
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.addComment.mockResolvedValue({
        id: "comment-review-positive",
        issueId: issue.id,
        companyId: issue.companyId,
        body,
        createdAt: new Date(),
        updatedAt: new Date(),
        authorAgentId: reviewerAgentId,
        authorUserId: null,
      });
      mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>, tx?: unknown) => ({
        ...issue,
        ...patch,
        executionState: patch.executionState,
        status: "done",
        completedAt: new Date(),
        updatedAt: new Date(),
        _tx: tx,
      }));

      const res = await request(
        await installActor(createApp(), {
          type: "agent",
          agentId: reviewerAgentId,
          companyId: "company-1",
          source: "agent_key",
          runId: "run-review-positive",
        }),
      )
        .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
        .send({ body });

      expect(res.status).toBe(201);
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(mockIssueService.update).toHaveBeenCalledWith(
        "11111111-1111-4111-8111-111111111111",
        expect.objectContaining({ status: "done" }),
        mockTx,
      );
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.updated",
          details: expect.objectContaining({
            status: "done",
            source: "auto_approval_comment",
            _previous: { status: "in_review" },
          }),
        }),
      );
    });
  });

  it("rolls back the comment when the auto-approval status transition fails", async () => {
    const reviewerAgentId = "33333333-3333-4333-8333-333333333333";
    const policy = await normalizePolicy({
      stages: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          type: "review",
          participants: [{ type: "agent", agentId: reviewerAgentId }],
        },
      ],
    })!;
    const issue = {
      ...makeIssue("todo"),
      status: "in_review",
      assigneeAgentId: reviewerAgentId,
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: policy.stages[0].id,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerAgentId },
        returnAssignee: { type: "agent", agentId: "22222222-2222-4222-8222-222222222222" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    const reviewBody = "## Review: PAP-580 - APPROVED\n\nLooks good.";
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-review-atomic",
      issueId: issue.id,
      companyId: issue.companyId,
      body: reviewBody,
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: reviewerAgentId,
      authorUserId: null,
    });
    const { unprocessable } = await import("../errors.js");
    mockIssueService.update.mockRejectedValue(unprocessable("Issue can only have one assignee"));

    const res = await request(
      await installActor(createApp(), {
        type: "agent",
        agentId: reviewerAgentId,
        companyId: "company-1",
        source: "agent_key",
        runId: "run-review-atomic",
      }),
    )
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: reviewBody });

    // The route must propagate the 422 (no successful 201) and must insert the
    // comment inside the same transaction as the status update so the comment
    // rolls back when the status update fails.
    expect(res.status).toBe(422);
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      reviewBody,
      expect.objectContaining({ agentId: reviewerAgentId }),
      expect.any(Object),
      mockTx,
    );
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("rolls back the auto-approval comment when the issue is concurrently deleted", async () => {
    const reviewerAgentId = "33333333-3333-4333-8333-333333333333";
    const policy = await normalizePolicy({
      stages: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          type: "review",
          participants: [{ type: "agent", agentId: reviewerAgentId }],
        },
      ],
    })!;
    const issue = {
      ...makeIssue("todo"),
      status: "in_review",
      assigneeAgentId: reviewerAgentId,
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: policy.stages[0].id,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerAgentId },
        returnAssignee: { type: "agent", agentId: "22222222-2222-4222-8222-222222222222" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    const reviewBody = "## Review: PAP-580 - APPROVED\n\nLooks good.";
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-review-missing",
      issueId: issue.id,
      companyId: issue.companyId,
      body: reviewBody,
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: reviewerAgentId,
      authorUserId: null,
    });
    // Simulate the concurrent-delete race: svc.update resolves to null instead of throwing.
    mockIssueService.update.mockResolvedValue(null);

    const res = await request(
      await installActor(createApp(), {
        type: "agent",
        agentId: reviewerAgentId,
        companyId: "company-1",
        source: "agent_key",
        runId: "run-review-missing",
      }),
    )
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: reviewBody });

    // The route must surface a 404 AND keep the transaction rollback path intact:
    // the addComment INSERT must run inside the same transaction that the throw aborts,
    // so the comment cannot survive when the status update finds no issue.
    expect(res.status).toBe(404);
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      reviewBody,
      expect.objectContaining({ agentId: reviewerAgentId }),
      expect.any(Object),
      mockTx,
    );
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("coerces executor handoff patches into workflow-controlled review wakes", async () => {
    const policy = await normalizePolicy({
      stages: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          type: "review",
          participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
        },
      ],
    })!;
    const issue = {
      ...makeIssue("todo"),
      status: "in_progress",
      assigneeAgentId: "22222222-2222-4222-8222-222222222222",
      executionPolicy: policy,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(
      await installActor(createApp(), {
        type: "agent",
        agentId: "22222222-2222-4222-8222-222222222222",
        companyId: "company-1",
        runId: "run-1",
      }),
    )
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({
        status: "in_review",
        assigneeAgentId: null,
        assigneeUserId: "local-board",
        reviewRequest: {
          instructions: "Please verify the fix against the reproduction steps and note any residual risk.",
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.assigneeAgentId).toBe("33333333-3333-4333-8333-333333333333");
    expect(res.body.assigneeUserId).toBeNull();
    expect(res.body.executionState).toMatchObject({
      status: "pending",
      currentStageType: "review",
      currentParticipant: {
        type: "agent",
        agentId: "33333333-3333-4333-8333-333333333333",
      },
      returnAssignee: {
        type: "agent",
        agentId: "22222222-2222-4222-8222-222222222222",
      },
      reviewRequest: {
        instructions: "Please verify the fix against the reproduction steps and note any residual risk.",
      },
    });
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333333",
      expect.objectContaining({
        reason: "execution_review_requested",
        payload: expect.objectContaining({
          issueId: "11111111-1111-4111-8111-111111111111",
          executionStage: expect.objectContaining({
            wakeRole: "reviewer",
            stageType: "review",
            reviewRequest: {
              instructions: "Please verify the fix against the reproduction steps and note any residual risk.",
            },
            allowedActions: ["approve", "request_changes"],
          }),
        }),
      }),
    ));
  });

  it("wakes the return assignee with execution_changes_requested", async () => {
    const policy = await normalizePolicy({
      stages: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          type: "review",
          participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
        },
      ],
    })!;
    const issue = {
      ...makeIssue("todo"),
      status: "in_review",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: policy.stages[0].id,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "33333333-3333-4333-8333-333333333333" },
        returnAssignee: { type: "agent", agentId: "22222222-2222-4222-8222-222222222222" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(
      await installActor(createApp(), {
        type: "agent",
        agentId: "33333333-3333-4333-8333-333333333333",
        companyId: "company-1",
        runId: "run-2",
      }),
    )
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({
        status: "in_progress",
        comment: "Needs another pass",
      });

    expect(res.status).toBe(200);
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        reason: "execution_changes_requested",
        payload: expect.objectContaining({
          issueId: "11111111-1111-4111-8111-111111111111",
          executionStage: expect.objectContaining({
            wakeRole: "executor",
            stageType: "review",
            lastDecisionOutcome: "changes_requested",
            allowedActions: ["address_changes", "resubmit"],
          }),
        }),
      }),
    ));
  });
});
