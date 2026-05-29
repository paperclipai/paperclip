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
  listComments: vi.fn(),
  getCommentCursor: vi.fn(),
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
const mockDbSelectLimit = vi.hoisted(() => vi.fn(async () => []));
const mockDbSelectOrderBy = vi.hoisted(() => vi.fn(() => ({ limit: mockDbSelectLimit })));
const mockDbSelectWhere = vi.hoisted(() => vi.fn(() => ({ orderBy: mockDbSelectOrderBy })));
const mockDbSelectFrom = vi.hoisted(() => vi.fn(() => ({ where: mockDbSelectWhere })));
const mockDbSelect = vi.hoisted(() => vi.fn(() => ({ from: mockDbSelectFrom })));
const mockDb = vi.hoisted(() => ({
  select: mockDbSelect,
  transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
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
    (req as { actor: Record<string, unknown> }).actor = actor ?? agentActor();
    next();
  });
  app.use("/api", issueRoutes(mockDb as never, {} as never));
  app.use(errorHandler);
  return app;
}

function makeIssue() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    status: "in_progress",
    assigneeAgentId: "22222222-2222-4222-8222-222222222222",
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-126",
    title: "Freshness test",
  };
}

function makeComment(overrides: Record<string, unknown> = {}) {
  return {
    id: "comment-new",
    issueId: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    body: "hello",
    createdAt: new Date("2026-05-29T01:00:00.000Z"),
    updatedAt: new Date("2026-05-29T01:00:00.000Z"),
    authorAgentId: "22222222-2222-4222-8222-222222222222",
    authorUserId: null,
    authorType: "agent",
    ...overrides,
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

function localBoardActor() {
  return {
    type: "board",
    userId: "local-board",
    companyIds: ["company-1"],
    source: "local_implicit",
    isInstanceAdmin: true,
  };
}

describe.sequential("issue comment freshness guard routes (SLI-110)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.addComment.mockResolvedValue(makeComment());
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
    mockIssueService.getCommentCursor.mockResolvedValue({
      latestCommentId: "comment-known",
      latestCommentAt: new Date("2026-05-29T00:00:00.000Z"),
      totalComments: 1,
    });
    mockIssueService.listComments.mockResolvedValue([]);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "issue:mutate",
      reason: "allow_explicit_grant",
      explanation: "Allowed.",
    });
    mockAgentService.getById.mockResolvedValue(null);
    mockAgentService.list.mockResolvedValue([]);
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: null });
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockHeartbeatService.reportRunActivity.mockResolvedValue(undefined);
    mockHeartbeatService.getRun.mockResolvedValue(null);
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue(null);
    mockHeartbeatService.cancelRun.mockResolvedValue(null);
    mockLogActivity.mockResolvedValue(undefined);
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
  });

  describe("POST /issues/:id/comments", () => {
    it("accepts a write with no If-Match header (back-compat)", async () => {
      const res = await request(await installActor(createApp()))
        .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
        .send({ body: "hello" });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe("comment-new");
      expect(mockIssueService.addComment).toHaveBeenCalled();
      expect(mockIssueService.getCommentCursor).not.toHaveBeenCalled();
    });

    it("accepts a fresh write whose If-Match matches the server cursor", async () => {
      const res = await request(await installActor(createApp()))
        .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
        .set("If-Match", "comment-known")
        .send({ body: "hello" });

      expect(res.status).toBe(201);
      expect(mockIssueService.getCommentCursor).toHaveBeenCalledTimes(1);
      expect(mockIssueService.addComment).toHaveBeenCalled();
    });

    it("rejects a stale write with 409 stale_comment_cursor and lists missed comments", async () => {
      mockIssueService.getCommentCursor.mockResolvedValue({
        latestCommentId: "comment-newest",
        latestCommentAt: new Date("2026-05-29T01:00:00.000Z"),
        totalComments: 3,
      });
      mockIssueService.listComments.mockResolvedValue([
        {
          id: "comment-missed-1",
          issueId: "11111111-1111-4111-8111-111111111111",
          authorType: "user",
          createdAt: new Date("2026-05-29T00:30:00.000Z"),
          body: "Actually, do option B.",
        },
        {
          id: "comment-newest",
          issueId: "11111111-1111-4111-8111-111111111111",
          authorType: "user",
          createdAt: new Date("2026-05-29T01:00:00.000Z"),
          body: "Confirmed: option B.",
        },
      ]);

      const res = await request(await installActor(createApp()))
        .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
        .set("If-Match", "comment-stale")
        .send({ body: "Going with option A" });

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        error: "stale_comment_cursor",
        expected: "comment-newest",
        received: "comment-stale",
        retryHint: "Refresh, reconcile, retry.",
      });
      expect(res.body.since).toHaveLength(2);
      expect(res.body.since[0]).toMatchObject({
        id: "comment-missed-1",
        authorType: "user",
        bodyPreview: "Actually, do option B.",
      });
      expect(mockIssueService.addComment).not.toHaveBeenCalled();
    });

    it("honors the system bypass header for the local harness actor", async () => {
      mockIssueService.getCommentCursor.mockResolvedValue({
        latestCommentId: "comment-newer",
        latestCommentAt: new Date(),
        totalComments: 2,
      });
      const res = await request(await installActor(createApp(), localBoardActor()))
        .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
        .set("If-Match", "comment-old")
        .set("X-Paperclip-System-Comment", "1")
        .send({ body: "system follow-up" });

      expect(res.status).toBe(201);
      expect(mockIssueService.addComment).toHaveBeenCalled();
      // bypass means we skip the cursor lookup entirely
      expect(mockIssueService.getCommentCursor).not.toHaveBeenCalled();
    });

    it("ignores the system bypass header for non-harness actors", async () => {
      mockIssueService.getCommentCursor.mockResolvedValue({
        latestCommentId: "comment-newer",
        latestCommentAt: new Date(),
        totalComments: 2,
      });
      mockIssueService.listComments.mockResolvedValue([]);

      const res = await request(await installActor(createApp()))
        .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
        .set("If-Match", "comment-stale")
        .set("X-Paperclip-System-Comment", "1")
        .send({ body: "trying to bypass" });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe("stale_comment_cursor");
      expect(mockIssueService.addComment).not.toHaveBeenCalled();
    });

    it("returns the original 201 response on idempotency-key replay", async () => {
      const app = await installActor(createApp());
      const first = await request(app)
        .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
        .set("If-Match", "comment-known")
        .set("Idempotency-Key", "freshness-test-key-1")
        .send({ body: "first try" });

      expect(first.status).toBe(201);
      expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
      const firstBody = first.body;

      mockIssueService.addComment.mockResolvedValue(makeComment({ id: "comment-DIFFERENT" }));
      const replay = await request(app)
        .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
        .set("If-Match", "comment-known")
        .set("Idempotency-Key", "freshness-test-key-1")
        .send({ body: "first try" });

      expect(replay.status).toBe(201);
      expect(replay.body).toEqual(firstBody);
      // The second call should NOT have re-invoked addComment.
      expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
    });

    it("reproduces the SLI-59 race: writer A wakes with cursor X, user posts Y, A submits stale → 409 with Y", async () => {
      mockIssueService.getCommentCursor.mockResolvedValue({
        latestCommentId: "comment-Y",
        latestCommentAt: new Date("2026-05-29T00:00:28.000Z"),
        totalComments: 2,
      });
      mockIssueService.listComments.mockResolvedValue([
        {
          id: "comment-Y",
          issueId: "11111111-1111-4111-8111-111111111111",
          authorType: "user",
          createdAt: new Date("2026-05-29T00:00:28.000Z"),
          body: "Yes, do option B (the answer the agent missed).",
        },
      ]);

      const res = await request(await installActor(createApp()))
        .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
        .set("If-Match", "comment-X")
        .send({ body: "Still waiting on the user's answer." });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe("stale_comment_cursor");
      expect(res.body.expected).toBe("comment-Y");
      expect(res.body.received).toBe("comment-X");
      expect(res.body.since.map((c: { id: string }) => c.id)).toEqual(["comment-Y"]);
      expect(mockIssueService.addComment).not.toHaveBeenCalled();
    });
  });

  describe("POST /issues/:id/interactions", () => {
    it("rejects a stale interaction create with 409", async () => {
      mockIssueService.getCommentCursor.mockResolvedValue({
        latestCommentId: "comment-newest",
        latestCommentAt: new Date(),
        totalComments: 1,
      });
      mockIssueService.listComments.mockResolvedValue([]);

      const res = await request(await installActor(createApp()))
        .post("/api/issues/11111111-1111-4111-8111-111111111111/interactions")
        .set("If-Match", "comment-old")
        .send({
          kind: "ask_user_questions",
          payload: {
            version: 1,
            questions: [
              {
                id: "q1",
                prompt: "Pick a color",
                selectionMode: "single",
                options: [
                  { id: "red", label: "Red" },
                  { id: "blue", label: "Blue" },
                ],
              },
            ],
          },
        });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe("stale_comment_cursor");
    });
  });
});
