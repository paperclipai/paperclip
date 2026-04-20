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
  projectService: () => ({
    getById: vi.fn(async () => null),
    listByIds: vi.fn(async () => []),
  }),
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
  }, 20_000);

  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueWorkflowService.decorateIssue.mockImplementation(async (issue: unknown) => issue);
    mockIssueWorkflowService.evaluateLaneCompletion.mockResolvedValue({
      canComplete: true,
      blockingReasons: [],
      artifactStatuses: [],
    });
    mockIssueWorkflowService.applyTemplate.mockReset();
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
});
