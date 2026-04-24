import express from "express";
import { createServer } from "node:http";
import supertest from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const issueId = "11111111-1111-4111-8111-111111111111";
const closedWorkspaceId = "33333333-3333-4333-8333-333333333333";
const nextWorkspaceId = "44444444-4444-4444-8444-444444444444";
const agentId = "22222222-2222-4222-8222-222222222222";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  checkout: vi.fn(),
  addComment: vi.fn(),
}));

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockExecutionGateService = vi.hoisted(() => ({
  getExecutionBlock: vi.fn(),
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

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(async () => null),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

let issueRoutesFactory!: typeof import("../routes/issues.js").issueRoutes;
let errorHandlerMiddleware!: typeof import("../middleware/index.js").errorHandler;

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => ({
    getById: vi.fn(async () => null),
  }),
  documentService: () => ({}),
  executionGateService: () => mockExecutionGateService,
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => ({
    getDefaultCompanyGoal: vi.fn(async () => null),
    getById: vi.fn(async () => null),
  }),
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
  issueWorkflowService: () => ({
    decorateIssue: vi.fn(async (issue: unknown) => issue),
    evaluateLaneCompletion: vi.fn(async () => ({ canComplete: true, blockingReasons: [], artifactStatuses: [] })),
    applyTemplate: vi.fn(),
    advanceWorkflowDependents: vi.fn(async () => []),
    invalidateWorkflowDescendants: vi.fn(async () => ({ invalidatedSelf: null, invalidatedDescendants: [] })),
    handbackWorkflowLane: vi.fn(async () => null),
  }),
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
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
  app.use("/api", issueRoutesFactory({} as any, {} as any));
  app.use(errorHandlerMiddleware);
  return app;
}

function request(app: express.Express) {
  return supertest(createServer(app));
}

function resetMockObject(mockObject: Record<string, { mockReset: () => unknown }>) {
  for (const value of Object.values(mockObject)) {
    value.mockReset();
  }
}

function makeIssue() {
  return {
    id: issueId,
    companyId: "company-1",
    status: "todo",
    priority: "medium",
    assigneeAgentId: agentId,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-1085",
    title: "Closed worktree issue",
    projectId: null,
    executionRunId: null,
    checkoutRunId: null,
    executionWorkspaceId: closedWorkspaceId,
  };
}

function makeClosedWorkspace() {
  return {
    id: closedWorkspaceId,
    name: "PAP-1085-fix-worktree-guard",
    mode: "isolated_workspace",
    status: "archived",
    closedAt: new Date("2026-04-04T17:00:00.000Z"),
  };
}

describe.sequential("closed isolated workspace issue routes", () => {
  beforeEach(async () => {
    vi.resetModules();
    resetMockObject(mockIssueService);
    resetMockObject(mockExecutionWorkspaceService);
    resetMockObject(mockExecutionGateService);
    resetMockObject(mockAccessService);
    resetMockObject(mockHeartbeatService);
    resetMockObject(mockProjectService);
    mockLogActivity.mockReset();
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockExecutionWorkspaceService.getById.mockResolvedValue(makeClosedWorkspace());
    mockExecutionGateService.getExecutionBlock.mockResolvedValue(null);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockHeartbeatService.reportRunActivity.mockResolvedValue(undefined);
    mockHeartbeatService.getRun.mockResolvedValue(null);
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue(null);
    mockHeartbeatService.cancelRun.mockResolvedValue(null);
    mockProjectService.getById.mockResolvedValue(null);
    mockLogActivity.mockResolvedValue(undefined);
    ({ issueRoutes: issueRoutesFactory } = await import("../routes/issues.js"));
    ({ errorHandler: errorHandlerMiddleware } = await import("../middleware/index.js"));
  });

  it.sequential("rejects new issue comments when the linked isolated workspace is closed", async () => {
    const res = await request(createApp())
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "hello" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("closed workspace");
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it.sequential("rejects comment updates when the linked isolated workspace is closed", async () => {
    const res = await request(createApp())
      .patch(`/api/issues/${issueId}`)
      .send({ comment: "hello" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("closed workspace");
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it.sequential("rejects checkout when the linked isolated workspace is closed", async () => {
    const res = await request(createApp())
      .post(`/api/issues/${issueId}/checkout`)
      .send({
        agentId,
        expectedStatuses: ["todo", "backlog", "blocked"],
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("closed workspace");
    expect(mockIssueService.checkout).not.toHaveBeenCalled();
  });

  it.sequential("still allows non-comment board updates so the issue can be moved to a new workspace", async () => {
    mockIssueService.update.mockResolvedValue({
      ...makeIssue(),
      executionWorkspaceId: nextWorkspaceId,
    });

    const res = await request(createApp())
      .patch(`/api/issues/${issueId}`)
      .send({ executionWorkspaceId: nextWorkspaceId });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      issueId,
      expect.objectContaining({ executionWorkspaceId: nextWorkspaceId }),
    );
  });
});
