import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  getComment: vi.fn(),
  removeComment: vi.fn(),
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

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentTaskCompleted: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => ({ getById: vi.fn(async () => null) }),
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
    listCompanyIds: vi.fn(async () => ["company-1"]),
  }),
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
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

describe("issue comment cancel routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.getComment.mockResolvedValue(makeComment());
    mockIssueService.removeComment.mockResolvedValue(makeComment());
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "running",
      startedAt: new Date("2026-04-11T15:00:00.000Z"),
      createdAt: new Date("2026-04-11T14:59:00.000Z"),
    });
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue(null);
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
});
