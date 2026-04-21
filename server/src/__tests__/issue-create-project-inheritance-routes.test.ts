import express from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  create: vi.fn(),
  findMentionedProjectIds: vi.fn(),
  getById: vi.fn(),
  getAncestors: vi.fn(),
  getRelationSummaries: vi.fn(),
  listAttachments: vi.fn(),
  listComments: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  getRun: vi.fn(async () => null),
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
}));

const mockExecutionGateService = vi.hoisted(() => ({
  getExecutionBlock: vi.fn(async () => null),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(async () => null),
}));
const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(async () => null),
  listByIds: vi.fn(async () => []),
}));
const mockIssueWorkflowService = vi.hoisted(() => ({
  decorateIssue: vi.fn(async (issue: unknown) => issue),
  evaluateLaneCompletion: vi.fn(async () => ({ canComplete: true, blockingReasons: [], artifactStatuses: [] })),
  applyTemplate: vi.fn(),
  advanceWorkflowDependents: vi.fn(async () => []),
  invalidateWorkflowDescendants: vi.fn(async () => ({ invalidatedSelf: null, invalidatedDescendants: [] })),
  handbackWorkflowLane: vi.fn(async () => null),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(async () => true),
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => ({
    getById: vi.fn(async () => null),
    list: vi.fn(async () => []),
  }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
    listIssueDocuments: vi.fn(async () => []),
  }),
  companyService: () => mockCompanyService,
  executionGateService: () => mockExecutionGateService,
  executionWorkspaceService: () => ({
    getById: vi.fn(async () => null),
  }),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => ({
    getById: vi.fn(async () => null),
    getDefaultCompanyGoal: vi.fn(async () => null),
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
  issueWorkflowService: () => mockIssueWorkflowService,
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
}));

vi.mock("../services/issue-merge.js", () => ({
  issueMergeService: () => ({
    getIssueMergeStatus: vi.fn(async () => null),
    attemptQaPassAutoMerge: vi.fn(async () => ({ outcome: "not_applicable" as const, status: null })),
  }),
}));

let issueRoutesFactory: typeof import("../routes/issues.js").issueRoutes;
let errorHandlerMiddleware: typeof import("../middleware/index.js").errorHandler;
let unprocessableError: typeof import("../errors.js").unprocessable;

const sourceProjectId = "11111111-1111-4111-8111-111111111111";
const runProjectId = "22222222-2222-4222-8222-222222222222";
const explicitProjectId = "33333333-3333-4333-8333-333333333333";

function createApp(
  actor: Record<string, unknown> = {
    type: "agent",
    source: "agent_key",
    agentId: "agent-1",
    companyId: "company-1",
    runId: "run-1",
  },
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutesFactory({} as any, {} as any));
  app.use(errorHandlerMiddleware);
  return app;
}

describe("issue create project inheritance routes", () => {
  beforeAll(async () => {
    vi.resetModules();
    ({ issueRoutes: issueRoutesFactory } = await import("../routes/issues.js"));
    ({ errorHandler: errorHandlerMiddleware } = await import("../middleware/index.js"));
    ({ unprocessable: unprocessableError } = await import("../errors.js"));
  }, 20_000);

  beforeEach(() => {
    vi.clearAllMocks();
    mockCompanyService.getById.mockResolvedValue({
      id: "company-1",
      defaultRootIssueDeliveryMode: "simple",
    });
    mockProjectService.getById.mockResolvedValue(null);
    mockProjectService.listByIds.mockResolvedValue([]);
    mockIssueWorkflowService.decorateIssue.mockImplementation(async (issue: unknown) => issue);
    mockIssueWorkflowService.evaluateLaneCompletion.mockResolvedValue({
      canComplete: true,
      blockingReasons: [],
      artifactStatuses: [],
    });
    mockIssueWorkflowService.applyTemplate.mockResolvedValue({
      parentIssue: {
        id: "new-issue-1",
      },
      createdChildren: [],
    });
    mockExecutionGateService.getExecutionBlock.mockResolvedValue(null);
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "agent-1",
      contextSnapshot: {
        issueId: "source-issue-1",
        projectId: runProjectId,
      },
    });
    mockIssueService.findMentionedProjectIds.mockResolvedValue([]);
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listAttachments.mockResolvedValue([]);
    mockIssueService.listComments.mockResolvedValue([]);
    mockIssueService.getById.mockImplementation(async (id: string) => {
      if (id === "source-issue-1") {
        return {
          id,
          companyId: "company-1",
          projectId: sourceProjectId,
        };
      }
      return null;
    });
    mockIssueService.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => ({
      id: "new-issue-1",
      companyId: "company-1",
      identifier: "COMA-1258",
      title: input.title,
      projectId: input.projectId ?? null,
      status: "todo",
      priority: "medium",
      assigneeAgentId: null,
      assigneeUserId: null,
      createdByAgentId: input.createdByAgentId ?? null,
      createdByUserId: input.createdByUserId ?? null,
      labels: [],
      labelIds: [],
      createdAt: new Date("2026-04-17T17:08:00Z"),
      updatedAt: new Date("2026-04-17T17:08:00Z"),
    }));
  });

  it("inherits project from the source issue when an agent run creates a follow-up issue without projectId", async () => {
    const res = await request(createApp())
      .post("/api/companies/company-1/issues")
      .send({
        title: "Follow-up audit ticket",
      });

    expect(res.status).toBe(201);
    expect(mockExecutionGateService.getExecutionBlock).toHaveBeenCalledWith(
      "company-1",
      "agent-1",
      expect.objectContaining({
        issueId: null,
        projectId: sourceProjectId,
      }),
    );
    expect(mockIssueService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        title: "Follow-up audit ticket",
        projectId: sourceProjectId,
        createdByAgentId: "agent-1",
      }),
    );
    expect(res.body).toEqual(
      expect.objectContaining({
        projectId: sourceProjectId,
      }),
    );
  });

  it("prefers an explicit projectId over inherited run context", async () => {
    const res = await request(createApp())
      .post("/api/companies/company-1/issues")
      .send({
        title: "Follow-up audit ticket",
        projectId: explicitProjectId,
      });

    expect(res.status).toBe(201);
    expect(mockHeartbeatService.getRun).not.toHaveBeenCalled();
    expect(mockIssueService.getById).not.toHaveBeenCalled();
    expect(mockExecutionGateService.getExecutionBlock).toHaveBeenCalledWith(
      "company-1",
      "agent-1",
      expect.objectContaining({
        issueId: null,
        projectId: explicitProjectId,
      }),
    );
    expect(mockIssueService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        projectId: explicitProjectId,
      }),
    );
  });

  it("falls back to the run snapshot project when the source issue has no project", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "source-issue-1",
      companyId: "company-1",
      projectId: null,
    });

    const res = await request(createApp())
      .post("/api/companies/company-1/issues")
      .send({
        title: "Snapshot fallback ticket",
      });

    expect(res.status).toBe(201);
    expect(mockExecutionGateService.getExecutionBlock).toHaveBeenCalledWith(
      "company-1",
      "agent-1",
      expect.objectContaining({
        issueId: null,
        projectId: runProjectId,
      }),
    );
    expect(mockIssueService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        projectId: runProjectId,
      }),
    );
    expect(res.body).toEqual(
      expect.objectContaining({
        projectId: runProjectId,
      }),
    );
  });

  it("does not inherit a project when the run context does not belong to the current agent or company", async () => {
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-2",
      agentId: "agent-1",
      contextSnapshot: {
        issueId: "source-issue-1",
        projectId: runProjectId,
      },
    });

    const res = await request(createApp())
      .post("/api/companies/company-1/issues")
      .send({
        title: "Invalid run context ticket",
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.getById).not.toHaveBeenCalled();
    expect(mockExecutionGateService.getExecutionBlock).toHaveBeenCalledWith(
      "company-1",
      "agent-1",
      expect.objectContaining({
        issueId: null,
        projectId: null,
      }),
    );
    expect(mockIssueService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        projectId: null,
      }),
    );
  });

  it("does not inherit a project for board-created issues", async () => {
    const res = await request(
      createApp({
        type: "board",
        source: "local_implicit",
        userId: "board-user-1",
      }),
    )
      .post("/api/companies/company-1/issues")
      .send({
        title: "Board-created ticket",
      });

    expect(res.status).toBe(201);
    expect(mockHeartbeatService.getRun).not.toHaveBeenCalled();
    expect(mockIssueService.getById).not.toHaveBeenCalled();
    expect(mockExecutionGateService.getExecutionBlock).not.toHaveBeenCalled();
    expect(mockIssueService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        projectId: null,
        createdByAgentId: null,
        createdByUserId: "board-user-1",
      }),
    );
    expect(res.body).toEqual(
      expect.objectContaining({
        projectId: null,
      }),
    );
  });

  it("does not auto-apply the engineering workflow when company delivery settings cannot be resolved", async () => {
    mockCompanyService.getById.mockResolvedValue(null);

    const res = await request(
      createApp({
        type: "board",
        source: "local_implicit",
        userId: "board-user-1",
      }),
    )
      .post("/api/companies/company-1/issues")
      .send({
        title: "Legacy root issue",
      });

    expect(res.status).toBe(201);
    expect(mockIssueWorkflowService.applyTemplate).not.toHaveBeenCalled();
  });

  it("automatically applies the engineering workflow for root issues when the company default delivery mode is engineering", async () => {
    mockCompanyService.getById.mockResolvedValue({
      id: "company-1",
      defaultRootIssueDeliveryMode: "engineering",
    });

    const res = await request(
      createApp({
        type: "board",
        source: "local_implicit",
        userId: "board-user-1",
      }),
    )
      .post("/api/companies/company-1/issues")
      .send({
        title: "Automatic workflow root",
      });

    expect(res.status).toBe(201);
    expect(mockIssueWorkflowService.applyTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        templateKey: "engineering_delivery_v1",
        parentIssue: expect.objectContaining({
          id: "new-issue-1",
          title: "Automatic workflow root",
        }),
      }),
    );
  });

  it("does not auto-apply the engineering workflow for sub-issues", async () => {
    mockCompanyService.getById.mockResolvedValue({
      id: "company-1",
      defaultRootIssueDeliveryMode: "engineering",
    });

    const res = await request(
      createApp({
        type: "board",
        source: "local_implicit",
        userId: "board-user-1",
      }),
    )
      .post("/api/companies/company-1/issues")
      .send({
        title: "Child issue",
        parentId: "44444444-4444-4444-8444-444444444444",
      });

    expect(res.status).toBe(201);
    expect(mockIssueWorkflowService.applyTemplate).not.toHaveBeenCalled();
  });

  it("lets a project simple delivery override suppress the company engineering default", async () => {
    mockCompanyService.getById.mockResolvedValue({
      id: "company-1",
      defaultRootIssueDeliveryMode: "engineering",
    });
    mockProjectService.getById.mockResolvedValue({
      id: explicitProjectId,
      companyId: "company-1",
      defaultRootIssueDeliveryMode: "simple",
    });

    const res = await request(
      createApp({
        type: "board",
        source: "local_implicit",
        userId: "board-user-1",
      }),
    )
      .post("/api/companies/company-1/issues")
      .send({
        title: "Simple project root",
        projectId: explicitProjectId,
      });

    expect(res.status).toBe(201);
    expect(mockIssueWorkflowService.applyTemplate).not.toHaveBeenCalled();
  });

  it("lets a project engineering delivery override enable the workflow when the company default is simple", async () => {
    mockCompanyService.getById.mockResolvedValue({
      id: "company-1",
      defaultRootIssueDeliveryMode: "simple",
    });
    mockProjectService.getById.mockResolvedValue({
      id: explicitProjectId,
      companyId: "company-1",
      defaultRootIssueDeliveryMode: "engineering",
    });

    const res = await request(
      createApp({
        type: "board",
        source: "local_implicit",
        userId: "board-user-1",
      }),
    )
      .post("/api/companies/company-1/issues")
      .send({
        title: "Engineering project root",
        projectId: explicitProjectId,
      });

    expect(res.status).toBe(201);
    expect(mockIssueWorkflowService.applyTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        templateKey: "engineering_delivery_v1",
      }),
    );
  });

  it("returns 422 and skips issue activity logging when automatic engineering workflow apply has no security specialist", async () => {
    mockCompanyService.getById.mockResolvedValue({
      id: "company-1",
      defaultRootIssueDeliveryMode: "engineering",
    });
    mockIssueWorkflowService.applyTemplate.mockRejectedValue(
      unprocessableError("Engineering delivery requires an available security specialist before it can be applied"),
    );

    const res = await request(
      createApp({
        type: "board",
        source: "local_implicit",
        userId: "board-user-1",
      }),
    )
      .post("/api/companies/company-1/issues")
      .send({
        title: "Automatic workflow root",
      });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: "Engineering delivery requires an available security specialist before it can be applied",
    });
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});
