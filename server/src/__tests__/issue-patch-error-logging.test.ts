import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const mockIssuePatchLogger = vi.hoisted(() => ({
  error: vi.fn(),
}));

const mockLogger = vi.hoisted(() => ({
  child: vi.fn(() => mockIssuePatchLogger),
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../middleware/logger.js", () => ({
  logger: mockLogger,
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  documentService: () => ({}),
  executionWorkspaceService: () => ({
    getById: vi.fn(async () => null),
  }),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => ({}),
  heartbeatService: () => ({
    wakeup: vi.fn(async () => undefined),
    reportRunActivity: vi.fn(async () => undefined),
    cancelNonActionableIssueAssignmentWork: vi.fn(async () => 0),
    getRun: vi.fn(async () => null),
    getActiveRunForAgent: vi.fn(async () => null),
    cancelRun: vi.fn(async () => null),
  }),
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
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

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

function makeIssue() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    status: "todo",
    assigneeAgentId: "22222222-2222-4222-8222-222222222222",
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-580",
    title: "Patch error logging",
    labels: [],
  };
}

describe("issue patch error logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(makeIssue());
  });

  it("logs structured context for unexpected PATCH failures", async () => {
    const boom = new Error("boom");
    mockIssueService.update.mockRejectedValue(boom);

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "in_review" });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
    expect(mockLogger.child).toHaveBeenCalledWith({
      route: "PATCH /api/issues/:id",
      issueId: "11111111-1111-4111-8111-111111111111",
      issueIdentifier: "PAP-580",
      companyId: "company-1",
      actorType: "user",
      actorId: "local-board",
      actorAgentId: null,
      runId: null,
    });
    expect(mockIssuePatchLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: boom,
        assigneePatch: {
          assigneeAgentId: "__omitted__",
          assigneeUserId: "__omitted__",
        },
        currentAssignee: {
          assigneeAgentId: "22222222-2222-4222-8222-222222222222",
          assigneeUserId: null,
        },
        requestedStatus: "in_review",
        reopenRequested: false,
        interruptRequested: false,
        hasComment: false,
      }),
      "unexpected PATCH /api/issues/:id failure",
    );
  });
});
