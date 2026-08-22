import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
// Mocked via the vi.mock("@paperclipai/shared/telemetry") factory below.
import { trackAgentTaskCompleted } from "@paperclipai/shared/telemetry";

const ISSUE_ID = "11111111-1111-4111-8111-111111111111";
const ASSIGNEE_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_AGENT_ID = "33333333-3333-4333-8333-333333333333";

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
  listForIssue: vi.fn(async () => []),
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  expirePendingInteractionsForTerminalIssue: vi.fn(async () => []),
}));
const mockIssueApprovalService = vi.hoisted(() => ({
  listApprovalsForIssue: vi.fn(async () => []),
}));
const mockIssueRecoveryActionService = vi.hoisted(() => ({
  getActiveForIssue: vi.fn(async () => null),
  resolveActiveForIssue: vi.fn(async () => null),
}));
const mockIssueTreeControlService = vi.hoisted(() => ({
  getActivePauseHoldGate: vi.fn(async () => null),
}));
const mockExternalObjectService = vi.hoisted(() => ({
  syncCommentSafely: vi.fn(async () => undefined),
  syncIssueSafely: vi.fn(async () => undefined),
}));
const mockCompanySkillService = vi.hoisted(() => ({
  completeTestRunForIssue: vi.fn(async () => null),
}));
const mockObserveCrossIssueInfluence = vi.hoisted(() => vi.fn());

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
  companySkillService: () => mockCompanySkillService,
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => mockFeedbackService,
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => mockInstanceSettingsService,
  issueApprovalService: () => mockIssueApprovalService,
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

vi.mock("../services/external-objects.js", () => ({
  externalObjectService: () => mockExternalObjectService,
}));

vi.mock("../services/cross-issue-influence-limit.js", () => ({
  observeCrossIssueInfluence: mockObserveCrossIssueInfluence,
  crossIssueInfluenceLimitError: vi.fn((decision: { count: number; cap: number }) => ({
    error: `Cross-issue influence cap exceeded: this run is limited to ${decision.cap} cross-issue comments or updates`,
    details: { code: "cross_issue_influence_cap_exceeded", count: decision.count, cap: decision.cap },
  })),
  crossIssueInfluenceRunContextError: vi.fn(() => new Error("cross-issue run context required")),
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

function makeIssue(status: string) {
  return {
    id: ISSUE_ID,
    companyId: "company-1",
    status,
    assigneeAgentId: ASSIGNEE_AGENT_ID,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-7682",
    title: "Disposition comment issue",
    executionPolicy: null,
    executionState: null,
  };
}

function agentActor(agentId = ASSIGNEE_AGENT_ID) {
  return {
    type: "agent",
    agentId,
    companyId: "company-1",
    source: "agent_key",
    runId: "run-actor-1",
  };
}

// Activity row that makes listSuccessfulRunHandoffStates derive state "required".
const handoffRequiredActivityRow = {
  entityId: ISSUE_ID,
  action: "issue.successful_run_handoff_required",
  agentId: ASSIGNEE_AGENT_ID,
  runId: "run-source-1",
  details: {
    sourceRunId: "run-source-1",
    correctiveRunId: "run-corrective-2",
  },
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
};

describe.sequential("issue comment disposition routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbSelectOrderBy.mockResolvedValue([]);
    mockDbSelectWhere.mockImplementation(() => ({
      orderBy: mockDbSelectOrderBy,
      then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve([]).then(onFulfilled, onRejected),
    }));
    mockDbSelectFrom.mockImplementation(() => ({ where: mockDbSelectWhere }));
    mockDbSelect.mockImplementation(() => ({ from: mockDbSelectFrom }));
    mockDb.transaction.mockImplementation(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx));
    mockTxInsert.mockImplementation(() => ({ values: mockTxInsertValues }));
    mockTxInsertValues.mockResolvedValue(undefined);
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockHeartbeatService.reportRunActivity.mockResolvedValue(undefined);
    mockHeartbeatService.getRun.mockResolvedValue(null);
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue(null);
    mockHeartbeatService.cancelRun.mockResolvedValue(null);
    mockExternalObjectService.syncCommentSafely.mockResolvedValue(undefined);
    mockExternalObjectService.syncIssueSafely.mockResolvedValue(undefined);
    mockObserveCrossIssueInfluence.mockResolvedValue({
      allowed: true,
      mode: "log_only",
      count: 1,
      cap: 20,
      enforceAt: "2026-08-11T00:00:00.000Z",
    });
    mockLogActivity.mockResolvedValue(undefined);
    mockFeedbackService.listIssueVotesForUser.mockResolvedValue([]);
    mockInstanceSettingsService.get.mockResolvedValue({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    });
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1"]);
    mockRoutineService.syncRunStatusForIssue.mockResolvedValue(undefined);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([]);
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByComment.mockResolvedValue([]);
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(null);
    mockIssueRecoveryActionService.resolveActiveForIssue.mockResolvedValue(null);
    mockIssueTreeControlService.getActivePauseHoldGate.mockResolvedValue(null);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: ISSUE_ID,
      companyId: "company-1",
      body: "Scope complete.",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: ASSIGNEE_AGENT_ID,
      authorUserId: null,
    });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: ISSUE_ID,
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
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAccessService.decide.mockImplementation(async (input: { action?: string }) => {
      const allowed = input.action !== "tasks:manage_active_checkouts";
      return {
        allowed,
        action: input.action,
        reason: allowed ? "allow_visible_issue_write" : "deny_missing_grant",
        explanation: allowed ? "Allowed by test grant." : "Missing active checkout override.",
      };
    });
    mockAgentService.getById.mockResolvedValue(null);
    mockAgentService.list.mockResolvedValue([]);
    mockCompanySkillService.completeTestRunForIssue.mockResolvedValue(null);
  });

  it("maps disposition:done on an in_progress issue to the handoff-resolving status transition", async () => {
    const issue = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));
    mockDbSelectOrderBy.mockResolvedValue([handoffRequiredActivityRow]);

    const res = await request(await installActor(createApp(), agentActor()))
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "Scope complete.", disposition: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.disposition).toEqual({ applied: true, status: "done" });
    expect(mockIssueService.update).toHaveBeenCalledWith(
      ISSUE_ID,
      expect.objectContaining({
        status: "done",
        actorAgentId: ASSIGNEE_AGENT_ID,
        actorUserId: null,
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        entityId: ISSUE_ID,
        details: expect.objectContaining({
          status: "done",
          identifier: "PAP-7682",
          source: "disposition_comment",
          disposition: "done",
          commentId: "comment-1",
          _previous: expect.objectContaining({ status: "in_progress" }),
        }),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.successful_run_handoff_resolved",
        entityId: ISSUE_ID,
        details: expect.objectContaining({
          identifier: "PAP-7682",
          sourceRunId: "run-source-1",
          correctiveRunId: "run-corrective-2",
          resolvedByStatus: "done",
        }),
      }),
    );
  });

  it("posts the comment with a machine-readable warning when the issue is not in_progress", async () => {
    const issue = makeIssue("todo");
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await installActor(createApp(), agentActor()))
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "Scope complete.", disposition: "done" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("comment-1");
    expect(res.body.disposition).toEqual({
      applied: false,
      warning: expect.objectContaining({
        code: "issue_not_in_progress",
        issueStatus: "todo",
      }),
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.successful_run_handoff_resolved" }),
    );
  });

  it("posts the comment with a machine-readable warning when the transition is rejected", async () => {
    // disposition in_review by an agent with no review path is rejected by the
    // in-review disposition gate (422); the comment must still post without a 500.
    const issue = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await installActor(createApp(), agentActor()))
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "Please review.", disposition: "in_review" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("comment-1");
    expect(res.body.disposition).toEqual({
      applied: false,
      warning: expect.objectContaining({
        code: "transition_rejected",
      }),
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.successful_run_handoff_resolved" }),
    );
  });

  it("cancels the issue's active run on disposition:cancelled, mirroring the PATCH cancelled-status path", async () => {
    const issue = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue({
      id: "run-active-1",
      status: "running",
      companyId: "company-1",
      agentId: ASSIGNEE_AGENT_ID,
      contextSnapshot: { issueId: ISSUE_ID },
    });
    mockHeartbeatService.cancelRun.mockResolvedValue({
      id: "run-active-1",
      companyId: "company-1",
      agentId: ASSIGNEE_AGENT_ID,
    });

    const res = await request(await installActor(createApp(), agentActor()))
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "Out of scope for this run.", disposition: "cancelled" });

    expect(res.status).toBe(201);
    expect(res.body.disposition).toEqual({ applied: true, status: "cancelled" });
    expect(mockIssueService.update).toHaveBeenCalledWith(
      ISSUE_ID,
      expect.objectContaining({ status: "cancelled" }),
    );
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith("run-active-1");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "heartbeat.cancelled",
        entityType: "heartbeat_run",
        entityId: "run-active-1",
        issueId: ISSUE_ID,
        details: expect.objectContaining({
          agentId: ASSIGNEE_AGENT_ID,
          source: "issue_status_cancelled",
          issueId: ISSUE_ID,
        }),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        entityId: ISSUE_ID,
        details: expect.objectContaining({
          status: "cancelled",
          source: "disposition_comment",
          disposition: "cancelled",
          cancelledStatusRunId: "run-active-1",
        }),
      }),
    );
  });

  it("syncs routine run status for the issue after a successful disposition transition", async () => {
    const issue = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await installActor(createApp(), agentActor()))
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "Scope complete.", disposition: "done" });

    expect(res.status).toBe(201);
    expect(res.body.disposition).toEqual({ applied: true, status: "done" });
    expect(mockRoutineService.syncRunStatusForIssue).toHaveBeenCalledWith(ISSUE_ID);
  });

  it("does not sync routine run status when the disposition transition is rejected", async () => {
    // Same rejected in_review disposition as the warning test above: the
    // comment posts, but no update ran, so no routine sync may fire.
    const issue = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await installActor(createApp(), agentActor()))
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "Please review.", disposition: "in_review" });

    expect(res.status).toBe(201);
    expect(res.body.disposition).toEqual({
      applied: false,
      warning: expect.objectContaining({ code: "transition_rejected" }),
    });
    expect(mockRoutineService.syncRunStatusForIssue).not.toHaveBeenCalled();
  });

  it("finalizes the skill-test run when a disposition lands a terminal status on a skill_test issue", async () => {
    const issue = { ...makeIssue("in_progress"), harnessKind: "skill_test" };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));
    mockCompanySkillService.completeTestRunForIssue.mockResolvedValue({
      id: "skill-test-run-1",
      status: "succeeded",
      outputDocumentKey: "skill-test-output-1",
    });

    const res = await request(await installActor(createApp(), agentActor()))
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "Scope complete.", disposition: "done" });

    expect(res.status).toBe(201);
    expect(res.body.disposition).toEqual({ applied: true, status: "done" });
    expect(mockCompanySkillService.completeTestRunForIssue).toHaveBeenCalledWith({
      companyId: "company-1",
      issueId: ISSUE_ID,
      outcome: "succeeded",
      error: null,
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "company.skill_test_run_completed",
        entityType: "company_skill_test_run",
        entityId: "skill-test-run-1",
        issueId: ISSUE_ID,
        details: expect.objectContaining({
          issueId: ISSUE_ID,
          status: "succeeded",
          outputDocumentKey: "skill-test-output-1",
        }),
      }),
    );
  });

  it("tracks agent task completion telemetry when a disposition lands done", async () => {
    const issue = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));
    mockAgentService.getById.mockResolvedValue({
      id: ASSIGNEE_AGENT_ID,
      role: "engineer",
      adapterType: "claude_code",
      adapterConfig: { model: "test-model-1" },
    });

    const res = await request(await installActor(createApp(), agentActor()))
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "Scope complete.", disposition: "done" });

    expect(res.status).toBe(201);
    expect(res.body.disposition).toEqual({ applied: true, status: "done" });
    expect(trackAgentTaskCompleted).toHaveBeenCalledWith(
      expect.anything(),
      {
        agentRole: "engineer",
        agentId: ASSIGNEE_AGENT_ID,
        adapterType: "claude_code",
        model: "test-model-1",
      },
    );
  });

  it("captures the authz gate denial as a machine-readable warning without mutating the issue", async () => {
    // A standard-trust agent that is neither the assignee nor a recovery-action
    // owner: the mutation gate denies through the shared issue-write denial
    // copy (run-lock, 409) via the capture shim; the comment still posts and
    // the issue stays put. The stable code travels inside `details.code`.
    const issue = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await installActor(createApp(), agentActor(OTHER_AGENT_ID)))
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "Looks done to me.", disposition: "done" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("comment-1");
    expect(res.body.disposition).toEqual({
      applied: false,
      warning: expect.objectContaining({
        code: "transition_rejected",
        message: expect.stringContaining("Another agent's run owns this task"),
        details: expect.objectContaining({
          code: "issue_write_assignee_run_lock",
          issueId: ISSUE_ID,
          assigneeAgentId: ASSIGNEE_AGENT_ID,
          actorAgentId: OTHER_AGENT_ID,
        }),
      }),
    });
    // The issue's stored status was never touched: no update reached the DB.
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.updated" }),
    );
  });

  it("keeps plain comments without a disposition unchanged", async () => {
    const issue = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await installActor(createApp(), agentActor()))
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "Progress update." });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("comment-1");
    expect(res.body).not.toHaveProperty("disposition");
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.updated" }),
    );
  });
});
