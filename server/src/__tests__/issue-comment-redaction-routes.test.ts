import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getComment: vi.fn(),
  updateComment: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
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
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => mockFeedbackService,
    goalService: () => ({}),
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
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
  }));

  vi.doMock("../routes/authz.js", () => ({
    assertCompanyAccess: () => undefined,
    assertAgentIssueMutationAllowed: async () => true,
    actorCanAccessCompany: () => true,
  }));

  vi.doMock("../middleware/index.js", () => ({
    authenticate: (req: any, res: any, next: any) => {
      req.actor = { type: "user", userId: "local-board", companyId: "company-1" };
      next();
    },
  }));
}

async function createApp() {
  const { createIssuesRouter } = await import("../routes/issues.js");
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.actor = { type: "user", userId: "local-board", companyId: "company-1" };
    next();
  });
  const router = createIssuesRouter(vi.fn() as any, vi.fn() as any);
  app.use(router);
  return app;
}

async function installActor(app: express.Express) {
  return app;
}

function makeIssue() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    title: "Test issue",
    identifier: "TST-1",
    status: "in_progress",
  };
}

function makeComment(overrides = {}) {
  return {
    id: "comment-1",
    issueId: "11111111-1111-4111-8111-111111111111",
    authorUserId: "local-board",
    authorAgentId: null,
    authorType: "user",
    createdAt: new Date("2026-04-11T14:00:00.000Z"),
    updatedAt: new Date("2026-04-11T14:00:00.000Z"),
    body: "Original comment body",
    ...overrides,
  };
}

describe("PATCH /api/issues/:id/comments/:commentId (Redaction)", () => {
  beforeEach(async () => {
    vi.resetModules();
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.getComment.mockResolvedValue(makeComment());
    mockIssueService.updateComment.mockResolvedValue(makeComment({ body: "[redacted]" }));
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.hasPermission.mockResolvedValue(false);
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
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("allows comment author to redact their own comment", async () => {
    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111/comments/comment-1")
      .send({ body: "[redacted]" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "comment-1",
      body: "[redacted]",
    });
    expect(mockIssueService.updateComment).toHaveBeenCalledWith("comment-1", "[redacted]");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.comment_redacted",
        details: expect.objectContaining({
          commentId: "comment-1",
          originalAuthorUserId: "local-board",
          originalBodySnippet: "Original comment body",
        }),
      }),
    );
  });

  it("allows board user (admin) to redact any comment", async () => {
    const app = await createApp();
    // Override req.actor to be board user
    app.use((req, res, next) => {
      req.actor = { type: "board", userId: "admin-user", companyId: "company-1" };
      next();
    });

    mockIssueService.getComment.mockResolvedValue(
      makeComment({
        authorUserId: "someone-else",
      }),
    );

    const res = await request(app)
      .patch("/api/issues/11111111-1111-4111-8111-111111111111/comments/comment-1")
      .send({ body: "[redacted by admin]" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "comment-1",
      body: "[redacted]",
    });
    expect(mockIssueService.updateComment).toHaveBeenCalledWith("comment-1", "[redacted by admin]");
  });

  it("rejects non-author, non-admin redaction attempts", async () => {
    mockIssueService.getComment.mockResolvedValue(
      makeComment({
        authorUserId: "someone-else",
      }),
    );

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111/comments/comment-1")
      .send({ body: "[redacted]" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Only the comment author or a board user can redact comments");
    expect(mockIssueService.updateComment).not.toHaveBeenCalled();
  });

  it("rejects redaction with credential-like tokens", async () => {
    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111/comments/comment-1")
      .send({ body: "sk_live_51234567890" });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("credential_in_comment");
    expect(mockIssueService.updateComment).not.toHaveBeenCalled();
  });

  it("returns 404 when issue not found", async () => {
    mockIssueService.getById.mockResolvedValue(null);

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/nonexistent-id/comments/comment-1")
      .send({ body: "[redacted]" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Issue not found");
  });

  it("returns 404 when comment not found", async () => {
    mockIssueService.getComment.mockResolvedValue(null);

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111/comments/nonexistent-comment")
      .send({ body: "[redacted]" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Comment not found");
  });

  it("returns 404 when comment belongs to different issue", async () => {
    mockIssueService.getComment.mockResolvedValue(
      makeComment({
        issueId: "different-issue-id",
      }),
    );

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111/comments/comment-1")
      .send({ body: "[redacted]" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Comment not found");
  });

  it("works for both agent and user authors", async () => {
    const app = await createApp();
    app.use((req, res, next) => {
      req.actor = {
        type: "agent",
        agentId: "agent-uuid-1",
        companyId: "company-1",
      };
      next();
    });

    mockIssueService.getComment.mockResolvedValue(
      makeComment({
        authorAgentId: "agent-uuid-1",
        authorUserId: null,
      }),
    );

    const res = await request(app)
      .patch("/api/issues/11111111-1111-4111-8111-111111111111/comments/comment-1")
      .send({ body: "[redacted]" });

    expect(res.status).toBe(200);
    expect(mockIssueService.updateComment).toHaveBeenCalled();
  });
});
