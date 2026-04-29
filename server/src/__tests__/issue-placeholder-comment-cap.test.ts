import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { register } from "../observability/prom.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  countOwnRecentPlaceholderComments: vi.fn(),
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
const mockDb = vi.hoisted(() => ({
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

function makeIssue() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    status: "todo",
    assigneeAgentId: "22222222-2222-4222-8222-222222222222",
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-580",
    title: "Placeholder comment cap",
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

function commentBody(body: string, agentId: string | null = "22222222-2222-4222-8222-222222222222") {
  return {
    id: "comment-1",
    issueId: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    body,
    createdAt: new Date(),
    updatedAt: new Date(),
    authorAgentId: agentId,
    authorUserId: agentId ? null : "local-board",
  };
}

function placeholderCount(count: number) {
  return { count, windowSeconds: 1800, windowComments: 5 };
}

async function postComment(actor: Record<string, unknown>, body: Record<string, unknown>) {
  return request(await installActor(createApp(), actor))
    .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
    .send(body);
}

async function metricText() {
  return register.metrics();
}

describe.sequential("issue placeholder comment cap route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    register.resetMetrics();
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue(),
      ...patch,
    }));
    mockIssueService.addComment.mockImplementation(async (_id: string, body: string, actor: { agentId?: string }) =>
      commentBody(body, actor.agentId ?? null),
    );
    mockIssueService.countOwnRecentPlaceholderComments.mockResolvedValue(placeholderCount(0));
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: "11111111-1111-4111-8111-111111111111",
      blockerIssueIds: [],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      allBlockersDone: true,
      isDependencyReady: true,
    });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockAccessService.canUser.mockResolvedValue(false);
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
    mockRoutineService.syncRunStatusForIssue.mockResolvedValue(undefined);
    mockIssueTreeControlService.getActivePauseHoldGate.mockResolvedValue(null);
  });

  it("allows agent non-placeholder comments", async () => {
    const res = await postComment(agentActor(), { body: "I found the failing route and am adding a focused test." });

    expect(res.status).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "I found the failing route and am adding a focused test.",
      expect.objectContaining({ agentId: "22222222-2222-4222-8222-222222222222" }),
    );
  });

  it("allows the first agent placeholder comment in the window", async () => {
    mockIssueService.countOwnRecentPlaceholderComments.mockResolvedValue(placeholderCount(0));

    const res = await postComment(agentActor(), { body: "Parked." });

    expect(res.status).toBe(201);
    expect(mockIssueService.countOwnRecentPlaceholderComments).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    );
    expect(mockIssueService.addComment).toHaveBeenCalled();
  });

  it("blocks the second agent placeholder comment in the window", async () => {
    mockIssueService.countOwnRecentPlaceholderComments.mockResolvedValue(placeholderCount(1));

    const res = await postComment(agentActor(), { body: "Parked." });

    expect(res.status).toBe(409);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.body).toEqual({
      error: "placeholder_comment_cap",
      message:
        "Comment blocked: prior placeholder comment(s) already posted in window. Flip status (blocked / done / in_review with a real comment) or exit silent instead.",
      windowSeconds: 1800,
      windowComments: 5,
      priorPlaceholderCount: 1,
      alternatives: [
        'PATCH /api/issues/{id} {"status":"blocked","unblockOwner":"..."}',
        'PATCH /api/issues/{id} {"status":"in_review","assigneeUserId":"local-board"}',
        "exit run silently -- no post",
      ],
    });
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("allows a placeholder when the service window has expired", async () => {
    mockIssueService.countOwnRecentPlaceholderComments.mockResolvedValue(placeholderCount(0));

    const res = await postComment(agentActor(), { body: "Idle." });

    expect(res.status).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalled();
  });

  it("does not count another agent's placeholders against the actor", async () => {
    mockIssueService.countOwnRecentPlaceholderComments.mockResolvedValue(placeholderCount(0));

    const res = await postComment(agentActor(), { body: "Noop." });

    expect(res.status).toBe(201);
    expect(mockIssueService.countOwnRecentPlaceholderComments).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    );
  });

  it("lets board users force a placeholder comment override and logs it", async () => {
    const res = await postComment(
      {
        type: "board",
        userId: "local-board",
        companyIds: ["company-1"],
        source: "local_implicit",
        isInstanceAdmin: false,
      },
      { body: "Parked.", forceCommentAllow: true },
    );

    expect(res.status).toBe(201);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.placeholder_cap_overridden",
        entityId: "11111111-1111-4111-8111-111111111111",
        details: expect.objectContaining({
          overriddenAgentId: "22222222-2222-4222-8222-222222222222",
          forceCommentAllow: true,
        }),
      }),
    );
    await expect(metricText()).resolves.toContain(
      'paperclip_placeholder_cap_overrides_total{agent_id="22222222-2222-4222-8222-222222222222"} 1',
    );
  });

  it("ignores agent supplied forceCommentAllow", async () => {
    mockIssueService.countOwnRecentPlaceholderComments.mockResolvedValue(placeholderCount(1));

    const res = await postComment(agentActor(), { body: "Parked.", forceCommentAllow: true });

    expect(res.status).toBe(409);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("increments the cap-hit metric and activity log when blocking", async () => {
    mockIssueService.countOwnRecentPlaceholderComments.mockResolvedValue(placeholderCount(1));

    const res = await postComment(agentActor(), { body: "Parked." });

    expect(res.status).toBe(409);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.placeholder_cap_hit",
        entityId: "11111111-1111-4111-8111-111111111111",
        details: expect.objectContaining({
          priorPlaceholderCount: 1,
          windowSeconds: 1800,
          windowComments: 5,
        }),
      }),
    );
    await expect(metricText()).resolves.toContain(
      'paperclip_placeholder_cap_hits_total{agent_id="22222222-2222-4222-8222-222222222222"} 1',
    );
  });
});
