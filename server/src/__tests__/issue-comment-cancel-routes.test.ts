import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  getComment: vi.fn(),
  removeComment: vi.fn(),
  containSensitiveComment: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
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
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));

function registerModuleMocks() {
  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentTaskCompleted: vi.fn(),
    trackErrorHandlerCrash: vi.fn(),
  }));

  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
  }));

  vi.doMock("../services/access.js", () => ({
    accessService: () => mockAccessService,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/feedback.js", () => ({
    feedbackService: () => mockFeedbackService,
  }));

  vi.doMock("../services/heartbeat.js", () => ({
    heartbeatService: () => mockHeartbeatService,
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));

  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));

  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    accessService: () => mockAccessService,
    agentService: () => ({ getById: vi.fn(async () => null) }),
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => mockFeedbackService,
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    instanceSettingsService: () => mockInstanceSettingsService,
    issueApprovalService: () => ({}),
    issueRecoveryActionService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      listActiveForIssues: vi.fn(async () => new Map()),
    }),
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
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
    workProductService: () => ({}),
  }));
}

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
  app.use("/api", issueRoutes({} as any, {} as any));
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
    executionRunId: "run-1",
    identifier: "PAP-1353",
    title: "Queued cancel",
  };
}

function makeComment(overrides: Record<string, unknown> = {}) {
  return {
    id: "comment-1",
    companyId: "company-1",
    issueId: "11111111-1111-4111-8111-111111111111",
    authorAgentId: null,
    authorUserId: "local-board",
    body: "Queued follow-up",
    createdAt: new Date("2026-04-11T15:01:00.000Z"),
    updatedAt: new Date("2026-04-11T15:01:00.000Z"),
    ...overrides,
  };
}

describe.sequential("issue comment cancel routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/feedback.js");
    vi.doUnmock("../services/heartbeat.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/instance-settings.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.getComment.mockResolvedValue(makeComment());
    mockIssueService.removeComment.mockResolvedValue(makeComment());
    mockIssueService.containSensitiveComment.mockResolvedValue(
      makeComment({
        body: "[Security redaction: this published comment was quarantined by a board administrator. See activity log for containment metadata.]",
        updatedAt: new Date("2026-04-11T15:05:00.000Z"),
      }),
    );
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockFeedbackService.listIssueVotesForUser.mockResolvedValue([]);
    mockFeedbackService.saveIssueVote.mockResolvedValue({
      vote: null,
      consentEnabledNow: false,
      sharingEnabled: false,
    });
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "running",
      startedAt: new Date("2026-04-11T15:00:00.000Z"),
      createdAt: new Date("2026-04-11T14:59:00.000Z"),
    });
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue(null);
    mockInstanceSettingsService.get.mockResolvedValue({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    });
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1"]);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("cancels a queued comment from its author and restores the deleted body", async () => {
    const res = await request(await installActor(createApp()))
      .delete("/api/issues/11111111-1111-4111-8111-111111111111/comments/comment-1");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "comment-1",
      body: "Queued follow-up",
    });
    expect(mockIssueService.removeComment).toHaveBeenCalledWith("comment-1");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.comment_cancelled",
        details: expect.objectContaining({
          commentId: "comment-1",
          source: "queue_cancel",
          queueTargetRunId: "run-1",
        }),
      }),
    );
  });

  it("rejects canceling comments that are no longer queued", async () => {
    mockIssueService.getComment.mockResolvedValue(
      makeComment({
        createdAt: new Date("2026-04-11T14:58:00.000Z"),
        updatedAt: new Date("2026-04-11T14:58:00.000Z"),
      }),
    );

    const res = await request(await installActor(createApp()))
      .delete("/api/issues/11111111-1111-4111-8111-111111111111/comments/comment-1");

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Only queued comments can be canceled");
    expect(mockIssueService.removeComment).not.toHaveBeenCalled();
  });

  it("rejects canceling another actor's queued comment", async () => {
    mockIssueService.getComment.mockResolvedValue(
      makeComment({
        authorUserId: "someone-else",
      }),
    );

    const res = await request(await installActor(createApp()))
      .delete("/api/issues/11111111-1111-4111-8111-111111111111/comments/comment-1");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Only the comment author can cancel queued comments");
    expect(mockIssueService.removeComment).not.toHaveBeenCalled();
  });

  it("contains a published sensitive comment for a board actor and logs audit evidence without original body", async () => {
    mockIssueService.getComment.mockResolvedValue(
      makeComment({
        body: "original placeholder sensitive material",
        createdAt: new Date("2026-04-11T14:58:00.000Z"),
        updatedAt: new Date("2026-04-11T14:58:00.000Z"),
      }),
    );

    const res = await request(await installActor(createApp()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments/comment-1/admin/contain-sensitive")
      .send({ reason: "Operator containment after confirmed credential exposure" });

    expect(res.status).toBe(200);
    expect(mockIssueService.containSensitiveComment).toHaveBeenCalledWith("comment-1", {
      body: "[Security redaction: this published comment was quarantined by a board administrator. See activity log for containment metadata.]",
    });
    expect(res.body.body).toBe(
      "[Security redaction: this published comment was quarantined by a board administrator. See activity log for containment metadata.]",
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.comment_sensitive_contained",
        entityType: "issue_comment",
        entityId: "comment-1",
        details: expect.objectContaining({
          commentId: "comment-1",
          issueId: "11111111-1111-4111-8111-111111111111",
          actorUserId: "local-board",
          containmentReason: "Operator containment after confirmed credential exposure",
          containedAt: "2026-04-11T15:05:00.000Z",
        }),
      }),
    );
    const activityDetails = mockLogActivity.mock.calls.at(-1)?.[1]?.details;
    expect(JSON.stringify(activityDetails)).not.toContain("original placeholder sensitive material");
  });

  it("rejects sensitive published comment containment for non-board actors", async () => {
    const res = await request(await installActor(createApp(), {
      type: "agent",
      agentId: "22222222-2222-4222-8222-222222222222",
      companyId: "company-1",
      runId: "33333333-3333-4333-8333-333333333333",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments/comment-1/admin/contain-sensitive")
      .send({ reason: "Operator containment after confirmed credential exposure" });

    expect(res.status).toBe(403);
    expect(mockIssueService.containSensitiveComment).not.toHaveBeenCalled();
  });

  it("routes queued comments to cancellation instead of admin containment", async () => {
    const res = await request(await installActor(createApp()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments/comment-1/admin/contain-sensitive")
      .send({ reason: "Operator containment after confirmed credential exposure" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Queued comments must use the cancellation route");
    expect(mockIssueService.containSensitiveComment).not.toHaveBeenCalled();
  });
});
