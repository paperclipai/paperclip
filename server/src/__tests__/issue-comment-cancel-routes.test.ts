import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  getComment: vi.fn(),
  removeComment: vi.fn(),
  tombstoneComment: vi.fn(),
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
const mockDocumentAnnotationService = vi.hoisted(() => ({
  cleanupForIssueCommentDeletion: vi.fn(async () => ({ deletedCommentIds: [], resolvedThreadIds: [] })),
  remapOpenThreadsForDocument: vi.fn(async () => []),
}));
const mockIssueReferenceService = vi.hoisted(() => ({
  deleteCommentSource: vi.fn(async () => undefined),
  deleteDocumentSource: vi.fn(async () => undefined),
  diffIssueReferenceSummary: vi.fn(() => ({
    addedReferencedIssues: [],
    removedReferencedIssues: [],
    currentReferencedIssues: [],
  })),
  emptySummary: vi.fn(() => ({ outbound: [], inbound: [] })),
  listIssueReferenceSummary: vi.fn(async () => ({ outbound: [], inbound: [] })),
  syncComment: vi.fn(async () => undefined),
  syncDocument: vi.fn(async () => undefined),
  syncIssue: vi.fn(async () => undefined),
}));
const mockExternalObjectService = vi.hoisted(() => ({
  getIssueSummaries: vi.fn(async () => ({ summaries: {} })),
  getIssueSummary: vi.fn(async () => ({
    authRequiredCount: 0,
    byLiveness: {},
    byStatusCategory: {},
    highestSeverity: "muted",
    objects: [],
    staleCount: 0,
    total: 0,
    unreachableCount: 0,
  })),
  listForIssue: vi.fn(async () => []),
  refreshIssueObjects: vi.fn(async () => []),
  syncCommentSafely: vi.fn(async () => undefined),
  syncDocumentSafely: vi.fn(async () => undefined),
  syncIssueSafely: vi.fn(async () => undefined),
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

  vi.doMock("../services/external-objects.js", () => ({
    externalObjectService: () => mockExternalObjectService,
  }));

  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    accessService: () => mockAccessService,
    agentService: () => ({ getById: vi.fn(async () => null) }),
    documentAnnotationService: () => mockDocumentAnnotationService,
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
    issueReferenceService: () => mockIssueReferenceService,
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
    vi.doUnmock("../services/external-objects.js");
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
    mockIssueService.tombstoneComment.mockImplementation(async (_commentId, _actor, options) => {
      const deleted = makeComment({
        body: "",
        metadata: null,
        deletedAt: new Date("2026-04-11T15:05:00.000Z"),
        deletedByType: "user",
        deletedByAgentId: null,
        deletedByUserId: "local-board",
        deletedByRunId: null,
      });
      await options?.afterTombstone?.(deleted, "tx");
      return deleted;
    });
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
    mockDocumentAnnotationService.cleanupForIssueCommentDeletion.mockResolvedValue({
      deletedCommentIds: [],
      resolvedThreadIds: [],
    });
    mockIssueReferenceService.deleteCommentSource.mockResolvedValue(undefined);
    mockIssueReferenceService.syncComment.mockResolvedValue(undefined);
    mockExternalObjectService.syncCommentSafely.mockResolvedValue(undefined);
  });

  it("cancels a queued comment from its author and restores the deleted body", async () => {
    const res = await request(await installActor(createApp()))
      .delete("/api/issues/11111111-1111-4111-8111-111111111111/comments/comment-1?mode=cancel");

    expect(res.status, JSON.stringify({
      body: res.body,
      tombstoneCalls: mockIssueService.tombstoneComment.mock.calls,
      activityCalls: mockLogActivity.mock.calls,
    })).toBe(200);
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

  it("rejects stale queued cancellation after the active run is gone", async () => {
    mockHeartbeatService.getRun.mockResolvedValue(null);

    const res = await request(await installActor(createApp()))
      .delete("/api/issues/11111111-1111-4111-8111-111111111111/comments/comment-1?mode=cancel");

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Queued comment can no longer be canceled");
    expect(mockIssueService.removeComment).not.toHaveBeenCalled();
    expect(mockIssueService.tombstoneComment).not.toHaveBeenCalled();
  });

  it("rejects canceling comments that are no longer queued", async () => {
    mockIssueService.getComment.mockResolvedValue(
      makeComment({
        createdAt: new Date("2026-04-11T14:58:00.000Z"),
        updatedAt: new Date("2026-04-11T14:58:00.000Z"),
      }),
    );

    const res = await request(await installActor(createApp()))
      .delete("/api/issues/11111111-1111-4111-8111-111111111111/comments/comment-1?mode=cancel");

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Only queued comments can be canceled");
    expect(mockIssueService.removeComment).not.toHaveBeenCalled();
    expect(mockIssueService.tombstoneComment).not.toHaveBeenCalled();
  });

  it("rejects canceling another actor's queued comment", async () => {
    mockIssueService.getComment.mockResolvedValue(
      makeComment({
        authorUserId: "someone-else",
      }),
    );

    const res = await request(await installActor(createApp()))
      .delete("/api/issues/11111111-1111-4111-8111-111111111111/comments/comment-1?mode=cancel");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Only the comment author can cancel queued comments");
    expect(mockIssueService.removeComment).not.toHaveBeenCalled();
  });

  it("deletes a normal authored comment as a tombstone without returning the original body", async () => {
    mockIssueService.getComment.mockResolvedValue(
      makeComment({
        body: "Sensitive original comment body",
        metadata: { version: 1, sections: [{ rows: [{ type: "text", text: "Sensitive metadata copy" }] }] },
        createdAt: new Date("2026-04-11T14:58:00.000Z"),
        updatedAt: new Date("2026-04-11T14:58:00.000Z"),
      }),
    );
    mockDocumentAnnotationService.cleanupForIssueCommentDeletion.mockResolvedValue({
      deletedCommentIds: ["annotation-comment-1"],
      resolvedThreadIds: ["annotation-thread-1"],
    });

    const res = await request(await installActor(createApp()))
      .delete("/api/issues/11111111-1111-4111-8111-111111111111/comments/comment-1");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      id: "comment-1",
      body: "",
      metadata: null,
      deletedByType: "user",
      deletedByUserId: "local-board",
    });
    expect(JSON.stringify(res.body)).not.toContain("Sensitive original comment body");
    expect(JSON.stringify(res.body)).not.toContain("Sensitive metadata copy");
    expect(mockIssueService.removeComment).not.toHaveBeenCalled();
    expect(mockIssueService.tombstoneComment).toHaveBeenCalledWith(
      "comment-1",
      {
        actorType: "user",
        agentId: null,
        userId: "local-board",
        runId: null,
      },
      expect.objectContaining({ afterTombstone: expect.any(Function) }),
    );
    expect(mockIssueReferenceService.syncComment).toHaveBeenCalledWith("comment-1", "tx");
    expect(mockExternalObjectService.syncCommentSafely).toHaveBeenCalledWith("comment-1", "tx");
    expect(mockDocumentAnnotationService.cleanupForIssueCommentDeletion).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "comment-1",
      expect.objectContaining({
        actorType: "user",
        userId: "local-board",
      }),
      "tx",
    );
    expect(mockIssueReferenceService.deleteCommentSource).toHaveBeenCalledWith("annotation-comment-1", "tx");
    expect(mockExternalObjectService.syncCommentSafely).toHaveBeenCalledWith("annotation-comment-1", "tx");
    const deletedActivity = mockLogActivity.mock.calls.find((call) => call[1]?.action === "issue.comment_deleted")?.[1];
    expect(deletedActivity).toEqual(expect.objectContaining({
      action: "issue.comment_deleted",
      details: expect.objectContaining({
        deletedAnnotationCommentIds: ["annotation-comment-1"],
        resolvedAnnotationThreadIds: ["annotation-thread-1"],
      }),
    }));
    expect(deletedActivity?.details).toEqual(expect.not.objectContaining({
      bodySnippet: expect.anything(),
    }));
    expect(JSON.stringify(deletedActivity?.details ?? {})).not.toContain("Sensitive original comment body");
    expect(JSON.stringify(deletedActivity?.details ?? {})).not.toContain("Sensitive metadata copy");
  });

  it("rejects deleting another actor's normal comment", async () => {
    mockIssueService.getComment.mockResolvedValue(
      makeComment({
        authorUserId: "someone-else",
        createdAt: new Date("2026-04-11T14:58:00.000Z"),
        updatedAt: new Date("2026-04-11T14:58:00.000Z"),
      }),
    );

    const res = await request(await installActor(createApp()))
      .delete("/api/issues/11111111-1111-4111-8111-111111111111/comments/comment-1");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Only the comment author can delete comments");
    expect(mockIssueService.removeComment).not.toHaveBeenCalled();
    expect(mockIssueService.tombstoneComment).not.toHaveBeenCalled();
  });
});
