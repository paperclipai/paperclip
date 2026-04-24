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
  advanceWorkflowDependents: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

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

vi.mock("../middleware/logger.js", () => ({
  logger: mockLogger,
  httpLogger: {},
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

describe.sequential("issue dependency wakeups in issue routes", () => {
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
    mockIssueWorkflowService.advanceWorkflowDependents.mockReset();
    mockLogActivity.mockReset();
    mockLogger.debug.mockReset();
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();
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
    mockIssueWorkflowService.advanceWorkflowDependents.mockResolvedValue([]);
    mockLogActivity.mockResolvedValue(undefined);
  }, 60_000);

  it.sequential("wakes dependents when the final blocker transitions to done", async () => {
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

  it.sequential("wakes dependents when the final blocker transitions to cancelled", async () => {
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

  it.sequential("wakes the parent when all direct children become terminal", async () => {
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

  it.sequential("promotes workflow dependents before waking them when a workflow lane becomes terminal", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-110",
      title: "Finish PM lane",
      description: null,
      status: "in_progress",
      priority: "medium",
      parentId: "root-1",
      assigneeAgentId: "agent-pm",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      workflowTemplateKey: "engineering_delivery_v1",
      workflowLaneRole: "pm",
      labels: [],
      labelIds: [],
    });
    mockIssueService.update.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-110",
      title: "Finish PM lane",
      description: null,
      status: "done",
      priority: "medium",
      parentId: "root-1",
      assigneeAgentId: "agent-pm",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      workflowTemplateKey: "engineering_delivery_v1",
      workflowLaneRole: "pm",
      labels: [],
      labelIds: [],
    });
    mockIssueWorkflowService.advanceWorkflowDependents.mockResolvedValue([
      {
        id: "issue-2",
        companyId: "company-1",
        identifier: "PAP-111",
        title: "Design lane",
        description: null,
        status: "todo",
        priority: "medium",
        parentId: "root-1",
        assigneeAgentId: "agent-designer",
        assigneeUserId: null,
        blockedByIssueIds: ["issue-1"],
        labels: [],
        labelIds: [],
      },
    ]);
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([
      {
        id: "issue-2",
        assigneeAgentId: "agent-designer",
        blockerIssueIds: ["issue-1"],
      },
    ]);

    const res = await request(createApp()).patch("/api/issues/issue-1").send({ status: "done" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(res.status).toBe(200);
    expect(mockIssueWorkflowService.advanceWorkflowDependents).toHaveBeenCalledWith("issue-1");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.workflow_lane_unblocked",
        entityType: "issue",
        entityId: "issue-2",
        details: expect.objectContaining({
          parentId: "root-1",
          resolvedBlockerIssueId: "issue-1",
          blockerIssueIds: ["issue-1"],
        }),
      }),
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        opsEvent: true,
        event: "workflow.lane.unblocked",
        companyId: "company-1",
        issueId: "issue-2",
        rootIssueId: "root-1",
        resolvedBlockerIssueId: "issue-1",
        blockerIssueIds: ["issue-1"],
      }),
      "workflow.lane.unblocked",
    );
    expect(mockWakeup).toHaveBeenCalledWith(
      "agent-designer",
      expect.objectContaining({
        reason: "issue_blockers_resolved",
        payload: expect.objectContaining({
          issueId: "issue-2",
          resolvedBlockerIssueId: "issue-1",
        }),
      }),
    );
  });

  it.sequential("wakes only ready workflow children when applying a workflow template", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "root-1",
      companyId: "company-1",
      identifier: "PAP-120",
      title: "Ship checkout",
      description: null,
      status: "todo",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-pm",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueWorkflowService.applyTemplate.mockResolvedValue({
      parentIssue: {
        id: "root-1",
        companyId: "company-1",
        identifier: "PAP-120",
        title: "Ship checkout",
        description: null,
        status: "todo",
        priority: "medium",
        parentId: null,
        assigneeAgentId: "agent-pm",
        assigneeUserId: null,
        createdByAgentId: null,
        createdByUserId: null,
        executionWorkspaceId: null,
        workflowTemplateKey: "engineering_delivery_v1",
        labels: [],
        labelIds: [],
      },
      createdChildren: [
        {
          id: "lane-pm",
          companyId: "company-1",
          identifier: "PAP-121",
          title: "PM: Ship checkout",
          description: null,
          status: "todo",
          priority: "medium",
          parentId: "root-1",
          assigneeAgentId: "agent-pm",
          assigneeUserId: null,
          createdByAgentId: null,
          createdByUserId: null,
          executionWorkspaceId: null,
          workflowTemplateKey: "engineering_delivery_v1",
          workflowLaneRole: "pm",
          labels: [],
          labelIds: [],
        },
        {
          id: "lane-design",
          companyId: "company-1",
          identifier: "PAP-122",
          title: "Design: Ship checkout",
          description: null,
          status: "blocked",
          priority: "medium",
          parentId: "root-1",
          assigneeAgentId: "agent-designer",
          assigneeUserId: null,
          createdByAgentId: null,
          createdByUserId: null,
          executionWorkspaceId: null,
          workflowTemplateKey: "engineering_delivery_v1",
          workflowLaneRole: "designer",
          labels: [],
          labelIds: [],
        },
      ],
    });

    const res = await request(createApp())
      .post("/api/issues/root-1/apply-workflow-template")
      .send({ workflowTemplateKey: "engineering_delivery_v1" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(res.status).toBe(200);
    expect(mockWakeup).toHaveBeenCalledTimes(1);
    expect(mockWakeup).toHaveBeenCalledWith(
      "agent-pm",
      expect.objectContaining({
        reason: "issue_assigned",
        payload: expect.objectContaining({
          issueId: "lane-pm",
        }),
      }),
    );
  });

  it.sequential("returns 422 and skips side effects when workflow application is missing a security specialist", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "root-1",
      companyId: "company-1",
      identifier: "PAP-120",
      title: "Ship checkout",
      description: null,
      status: "todo",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-pm",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueWorkflowService.applyTemplate.mockRejectedValue(Object.assign(
      new Error("Engineering delivery requires an available security specialist before it can be applied"),
      { status: 422 },
    ));

    const res = await request(createApp())
      .post("/api/issues/root-1/apply-workflow-template")
      .send({ workflowTemplateKey: "engineering_delivery_v1" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: "Engineering delivery requires an available security specialist before it can be applied",
    });
    expect(mockLogActivity).not.toHaveBeenCalled();
    expect(mockWakeup).not.toHaveBeenCalled();
  });
});
