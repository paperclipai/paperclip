import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(async () => ({
    id: "comment-default",
    issueId: "11111111-1111-4111-8111-111111111111",
    body: "",
    createdAt: new Date(),
    authorAgentId: null,
    authorUserId: null,
  })),
  findMentionedAgents: vi.fn(),
  findMentionedProjectIds: vi.fn(async () => []),
  getRelationSummaries: vi.fn(async () => ({ blockedBy: [], blocks: [] })),
  listWakeableBlockedDependents: vi.fn(async () => []),
  getWakeableParentAfterChildCompletion: vi.fn(async () => null),
  getWakeableParentForChildEvent: vi.fn(async () => null),
  getAncestors: vi.fn(async () => []),
}));

const mockIssueReferenceService = vi.hoisted(() => ({
  listIssueReferenceSummary: vi.fn(async () => ({ inbound: [], outbound: [] })),
  syncComment: vi.fn(async () => undefined),
  syncIssue: vi.fn(async () => undefined),
  diffIssueReferenceSummary: vi.fn(() => ({
    addedReferencedIssues: [],
    removedReferencedIssues: [],
    currentReferencedIssues: [],
  })),
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
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

const mockTelemetry = vi.hoisted(() => ({
  getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
  trackWakeEmissionFailure: vi.fn(),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual =
    await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
      "@paperclipai/shared/telemetry",
    );
  return {
    ...actual,
    trackWakeEmissionFailure: mockTelemetry.trackWakeEmissionFailure,
  };
});

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: mockTelemetry.getTelemetryClient,
  initTelemetry: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  documentService: () => ({}),
  environmentService: () => ({}),
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
  issueReferenceService: () => mockIssueReferenceService,
  issueService: () => mockIssueService,
  issueThreadInteractionService: () => ({
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
    listForIssue: vi.fn(async () => []),
  }),
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

const ISSUE_ID = "11111111-1111-4111-8111-111111111111";
const WORKER = "22222222-2222-4222-8222-222222222222";
const CREATOR = "44444444-4444-4444-8444-444444444444";
const MENTIONED = "33333333-3333-4333-8333-333333333333";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUE_ID,
    companyId: "company-1",
    status: "in_progress",
    assigneeAgentId: WORKER,
    assigneeUserId: null,
    createdByAgentId: CREATOR,
    createdByUserId: "local-board",
    identifier: "PAP-900",
    title: "mention/assignee wake test",
    ...overrides,
  };
}

async function flushMicrotasks() {
  // Wake-emission runs in a fire-and-forget IIFE; yield a few ticks so its
  // awaited work (findMentionedAgents + heartbeat.wakeup) completes before
  // we assert.
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("issue PATCH wake emission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: ISSUE_ID,
      companyId: "company-1",
      body: "",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: null,
      authorUserId: "local-board",
    });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
  });

  it("wakes the newly-assigned agent when applyStatusSideEffects auto-reassigns on in_review", async () => {
    // PATCH body only contains `status: in_review`; applyStatusSideEffects
    // rewrites assigneeAgentId server-side. The wake gate must notice this
    // via the pre/post delta, not the request body.
    mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: WORKER }));
    mockIssueService.update.mockImplementation(async (_id: string) =>
      makeIssue({ status: "in_review", assigneeAgentId: CREATOR }),
    );

    const res = await request(createApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    await flushMicrotasks();

    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      CREATOR,
      expect.objectContaining({ reason: "issue_assigned" }),
    );
  });

  it("does not emit an assignee wake when the assignee does not change", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: WORKER }));
    mockIssueService.update.mockImplementation(async (_id: string) =>
      makeIssue({ status: "blocked", assigneeAgentId: WORKER }),
    );

    const res = await request(createApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "blocked" });

    expect(res.status).toBe(200);
    await flushMicrotasks();

    const assignmentCalls = mockHeartbeatService.wakeup.mock.calls.filter(
      ([, payload]: any[]) => payload?.reason === "issue_assigned",
    );
    expect(assignmentCalls).toHaveLength(0);
  });

  it("wakes agents resolved from a plain-text @slug comment mention", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.update.mockImplementation(async (_id: string) => makeIssue());
    mockIssueService.findMentionedAgents.mockResolvedValue([MENTIONED]);

    const res = await request(createApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ comment: "please review @cto" });

    expect(res.status).toBe(200);
    await flushMicrotasks();

    expect(mockIssueService.findMentionedAgents).toHaveBeenCalledWith(
      "company-1",
      "please review @cto",
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      MENTIONED,
      expect.objectContaining({ reason: "issue_comment_mentioned" }),
    );
  });
});

describe("issue POST /issues/:id/comments wake emission telemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTelemetry.getTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-2",
      issueId: ISSUE_ID,
      companyId: "company-1",
      body: "",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: null,
      authorUserId: "local-board",
    });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockHeartbeatService.wakeup.mockImplementation(async () => undefined);
  });

  it("emits wake_emission.failed telemetry when findMentionedAgents rejects on comment create", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: null }));
    mockIssueService.findMentionedAgents.mockRejectedValue(new Error("resolver boom"));

    const res = await request(createApp())
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "heads up @cto" });

    expect(res.status).toBe(201);
    await flushMicrotasks();

    expect(mockTelemetry.trackWakeEmissionFailure).toHaveBeenCalledWith(
      expect.anything(),
      { reason: "mention_resolution_error", source: "issue.comment" },
    );
  });

  it("emits wake_emission.failed telemetry when heartbeat.wakeup rejects on comment create", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: WORKER }));
    mockHeartbeatService.wakeup.mockRejectedValue(new Error("wake boom"));

    const res = await request(createApp())
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "ping" });

    expect(res.status).toBe(201);
    await flushMicrotasks();

    expect(mockTelemetry.trackWakeEmissionFailure).toHaveBeenCalledWith(
      expect.anything(),
      { reason: "heartbeat_wakeup_error", source: "issue.comment" },
    );
  });

  it("does not emit wake_emission.failed telemetry when the comment wake path succeeds", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: WORKER }));
    mockIssueService.findMentionedAgents.mockResolvedValue([]);

    const res = await request(createApp())
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "no mentions" });

    expect(res.status).toBe(201);
    await flushMicrotasks();

    expect(mockTelemetry.trackWakeEmissionFailure).not.toHaveBeenCalled();
  });
});
