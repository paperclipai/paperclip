import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockWakeup = vi.hoisted(() => vi.fn(async () => undefined));
const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));
const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));
const mockDocumentService = vi.hoisted(() => ({
  getIssueDocumentPayload: vi.fn(async () => ({})),
}));
const mockIssueService = vi.hoisted(() => ({
  getAncestors: vi.fn(),
  getById: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
  getComment: vi.fn(),
  getCommentCursor: vi.fn(),
  getRelationSummaries: vi.fn(),
  update: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  findMentionedAgents: vi.fn(async () => []),
}));

const mockExecutionGateService = vi.hoisted(() => ({
  getExecutionBlock: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: mockWakeup,
  reportRunActivity: vi.fn(async () => undefined),
}));
const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(),
  listCompanyIds: vi.fn(),
}));
const mockIssueWorkflowService = vi.hoisted(() => ({
  decorateIssue: vi.fn(async (issue: unknown) => issue),
  evaluateLaneCompletion: vi.fn(async () => ({ canComplete: true, blockingReasons: [], artifactStatuses: [] })),
  applyTemplate: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  documentService: () => mockDocumentService,
  executionGateService: () => mockExecutionGateService,
  executionWorkspaceService: () => ({
    getById: vi.fn(),
  }),
  feedbackService: () => ({}),
  goalService: () => ({
    getById: vi.fn(),
    getDefaultCompanyGoal: vi.fn(),
  }),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => mockInstanceSettingsService,
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  issueWorkflowService: () => mockIssueWorkflowService,
  logActivity: mockLogActivity,
  projectService: () => ({
    getById: vi.fn(),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
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
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err?.status ?? 500).json({ error: err?.message ?? "Internal server error" });
  });
  return app;
}

let issueRoutesFactory: typeof import("../routes/issues.js").issueRoutes;

describe("issue dependency wakeups in issue routes", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ issueRoutes: issueRoutesFactory } = await import("../routes/issues.js"));
    vi.clearAllMocks();
    mockAccessService.canUser.mockReset();
    mockAccessService.hasPermission.mockReset();
    mockAgentService.getById.mockReset();
    mockDocumentService.getIssueDocumentPayload.mockReset();
    mockExecutionGateService.getExecutionBlock.mockReset();
    mockHeartbeatService.reportRunActivity.mockReset();
    mockInstanceSettingsService.get.mockReset();
    mockInstanceSettingsService.listCompanyIds.mockReset();
    mockIssueWorkflowService.decorateIssue.mockReset();
    mockIssueWorkflowService.evaluateLaneCompletion.mockReset();
    mockIssueWorkflowService.applyTemplate.mockReset();
    mockLogActivity.mockReset();
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.getComment.mockResolvedValue(null);
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAgentService.getById.mockImplementation(async (id: string) => ({
      id,
      companyId: "company-1",
      role: "pm",
      name: "Operator",
    }));
    mockDocumentService.getIssueDocumentPayload.mockResolvedValue({});
    mockExecutionGateService.getExecutionBlock.mockResolvedValue(null);
    mockHeartbeatService.reportRunActivity.mockResolvedValue(undefined);
    mockInstanceSettingsService.get.mockResolvedValue(undefined);
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue([]);
    mockIssueWorkflowService.decorateIssue.mockImplementation(async (issue: unknown) => issue);
    mockIssueWorkflowService.evaluateLaneCompletion.mockResolvedValue({
      canComplete: true,
      blockingReasons: [],
      artifactStatuses: [],
    });
    mockIssueWorkflowService.applyTemplate.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
  }, 60_000);

  it("wakes dependents when the final blocker transitions to done", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-100",
      title: "Finish blocker",
      description: null,
      status: "blocked",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.update.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-100",
      title: "Finish blocker",
      description: null,
      status: "done",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([
      {
        id: "issue-2",
        assigneeAgentId: "agent-2",
        blockerIssueIds: ["issue-1", "issue-3"],
      },
    ]);

    const res = await request(createApp()).patch("/api/issues/issue-1").send({ status: "done" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(res.status).toBe(200);
    expect(mockWakeup).toHaveBeenCalledWith(
      "agent-2",
      expect.objectContaining({
        reason: "issue_blockers_resolved",
        payload: expect.objectContaining({
          issueId: "issue-2",
          resolvedBlockerIssueId: "issue-1",
        }),
      }),
    );
  });

  it("wakes dependents when the final blocker transitions to cancelled", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-100",
      title: "Cancel blocker",
      description: null,
      status: "blocked",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.update.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-100",
      title: "Cancel blocker",
      description: null,
      status: "cancelled",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([
      {
        id: "issue-2",
        assigneeAgentId: "agent-2",
        blockerIssueIds: ["issue-1", "issue-3"],
      },
    ]);

    const res = await request(createApp()).patch("/api/issues/issue-1").send({ status: "cancelled" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(res.status).toBe(200);
    expect(mockWakeup).toHaveBeenCalledWith(
      "agent-2",
      expect.objectContaining({
        reason: "issue_blockers_resolved",
        payload: expect.objectContaining({
          issueId: "issue-2",
          resolvedBlockerIssueId: "issue-1",
        }),
      }),
    );
  });

  it("wakes the parent when all direct children become terminal", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "child-1",
      companyId: "company-1",
      identifier: "PAP-101",
      title: "Last child",
      description: null,
      status: "in_progress",
      priority: "medium",
      parentId: "parent-1",
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.update.mockResolvedValue({
      id: "child-1",
      companyId: "company-1",
      identifier: "PAP-101",
      title: "Last child",
      description: null,
      status: "done",
      priority: "medium",
      parentId: "parent-1",
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue({
      id: "parent-1",
      assigneeAgentId: "agent-9",
      childIssueIds: ["child-0", "child-1"],
    });

    const res = await request(createApp()).patch("/api/issues/child-1").send({ status: "done" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(res.status).toBe(200);
    expect(mockWakeup).toHaveBeenCalledWith(
      "agent-9",
      expect.objectContaining({
        reason: "issue_children_completed",
        payload: expect.objectContaining({
          issueId: "parent-1",
          completedChildIssueId: "child-1",
        }),
      }),
    );
  });
});
