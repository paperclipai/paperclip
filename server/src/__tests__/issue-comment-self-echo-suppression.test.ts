/**
 * Tests for server-side self-echo suppression on issue_commented wakes.
 *
 * STAA-3539: When the authenticated agent is the same as the issue's assigneeAgentId,
 * the server must NOT enqueue an issue_commented wake for that agent.
 *
 * Both write paths are covered:
 *   1. POST /api/issues/:id/comments
 *   2. PATCH /api/issues/:id  (with a `comment` field)
 *
 * Must NOT affect:
 *   - Human board comments on agent-owned issues (must still wake)
 *   - Other agents commenting on the issue (must still wake assignee)
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ASSIGNEE_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const ISSUE_ID = "11111111-1111-4111-8111-111111111111";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  getDependencyReadiness: vi.fn(),
  findMentionedAgents: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  getRelationSummaries: vi.fn(),
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

const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(async () => []),
  saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
}));
const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(async () => ({
    id: "instance-settings-1",
    general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
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

vi.mock("../services/access.js", () => ({ accessService: () => mockAccessService }));
vi.mock("../services/activity-log.js", () => ({ logActivity: mockLogActivity }));
vi.mock("../services/agents.js", () => ({ agentService: () => mockAgentService }));
vi.mock("../services/feedback.js", () => ({ feedbackService: () => mockFeedbackService }));
vi.mock("../services/heartbeat.js", () => ({ heartbeatService: () => mockHeartbeatService }));
vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));
vi.mock("../services/issues.js", () => ({ issueService: () => mockIssueService }));
vi.mock("../services/routines.js", () => ({ routineService: () => mockRoutineService }));
vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => mockFeedbackService,
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => mockInstanceSettingsService,
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
  issueThreadInteractionService: () => mockIssueThreadInteractionService,
  issueTreeControlService: () => mockIssueTreeControlService,
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => mockRoutineService,
  workProductService: () => ({}),
}));

function makeApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  return app;
}

async function installActor(app: express.Express, actor: Record<string, unknown>) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/issues.js"),
    import("../middleware/index.js"),
  ]);
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes(mockDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

function agentActor(agentId: string) {
  return {
    type: "agent",
    agentId,
    companyId: "company-1",
    source: "agent_key",
    runId: "run-1",
  };
}

function boardActor() {
  return {
    type: "board",
    userId: "local-board",
    companyIds: ["company-1"],
    source: "local_implicit",
    isInstanceAdmin: false,
  };
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUE_ID,
    companyId: "company-1",
    status: "in_progress",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    assigneeAgentId: ASSIGNEE_AGENT_ID,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "STAA-9999",
    title: "Self-echo test",
    ...overrides,
  };
}

function makeComment(overrides: Record<string, unknown> = {}) {
  return {
    id: "comment-1",
    issueId: ISSUE_ID,
    companyId: "company-1",
    body: "hello",
    createdAt: new Date(),
    updatedAt: new Date(),
    authorAgentId: null,
    authorUserId: null,
    ...overrides,
  };
}

async function waitForWakeup(assertion: () => void) {
  await vi.waitFor(assertion);
}

describe.sequential("issue_commented self-echo suppression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAgentService.getById.mockResolvedValue(null);
    mockAgentService.resolveByReference.mockImplementation(async (_companyId: string, raw: string) => ({
      ambiguous: false,
      agent: { id: raw },
    }));
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
      general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
    });
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1"]);
    mockRoutineService.syncRunStatusForIssue.mockResolvedValue(undefined);
    mockIssueTreeControlService.getActivePauseHoldGate.mockResolvedValue(null);
    mockIssueService.addComment.mockResolvedValue(makeComment({ authorAgentId: ASSIGNEE_AGENT_ID }));
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
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockTxInsertValues.mockResolvedValue(undefined);
    mockTxInsert.mockImplementation(() => ({ values: mockTxInsertValues }));
    mockDbSelectOrderBy.mockResolvedValue([]);
    mockDbSelectWhere.mockImplementation(() => ({ orderBy: mockDbSelectOrderBy }));
    mockDbSelectFrom.mockImplementation(() => ({ where: mockDbSelectWhere }));
    mockDbSelect.mockImplementation(() => ({ from: mockDbSelectFrom }));
    mockDb.transaction.mockImplementation(
      async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx),
    );
  });

  // ─── POST /api/issues/:id/comments ──────────────────────────────────────────

  describe("POST /api/issues/:id/comments", () => {
    it("does NOT wake the assignee when the assignee agent posts a comment on its own issue", async () => {
      mockIssueService.getById.mockResolvedValue(makeIssue());
      const app = makeApp(agentActor(ASSIGNEE_AGENT_ID));
      await installActor(app, agentActor(ASSIGNEE_AGENT_ID));

      const res = await request(app)
        .post(`/api/issues/${ISSUE_ID}/comments`)
        .send({ body: "self-comment" });

      expect(res.status).toBe(201);

      await new Promise((r) => setTimeout(r, 50));

      const issuedCommentedWakes = mockHeartbeatService.wakeup.mock.calls.filter(
        ([agentId, wake]) => agentId === ASSIGNEE_AGENT_ID && wake.reason === "issue_commented",
      );
      expect(issuedCommentedWakes).toHaveLength(0);
    });

    it("DOES wake the assignee agent when a board user posts a comment on the issue", async () => {
      mockIssueService.getById.mockResolvedValue(makeIssue());
      mockIssueService.addComment.mockResolvedValue(makeComment({ authorUserId: "local-board" }));
      const app = makeApp(boardActor());
      await installActor(app, boardActor());

      const res = await request(app)
        .post(`/api/issues/${ISSUE_ID}/comments`)
        .send({ body: "board comment" });

      expect(res.status).toBe(201);

      await waitForWakeup(() => {
        expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
          ASSIGNEE_AGENT_ID,
          expect.objectContaining({ reason: "issue_commented" }),
        );
      });
    });

    it("DOES wake the assignee agent when a different agent posts a comment", async () => {
      mockIssueService.getById.mockResolvedValue(makeIssue());
      mockIssueService.addComment.mockResolvedValue(
        makeComment({ authorAgentId: OTHER_AGENT_ID }),
      );
      const app = makeApp(agentActor(OTHER_AGENT_ID));
      await installActor(app, agentActor(OTHER_AGENT_ID));

      const res = await request(app)
        .post(`/api/issues/${ISSUE_ID}/comments`)
        .send({ body: "other agent comment" });

      expect(res.status).toBe(201);

      await waitForWakeup(() => {
        expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
          ASSIGNEE_AGENT_ID,
          expect.objectContaining({ reason: "issue_commented" }),
        );
      });
    });
  });

  // ─── PATCH /api/issues/:id (comment field) ───────────────────────────────────

  describe("PATCH /api/issues/:id with comment field", () => {
    it("does NOT wake the assignee when the assignee agent patches its own issue with a comment", async () => {
      const issue = makeIssue();
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockResolvedValue(issue);
      mockIssueService.addComment.mockResolvedValue(
        makeComment({ authorAgentId: ASSIGNEE_AGENT_ID }),
      );
      const app = makeApp(agentActor(ASSIGNEE_AGENT_ID));
      await installActor(app, agentActor(ASSIGNEE_AGENT_ID));

      const res = await request(app)
        .patch(`/api/issues/${ISSUE_ID}`)
        .send({ comment: "self-patch-comment" });

      expect(res.status).toBe(200);

      await new Promise((r) => setTimeout(r, 50));

      const selfCommentedWakes = mockHeartbeatService.wakeup.mock.calls.filter(
        ([agentId, wake]) => agentId === ASSIGNEE_AGENT_ID && wake.reason === "issue_commented",
      );
      expect(selfCommentedWakes).toHaveLength(0);
    });

    it("DOES wake the assignee agent when a board user patches the issue with a comment", async () => {
      const issue = makeIssue();
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockResolvedValue(issue);
      mockIssueService.addComment.mockResolvedValue(
        makeComment({ authorUserId: "local-board" }),
      );
      const app = makeApp(boardActor());
      await installActor(app, boardActor());

      const res = await request(app)
        .patch(`/api/issues/${ISSUE_ID}`)
        .send({ comment: "board patch comment" });

      expect(res.status).toBe(200);

      await waitForWakeup(() => {
        expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
          ASSIGNEE_AGENT_ID,
          expect.objectContaining({ reason: "issue_commented" }),
        );
      });
    });

    it("DOES wake the assignee agent when a different agent patches with a comment", async () => {
      const issue = makeIssue();
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockResolvedValue(issue);
      mockIssueService.addComment.mockResolvedValue(
        makeComment({ authorAgentId: OTHER_AGENT_ID }),
      );
      const app = makeApp(agentActor(OTHER_AGENT_ID));
      await installActor(app, agentActor(OTHER_AGENT_ID));

      const res = await request(app)
        .patch(`/api/issues/${ISSUE_ID}`)
        .send({ comment: "other agent patch comment" });

      expect(res.status).toBe(200);

      await waitForWakeup(() => {
        expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
          ASSIGNEE_AGENT_ID,
          expect.objectContaining({ reason: "issue_commented" }),
        );
      });
    });
  });
});
