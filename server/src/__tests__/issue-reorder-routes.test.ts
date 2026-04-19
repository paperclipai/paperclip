import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const issueId = "11111111-1111-4111-8111-111111111111";
const beforeIssueId = "22222222-2222-4222-8222-222222222222";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  reorder: vi.fn(),
}));

const mockHeartbeatWakeup = vi.hoisted(() => vi.fn(async () => undefined));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(async () => true),
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => ({
    getById: vi.fn(async () => null),
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
    wakeup: mockHeartbeatWakeup,
    reportRunActivity: vi.fn(async () => undefined),
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

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId: "company-1",
    status: "todo",
    boardPosition: 1,
    assigneeAgentId: null,
    assigneeUserId: null,
    identifier: "PAP-11",
    title: "Reorder route issue",
    executionWorkspaceId: null,
    ...overrides,
  };
}

function createApp(actor: Record<string, unknown> = {
  type: "board",
  userId: "local-board",
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue reorder routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(makeIssue({
      status: "backlog",
      boardPosition: 0,
      assigneeAgentId: "agent-1",
    }));
    mockIssueService.reorder.mockResolvedValue(makeIssue({
      status: "todo",
      boardPosition: 1,
      assigneeAgentId: "agent-1",
    }));
  });

  it("reorders an issue, logs activity, and wakes assigned backlog work", async () => {
    const res = await request(createApp())
      .post(`/api/issues/${issueId}/reorder`)
      .send({ status: "todo", beforeIssueId });

    expect(res.status).toBe(200);
    expect(mockIssueService.reorder).toHaveBeenCalledWith(issueId, {
      status: "todo",
      beforeIssueId,
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.reordered",
        entityId: issueId,
        details: expect.objectContaining({
          status: "todo",
          boardPosition: 1,
          beforeIssueId,
          _previous: {
            status: "backlog",
            boardPosition: 0,
          },
        }),
      }),
    );
    expect(mockHeartbeatWakeup).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        reason: "issue_status_changed",
        payload: { issueId, mutation: "reorder" },
      }),
    );
  });

  it("requires board access", async () => {
    const res = await request(createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
    }))
      .post(`/api/issues/${issueId}/reorder`)
      .send({ status: "todo", beforeIssueId: null });

    expect(res.status).toBe(403);
    expect(mockIssueService.reorder).not.toHaveBeenCalled();
  });
});
