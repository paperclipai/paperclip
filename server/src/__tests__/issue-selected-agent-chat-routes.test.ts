import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ISSUE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMPANY_ID = "company-1";
const CEO_AGENT_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const ASSIGNEE_AGENT_ID = "33333333-3333-4333-8333-333333333333";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  listComments: vi.fn(),
  getComment: vi.fn(),
  getRelationSummaries: vi.fn(),
  findMentionedAgents: vi.fn(async () => []),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
  reportRunActivity: vi.fn(async () => undefined),
}));

const mockIssueReferenceService = vi.hoisted(() => ({
  listIssueReferenceSummary: vi.fn(async () => ({ outbound: [], inbound: [] })),
  diffIssueReferenceSummary: vi.fn(() => ({
    addedReferencedIssues: [],
    removedReferencedIssues: [],
    currentReferencedIssues: [],
  })),
  syncComment: vi.fn(async () => undefined),
}));

const mockAccessDecide = vi.hoisted(() => vi.fn(async (input: { action?: string }) => ({
  allowed: true,
  action: input.action,
  reason: "allow_explicit_grant",
  explanation: "Allowed by test grant.",
})));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

const mockResolveHeartbeatSchedulingSuppression = vi.hoisted(() =>
  vi.fn((): { suppressed: boolean; reason: string | null } => ({ suppressed: false, reason: null })),
);

vi.mock("../services/index.js", () => ({
  companyService: () => ({}),
  companySkillService: () => ({}),
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
  companySearchService: () => ({}),
  documentAnnotationService: () => ({}),
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
    getGeneral: vi.fn(async () => ({
      censorUsernameInLogs: false,
      feedbackDataSharingPreference: "prompt",
    })),
    listCompanyIds: vi.fn(async () => [COMPANY_ID]),
  }),
  issueApprovalService: () => ({}),
  issueReferenceService: () => mockIssueReferenceService,
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
  issueService: () => mockIssueService,
  issueThreadInteractionService: () => ({
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  }),
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  resolveHeartbeatSchedulingSuppression: mockResolveHeartbeatSchedulingSuppression,
  workProductService: () => ({}),
}));

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUE_ID,
    companyId: COMPANY_ID,
    status: "in_progress",
    priority: "medium",
    projectId: "project-1",
    goalId: "goal-1",
    parentId: null,
    assigneeAgentId: ASSIGNEE_AGENT_ID,
    assigneeUserId: null,
    identifier: "PAP-999",
    title: "Selected chat",
    executionRunId: null,
    executionPolicy: null,
    billingCode: "engineering",
    ...overrides,
  };
}

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: TARGET_AGENT_ID,
    companyId: COMPANY_ID,
    name: "Target",
    role: "engineer",
    status: "active",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function thenableRows(rows: Array<Record<string, unknown>>) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: (resolve: (value: Array<Record<string, unknown>>) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
}

function createDbStub(...selectRows: Array<Array<Record<string, unknown>>>) {
  const rowsQueue = [...selectRows];
  const execute = vi.fn(async () => undefined);
  const db = {
    select: vi.fn(() => thenableRows(rowsQueue.shift() ?? [])),
    execute,
    transaction: vi.fn(async (run: (tx: { execute: typeof execute }) => Promise<unknown>) => run({ execute })),
  };
  return db;
}

async function createApp(
  db: Record<string, unknown>,
  actor: Express.Request["actor"] = {
    type: "board",
    userId: "local-board",
    companyIds: [COMPANY_ID],
    source: "local_implicit",
    isInstanceAdmin: false,
  },
) {
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
  app.use("/api", issueRoutes(db as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("selected-agent issue chat backend", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
    mockAccessDecide.mockResolvedValue({
      allowed: true,
      action: "issue:read",
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant.",
    });
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.update.mockResolvedValue(makeIssue());
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: ISSUE_ID,
      companyId: COMPANY_ID,
      body: "hello ceo",
    });
    mockIssueService.listComments.mockResolvedValue([]);
    mockIssueService.getComment.mockResolvedValue({
      id: "comment-1",
      issueId: ISSUE_ID,
      companyId: COMPANY_ID,
      body: "hello ceo",
    });
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockHeartbeatService.getRun.mockResolvedValue(null);
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue(null);
    mockHeartbeatService.cancelRun.mockResolvedValue(null);
  });

  it("defaults omitted targetAgentId to the company CEO and wakes only that real agent", async () => {
    const db = createDbStub(
      [makeAgent({ id: CEO_AGENT_ID, name: "CEO", role: "ceo" })],
      [],
    );

    const res = await request(await createApp(db))
      .post(`/api/issues/${ISSUE_ID}/selected-agent-chat/comments`)
      .send({ body: "how is it going?" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      ISSUE_ID,
      "how is it going?",
      expect.objectContaining({ userId: "local-board" }),
      expect.objectContaining({ authorType: "user" }),
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      CEO_AGENT_ID,
      expect.objectContaining({
        reason: "issue_commented",
        payload: expect.objectContaining({
          issueId: ISSUE_ID,
          targetAgentId: CEO_AGENT_ID,
          selectedAgentChat: true,
          taskKey: `selected-agent-chat:${ISSUE_ID}:${CEO_AGENT_ID}`,
        }),
        contextSnapshot: expect.objectContaining({
          issueId: ISSUE_ID,
          targetAgentId: CEO_AGENT_ID,
          selectedAgentChat: true,
          taskKey: `selected-agent-chat:${ISSUE_ID}:${CEO_AGENT_ID}`,
          projectId: "project-1",
          goalId: "goal-1",
          billingCode: "engineering",
        }),
      }),
    );
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.anything(),
    );
    expect(res.body.wake).toEqual({ suppressed: false, reason: null });
  });

  it("reports wake suppression so the chat UI can explain a silent no-reply", async () => {
    mockResolveHeartbeatSchedulingSuppression.mockReturnValueOnce({
      suppressed: true,
      reason: "worktree_instance",
    });
    const db = createDbStub(
      [makeAgent({ id: CEO_AGENT_ID, name: "CEO", role: "ceo" })],
      [],
    );

    const res = await request(await createApp(db))
      .post(`/api/issues/${ISSUE_ID}/selected-agent-chat/comments`)
      .send({ body: "hello?" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.wake).toEqual({ suppressed: true, reason: "worktree_instance" });
  });

  it("titles new board chat issues from the first selected-agent message and stores the target agent", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({
      originKind: "board_chat",
      originId: null,
      title: "New chat",
    }));
    const db = createDbStub(
      [makeAgent({ id: CEO_AGENT_ID, name: "CEO", role: "ceo" })],
      [],
    );

    const res = await request(await createApp(db))
      .post(`/api/issues/${ISSUE_ID}/selected-agent-chat/comments`)
      .send({ body: "Can you summarize the hiring plan before tomorrow?" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      ISSUE_ID,
      {
        originId: CEO_AGENT_ID,
        title: "Can you summarize the hiring plan before tomorrow?",
      },
    );
  });

  it("holds the selected-agent chat lock until wake creation finishes", async () => {
    let releaseWakeup: (() => void) | undefined;
    mockHeartbeatService.wakeup.mockImplementation(
      () => new Promise<void>((resolve) => {
        releaseWakeup = resolve;
      }),
    );
    const db = createDbStub([makeAgent()], [], []);
    const app = await createApp(db);

    const responsePromise = request(app)
      .post(`/api/issues/${ISSUE_ID}/selected-agent-chat/comments`)
      .send({ body: "hello", targetAgentId: TARGET_AGENT_ID })
      .then((response) => response);

    await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1));
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(db.transaction.mock.results[0]?.value).toBeInstanceOf(Promise);

    releaseWakeup?.();
    const response = await responsePromise;
    expect(response.status).toBe(201);
  });

  it("keeps a custom board chat title while refreshing the selected target agent", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({
      originKind: "board_chat",
      originId: CEO_AGENT_ID,
      title: "Hiring plan",
    }));
    const db = createDbStub(
      [makeAgent()],
      [],
    );

    const res = await request(await createApp(db))
      .post(`/api/issues/${ISSUE_ID}/selected-agent-chat/comments`)
      .send({ body: "switch this to the CTO", targetAgentId: TARGET_AGENT_ID });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      ISSUE_ID,
      {
        originId: TARGET_AGENT_ID,
      },
    );
  });

  it("rejects a targetAgentId outside the issue company", async () => {
    const db = createDbStub([makeAgent({ companyId: "other-company" })]);

    const res = await request(await createApp(db))
      .post(`/api/issues/${ISSUE_ID}/selected-agent-chat/comments`)
      .send({ body: "hello", targetAgentId: TARGET_AGENT_ID });

    expect(res.status).toBe(422);
    expect(res.body.details.code).toBe("invalid_target_agent");
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("rejects unavailable selected chat targets with a clear conflict", async () => {
    const db = createDbStub([makeAgent({ status: "paused" })]);

    const res = await request(await createApp(db))
      .post(`/api/issues/${ISSUE_ID}/selected-agent-chat/comments`)
      .send({ body: "hello", targetAgentId: TARGET_AGENT_ID });

    expect(res.status).toBe(409);
    expect(res.body.details.code).toBe("target_agent_unavailable");
    expect(res.body.details.targetAgentStatus).toBe("paused");
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("rejects retargeting while a different selected-agent chat run is active", async () => {
    const activeAgentId = "44444444-4444-4444-8444-444444444444";
    const db = createDbStub(
      [makeAgent()],
      [{ id: "run-active", agentId: activeAgentId, status: "running" }],
    );

    const res = await request(await createApp(db))
      .post(`/api/issues/${ISSUE_ID}/selected-agent-chat/comments`)
      .send({ body: "hello", targetAgentId: TARGET_AGENT_ID });

    expect(res.status).toBe(409);
    expect(res.body.details.code).toBe("selected_agent_chat_target_active");
    expect(res.body.details.activeTargetAgentId).toBe(activeAgentId);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("enforces issue read authorization on issue-backed chat read surfaces", async () => {
    mockAccessDecide.mockResolvedValue({
      allowed: false,
      action: "issue:read",
      reason: "deny_low_trust_boundary",
      explanation: "Issue is outside this low-trust boundary.",
    });
    const app = await createApp(createDbStub());

    const [comments, comment, interactions] = await Promise.all([
      request(app).get(`/api/issues/${ISSUE_ID}/comments`),
      request(app).get(`/api/issues/${ISSUE_ID}/comments/comment-1`),
      request(app).get(`/api/issues/${ISSUE_ID}/interactions`),
    ]);

    for (const res of [comments, comment, interactions]) {
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "Issue is outside this actor's authorization boundary" });
    }
    expect(mockIssueService.listComments).not.toHaveBeenCalled();
    expect(mockIssueService.getComment).not.toHaveBeenCalled();
  });

  it("rejects board comments on board_chat issues through the generic issue comment route", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({
      originKind: "board_chat",
      assigneeAgentId: null,
      status: "todo",
    }));
    const app = await createApp(createDbStub());

    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "bypass selected chat" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("board_chat_generic_comments_forbidden");
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("rejects board comments on board_chat issues through the generic issue update route", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({
      originKind: "board_chat",
      assigneeAgentId: null,
      status: "todo",
    }));
    const app = await createApp(createDbStub());

    const res = await request(app)
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ comment: "bypass selected chat" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("board_chat_generic_comments_forbidden");
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("rejects agent API comments on board_chat issues without a selected-agent chat run", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({
      originKind: "board_chat",
      assigneeAgentId: null,
      status: "todo",
    }));
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      agentId: TARGET_AGENT_ID,
      status: "running",
      contextSnapshot: {
        issueId: ISSUE_ID,
        selectedAgentChat: false,
        targetAgentId: TARGET_AGENT_ID,
      },
    });
    const app = await createApp(createDbStub(), {
      type: "agent",
      agentId: TARGET_AGENT_ID,
      companyId: COMPANY_ID,
      runId: "run-1",
      source: "agent_key",
    });

    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "agent bypass" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("board_chat_selected_agent_run_required");
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("rejects agent API update comments on board_chat issues without a selected-agent chat run", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({
      originKind: "board_chat",
      assigneeAgentId: null,
      status: "todo",
    }));
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      agentId: TARGET_AGENT_ID,
      status: "running",
      contextSnapshot: {
        issueId: ISSUE_ID,
        selectedAgentChat: false,
        targetAgentId: TARGET_AGENT_ID,
      },
    });
    const app = await createApp(createDbStub(), {
      type: "agent",
      agentId: TARGET_AGENT_ID,
      companyId: COMPANY_ID,
      runId: "run-1",
      source: "agent_key",
    });

    const res = await request(app)
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ comment: "agent bypass" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("board_chat_selected_agent_run_required");
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("allows the active selected-agent chat target to reply on a board_chat issue", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({
      originKind: "board_chat",
      assigneeAgentId: null,
      status: "todo",
    }));
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-selected",
      agentId: TARGET_AGENT_ID,
      status: "running",
      contextSnapshot: {
        issueId: ISSUE_ID,
        selectedAgentChat: true,
        targetAgentId: TARGET_AGENT_ID,
      },
    });
    const app = await createApp(createDbStub(), {
      type: "agent",
      agentId: TARGET_AGENT_ID,
      companyId: COMPANY_ID,
      runId: "run-selected",
      source: "agent_key",
    });

    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "Here is the report." });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      ISSUE_ID,
      "Here is the report.",
      expect.objectContaining({ agentId: TARGET_AGENT_ID, runId: "run-selected" }),
      expect.any(Object),
    );
  });

  it("allows the active selected-agent chat target to reply through the issue update route", async () => {
    const boardChatIssue = makeIssue({
      originKind: "board_chat",
      assigneeAgentId: null,
      status: "todo",
    });
    mockIssueService.getById.mockResolvedValue(boardChatIssue);
    mockIssueService.update.mockResolvedValue(boardChatIssue);
    mockIssueReferenceService.listIssueReferenceSummary.mockResolvedValue({
      outbound: [],
      inbound: [],
    });
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-selected",
      agentId: TARGET_AGENT_ID,
      status: "running",
      contextSnapshot: {
        issueId: ISSUE_ID,
        selectedAgentChat: true,
        targetAgentId: TARGET_AGENT_ID,
      },
    });
    const app = await createApp(createDbStub(), {
      type: "agent",
      agentId: TARGET_AGENT_ID,
      companyId: COMPANY_ID,
      runId: "run-selected",
      source: "agent_key",
    });

    const res = await request(app)
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ comment: "Here is the report." });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      ISSUE_ID,
      "Here is the report.",
      expect.objectContaining({ agentId: TARGET_AGENT_ID, runId: "run-selected" }),
      expect.any(Object),
    );
  });
});
