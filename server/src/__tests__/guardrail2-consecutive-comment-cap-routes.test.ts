/**
 * Tests for Guardrail 2: consecutive agent comment cap (FUL-2207).
 *
 * When an assignee agent posts CONSECUTIVE_AGENT_COMMENT_CAP or more comments
 * in a row with no human or other-agent reply, the route must:
 *   1. Set the issue to `blocked` (which also clears checkout fields)
 *   2. Post a system comment tagging the CTO
 *   3. NOT dispatch a wakeup to the agent for that comment
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ASSIGNEE_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const ISSUE_ID = "11111111-1111-4111-8111-111111111111";

// Three consecutive comments all authored by the assignee agent.
function makeAgentCommentStreak(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `comment-streak-${i}`,
    issueId: ISSUE_ID,
    companyId: "company-1",
    body: `consecutive comment ${i + 1}`,
    authorAgentId: ASSIGNEE_AGENT_ID,
    authorUserId: null,
    authorType: "agent",
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
}

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  listComments: vi.fn(),
  getDependencyReadiness: vi.fn(),
  findMentionedAgents: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
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
const mockTx = vi.hoisted(() => ({ insert: mockTxInsert }));
const mockDbSelectOrderBy = vi.hoisted(() => vi.fn(async () => []));
const mockDbSelectWhere = vi.hoisted(() => vi.fn(() => ({ orderBy: mockDbSelectOrderBy })));
const mockDbSelectFrom = vi.hoisted(() => vi.fn(() => ({ where: mockDbSelectWhere })));
const mockDbSelect = vi.hoisted(() => vi.fn(() => ({ from: mockDbSelectFrom })));
const mockDb = vi.hoisted(() => ({
  select: mockDbSelect,
  transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(async () => ({
    id: "instance-settings-1",
    general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
  })),
  listCompanyIds: vi.fn(async () => ["company-1"]),
}));

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentTaskCompleted: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));
vi.mock("../telemetry.js", () => ({ getTelemetryClient: vi.fn(() => ({ track: vi.fn() })) }));
vi.mock("../services/access.js", () => ({ accessService: () => mockAccessService }));
vi.mock("../services/activity-log.js", () => ({ logActivity: mockLogActivity }));
vi.mock("../services/agents.js", () => ({ agentService: () => mockAgentService }));
vi.mock("../services/feedback.js", () => ({
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null })),
  }),
}));
vi.mock("../services/heartbeat.js", () => ({ heartbeatService: () => mockHeartbeatService }));
vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));
vi.mock("../services/issues.js", () => ({ issueService: () => mockIssueService }));
vi.mock("../services/routines.js", () => ({
  routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null })),
  }),
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => mockInstanceSettingsService,
  issueApprovalService: () => ({}),
  issueRecoveryActionService: () => ({ getActiveForIssue: vi.fn(async () => null) }),
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
  issueThreadInteractionService: () => ({
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  }),
  issueTreeControlService: () => ({ getActivePauseHoldGate: vi.fn(async () => null) }),
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
  workProductService: () => ({}),
  ISSUE_LIST_DEFAULT_LIMIT: 25,
  ISSUE_LIST_MAX_LIMIT: 100,
  clampIssueListLimit: (n: number) => Math.min(n, 100),
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

function makeInProgressIssue() {
  return {
    id: ISSUE_ID,
    companyId: "company-1",
    status: "in_progress",
    assigneeAgentId: ASSIGNEE_AGENT_ID,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "FUL-9999",
    title: "Guardrail 2 test issue",
    blockedByIssueIds: [],
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    checkoutRunId: null,
    executionState: null,
    executionPolicy: null,
    parentId: null,
    goalId: null,
    projectId: null,
    requestDepth: 0,
  };
}

function agentActor(agentId = ASSIGNEE_AGENT_ID) {
  return {
    type: "agent",
    agentId,
    companyId: "company-1",
    source: "agent_key",
    runId: "run-guardrail2",
  };
}

const BASE_COMMENT_RESPONSE = {
  id: "comment-new",
  issueId: ISSUE_ID,
  companyId: "company-1",
  body: "agent says something again",
  authorAgentId: ASSIGNEE_AGENT_ID,
  authorUserId: null,
  authorType: "agent",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe.sequential("guardrail 2: consecutive agent comment cap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTxInsertValues.mockResolvedValue(undefined);
    mockTxInsert.mockImplementation(() => ({ values: mockTxInsertValues }));
    mockDbSelectOrderBy.mockResolvedValue([]);
    mockDbSelectWhere.mockImplementation(() => ({ orderBy: mockDbSelectOrderBy }));
    mockDbSelectFrom.mockImplementation(() => ({ where: mockDbSelectWhere }));
    mockDbSelect.mockImplementation(() => ({ from: mockDbSelectFrom }));
    mockDb.transaction.mockImplementation(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx));
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockHeartbeatService.reportRunActivity.mockResolvedValue(undefined);
    mockHeartbeatService.getRun.mockResolvedValue(null);
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue(null);
    mockHeartbeatService.cancelRun.mockResolvedValue(null);
    mockLogActivity.mockResolvedValue(undefined);
    mockInstanceSettingsService.get.mockResolvedValue({
      id: "instance-settings-1",
      general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
    });
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1"]);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: ISSUE_ID,
      blockerIssueIds: [],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      allBlockersDone: true,
      isDependencyReady: true,
    });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.addComment.mockResolvedValue(BASE_COMMENT_RESPONSE);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeInProgressIssue(),
      ...patch,
    }));
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAgentService.getById.mockResolvedValue(null);
    mockAgentService.list.mockResolvedValue([
      { id: ASSIGNEE_AGENT_ID, reportsTo: null, permissions: { canCreateAgents: false } },
    ]);
    mockAgentService.resolveByReference.mockResolvedValue(null);
  });

  it("auto-pauses when assignee posts 3 consecutive comments with no other actor in between", async () => {
    mockIssueService.getById.mockResolvedValue(makeInProgressIssue());
    // Simulate 3 consecutive agent comments already in the DB (newest first):
    // the one just posted (index 0) plus 2 prior ones = 3 total.
    mockIssueService.listComments.mockResolvedValue(makeAgentCommentStreak(3));

    const res = await request(await installActor(createApp(), agentActor()))
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "third consecutive comment, should trigger cap" });

    expect(res.status).toBe(201);

    // Issue must be blocked.
    expect(mockIssueService.update).toHaveBeenCalledWith(
      ISSUE_ID,
      expect.objectContaining({ status: "blocked" }),
    );

    // A system comment must be posted (the auto-pause notification).
    const systemCommentCall = mockIssueService.addComment.mock.calls.find(
      (call) => call[2]?.authorType === "system" || call[3]?.authorType === "system",
    );
    expect(systemCommentCall).toBeTruthy();

    // No wakeup dispatched to the assignee after auto-pause.
    await vi.waitFor(() => {
      const assigneeWake = mockHeartbeatService.wakeup.mock.calls.find(
        (call) => call[0] === ASSIGNEE_AGENT_ID,
      );
      expect(assigneeWake).toBeUndefined();
    });
  });

  it("does NOT auto-pause when there are fewer than 3 consecutive agent comments", async () => {
    mockIssueService.getById.mockResolvedValue(makeInProgressIssue());
    // Only 2 consecutive — below the cap.
    mockIssueService.listComments.mockResolvedValue(makeAgentCommentStreak(2));

    const res = await request(await installActor(createApp(), agentActor()))
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "second comment, should not trigger cap" });

    expect(res.status).toBe(201);
    // update should not have been called for auto-pause (the issue stays in_progress).
    const blockedCall = mockIssueService.update.mock.calls.find(
      (call) => call[1]?.status === "blocked",
    );
    expect(blockedCall).toBeUndefined();
  });

  it("does NOT auto-pause when a human commented between agent comments", async () => {
    mockIssueService.getById.mockResolvedValue(makeInProgressIssue());
    // Newest first: agent comment, human comment, agent comment (streak resets at human).
    mockIssueService.listComments.mockResolvedValue([
      {
        id: "c3",
        issueId: ISSUE_ID,
        companyId: "company-1",
        body: "latest agent comment",
        authorAgentId: ASSIGNEE_AGENT_ID,
        authorUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "c2",
        issueId: ISSUE_ID,
        companyId: "company-1",
        body: "human review",
        authorAgentId: null,
        authorUserId: "local-board",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "c1",
        issueId: ISSUE_ID,
        companyId: "company-1",
        body: "first agent comment",
        authorAgentId: ASSIGNEE_AGENT_ID,
        authorUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const res = await request(await installActor(createApp(), agentActor()))
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "agent comment after human reply" });

    expect(res.status).toBe(201);
    const blockedCall = mockIssueService.update.mock.calls.find(
      (call) => call[1]?.status === "blocked",
    );
    expect(blockedCall).toBeUndefined();
  });

  it("does NOT auto-pause when a different agent commented in between", async () => {
    mockIssueService.getById.mockResolvedValue(makeInProgressIssue());
    // streak broken by OTHER_AGENT_ID comment.
    mockIssueService.listComments.mockResolvedValue([
      {
        id: "c3",
        issueId: ISSUE_ID,
        companyId: "company-1",
        body: "latest assignee comment",
        authorAgentId: ASSIGNEE_AGENT_ID,
        authorUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "c2",
        issueId: ISSUE_ID,
        companyId: "company-1",
        body: "other agent comment",
        authorAgentId: OTHER_AGENT_ID,
        authorUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "c1",
        issueId: ISSUE_ID,
        companyId: "company-1",
        body: "first assignee comment",
        authorAgentId: ASSIGNEE_AGENT_ID,
        authorUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const res = await request(await installActor(createApp(), agentActor()))
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "assignee comment after other agent" });

    expect(res.status).toBe(201);
    const blockedCall = mockIssueService.update.mock.calls.find(
      (call) => call[1]?.status === "blocked",
    );
    expect(blockedCall).toBeUndefined();
  });

  it("does NOT auto-pause on closed (done) issues", async () => {
    mockIssueService.getById.mockResolvedValue({ ...makeInProgressIssue(), status: "done" });
    // listComments must NOT be called for closed issues.

    const res = await request(await installActor(createApp(), agentActor()))
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "comment on a done issue" });

    // Even if the HTTP response is 201, listComments should not be called.
    expect(mockIssueService.listComments).not.toHaveBeenCalled();
    const blockedCall = mockIssueService.update.mock.calls.find(
      (call) => call[1]?.status === "blocked",
    );
    expect(blockedCall).toBeUndefined();
  });

  it("does NOT auto-pause when the commenter is not the assignee", async () => {
    mockIssueService.getById.mockResolvedValue(makeInProgressIssue()); // assignee = ASSIGNEE_AGENT_ID
    // Comment from a different agent (not the assignee).
    const res = await request(await installActor(createApp(), agentActor(OTHER_AGENT_ID)))
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "comment from non-assignee agent" });

    // listComments should not be called when the commenter is not the assignee.
    expect(mockIssueService.listComments).not.toHaveBeenCalled();
  });
});
