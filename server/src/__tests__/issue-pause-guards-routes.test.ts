import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const issueId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockExecutionGateService = vi.hoisted(() => ({
  getExecutionBlock: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(async () => ({ id: agentId, companyId: "company-1", role: "engineer", name: "Agent" })),
    list: vi.fn(async () => []),
  }),
  documentService: () => ({}),
  executionGateService: () => mockExecutionGateService,
  executionWorkspaceService: () => ({
    getById: vi.fn(async () => null),
  }),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => ({
    getDefaultCompanyGoal: vi.fn(async () => null),
    getById: vi.fn(async () => null),
  }),
  heartbeatService: () => ({
    wakeup: vi.fn(async () => undefined),
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
  issueApprovalService: () => ({
    link: vi.fn(async () => undefined),
    unlink: vi.fn(async () => undefined),
    listApprovalsForIssue: vi.fn(async () => []),
  }),
  issueService: () => mockIssueService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => mockProjectService,
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({
    getById: vi.fn(async () => null),
    createForIssue: vi.fn(async () => null),
    update: vi.fn(async () => null),
    remove: vi.fn(async () => null),
    listForIssue: vi.fn(async () => []),
  }),
}));

function createApp(actorType: "board" | "agent") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actorType === "agent"
      ? {
          type: "agent",
          agentId,
          companyId: "company-1",
          runId: "run-1",
        }
      : {
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
    id: issueId,
    companyId: "company-1",
    status: "in_progress",
    priority: "medium",
    assigneeAgentId: agentId,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-1085",
    title: "Paused issue",
    projectId: "project-1",
    executionRunId: "run-1",
    checkoutRunId: "run-1",
    executionWorkspaceId: null,
  };
}

describe("issue pause guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.assertCheckoutOwner.mockResolvedValue({
      id: issueId,
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: "run-1",
      adoptedFromRunId: null,
    });
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId,
      companyId: "company-1",
      body: "hello",
      authorAgentId: agentId,
      authorUserId: null,
      createdAt: new Date("2026-04-13T12:00:00.000Z"),
      updatedAt: new Date("2026-04-13T12:00:00.000Z"),
    });
    mockProjectService.getById.mockResolvedValue({
      id: "project-1",
      companyId: "company-1",
      pauseReason: "manual",
      pausedAt: new Date("2026-04-13T12:00:00.000Z"),
    });
  });

  it("blocks agent comments when execution is paused for the issue project", async () => {
    mockExecutionGateService.getExecutionBlock.mockResolvedValue({
      code: "project_paused_manual",
      scopeType: "project",
      scopeId: "project-1",
      scopeName: "Paused Project",
      message: "Project is paused and cannot start new work.",
      skipReason: "project.paused",
    });

    const res = await request(createApp("agent"))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "still working" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("Project is paused");
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("still allows board comments during a paused project", async () => {
    mockExecutionGateService.getExecutionBlock.mockResolvedValue({
      code: "project_paused_manual",
      scopeType: "project",
      scopeId: "project-1",
      scopeName: "Paused Project",
      message: "Project is paused and cannot start new work.",
      skipReason: "project.paused",
    });

    const res = await request(createApp("board"))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "operator note" });

    expect(res.status).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalled();
  });
});
