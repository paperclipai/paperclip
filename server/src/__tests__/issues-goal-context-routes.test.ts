import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  checkout: vi.fn(),
  getAncestors: vi.fn(),
  getRelationSummaries: vi.fn(),
  findMentionedProjectIds: vi.fn(),
  getCommentCursor: vi.fn(),
  getComment: vi.fn(),
  listBlockerAttention: vi.fn(),
  listProductivityReviews: vi.fn(),
  listAttachments: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
  listByIds: vi.fn(),
}));

const mockGoalService = vi.hoisted(() => ({
  getById: vi.fn(),
  getDefaultCompanyGoal: vi.fn(),
}));

const mockDocumentsService = vi.hoisted(() => ({
  getIssueDocumentPayload: vi.fn(),
  getIssueDocumentByKey: vi.fn(),
}));

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(async () => []),
  saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
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

const mockIssueReferenceService = vi.hoisted(() => ({
  deleteDocumentSource: vi.fn(async () => undefined),
  diffIssueReferenceSummary: vi.fn(() => ({
    addedReferencedIssues: [],
    removedReferencedIssues: [],
    currentReferencedIssues: [],
  })),
  emptySummary: vi.fn(() => ({ outbound: [], inbound: [] })),
  listIssueReferenceSummary: vi.fn(async () => ({ outbound: [], inbound: [] })),
  syncComment: vi.fn(async () => undefined),
  syncDocument: vi.fn(async () => undefined),
  syncIssue: vi.fn(async () => undefined),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

const mockRoutineService = vi.hoisted(() => ({
  syncRunStatusForIssue: vi.fn(async () => undefined),
}));

const mockWorkProductService = vi.hoisted(() => ({
  listForIssue: vi.fn(async () => []),
}));

const mockEnvironmentService = vi.hoisted(() => ({}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  documentService: () => mockDocumentsService,
  environmentService: () => mockEnvironmentService,
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  feedbackService: () => mockFeedbackService,
  goalService: () => mockGoalService,
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => mockInstanceSettingsService,
  issueApprovalService: () => ({}),
  issueReferenceService: () => mockIssueReferenceService,
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
  routineService: () => mockRoutineService,
  workProductService: () => mockWorkProductService,
}));

vi.mock("../services/execution-workspaces.js", () => ({
  executionWorkspaceService: () => mockExecutionWorkspaceService,
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

const legacyProjectLinkedIssue = {
  id: "11111111-1111-4111-8111-111111111111",
  companyId: "company-1",
  identifier: "PAP-581",
  title: "Legacy onboarding task",
  description: "Seed the first CEO task",
  status: "todo",
  priority: "medium",
  projectId: "22222222-2222-4222-8222-222222222222",
  goalId: null,
  parentId: null,
  assigneeAgentId: "33333333-3333-4333-8333-333333333333",
  assigneeUserId: null,
  updatedAt: new Date("2026-03-24T12:00:00Z"),
  executionWorkspaceId: null,
  labels: [],
  labelIds: [],
};

const projectGoal = {
  id: "44444444-4444-4444-8444-444444444444",
  companyId: "company-1",
  title: "Launch the company",
  description: null,
  level: "company",
  status: "active",
  parentId: null,
  ownerAgentId: null,
  createdAt: new Date("2026-03-20T00:00:00Z"),
  updatedAt: new Date("2026-03-20T00:00:00Z"),
};

describe.sequential("issue goal context routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(legacyProjectLinkedIssue);
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.findMentionedProjectIds.mockResolvedValue([]);
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockIssueService.getComment.mockResolvedValue(null);
    mockIssueService.listBlockerAttention.mockResolvedValue(new Map());
    mockIssueService.listProductivityReviews.mockResolvedValue(new Map());
    mockIssueService.listAttachments.mockResolvedValue([]);
    mockDocumentsService.getIssueDocumentPayload.mockResolvedValue({});
    mockDocumentsService.getIssueDocumentByKey.mockResolvedValue(null);
    mockExecutionWorkspaceService.getById.mockResolvedValue(null);
    mockProjectService.getById.mockResolvedValue({
      id: legacyProjectLinkedIssue.projectId,
      companyId: "company-1",
      urlKey: "onboarding",
      goalId: projectGoal.id,
      goalIds: [projectGoal.id],
      goals: [{ id: projectGoal.id, title: projectGoal.title }],
      name: "Onboarding",
      description: null,
      status: "in_progress",
      leadAgentId: null,
      targetDate: null,
      color: null,
      pauseReason: null,
      pausedAt: null,
      executionWorkspacePolicy: null,
      codebase: {
        workspaceId: null,
        repoUrl: null,
        repoRef: null,
        defaultRef: null,
        repoName: null,
        localFolder: null,
        managedFolder: "/tmp/company-1/project-1",
        effectiveLocalFolder: "/tmp/company-1/project-1",
        origin: "managed_checkout",
      },
      workspaces: [],
      primaryWorkspace: null,
      archivedAt: null,
      createdAt: new Date("2026-03-20T00:00:00Z"),
      updatedAt: new Date("2026-03-20T00:00:00Z"),
    });
    mockProjectService.listByIds.mockResolvedValue([]);
    mockGoalService.getById.mockImplementation(async (id: string) =>
      id === projectGoal.id ? projectGoal : null,
    );
    mockGoalService.getDefaultCompanyGoal.mockResolvedValue(null);
  });

  it("surfaces the project goal from GET /issues/:id when the issue has no direct goal", async () => {
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 2,
      latestCommentId: "comment-2",
      latestCommentAt: "2026-05-04T21:15:17.065Z",
    });
    const res = await request(createApp()).get("/api/issues/11111111-1111-4111-8111-111111111111");

    expect(res.status).toBe(200);
    expect(res.body.goalId).toBe(projectGoal.id);
    expect(res.body.commentCursor).toEqual({
      totalComments: 2,
      latestCommentId: "comment-2",
      latestCommentAt: "2026-05-04T21:15:17.065Z",
    });
    expect(res.body.goal).toEqual(
      expect.objectContaining({
        id: projectGoal.id,
        title: projectGoal.title,
      }),
    );
    expect(mockIssueService.findMentionedProjectIds).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { includeCommentBodies: false },
    );
    expect(mockGoalService.getDefaultCompanyGoal).not.toHaveBeenCalled();
  });

  it("surfaces the project goal from GET /issues/:id/heartbeat-context", async () => {
    const res = await request(createApp()).get(
      "/api/issues/11111111-1111-4111-8111-111111111111/heartbeat-context",
    );

    expect(res.status).toBe(200);
    expect(res.body.issue.goalId).toBe(projectGoal.id);
    expect(res.body.goal).toEqual(
      expect.objectContaining({
        id: projectGoal.id,
        title: projectGoal.title,
      }),
    );
    expect(mockGoalService.getDefaultCompanyGoal).not.toHaveBeenCalled();
    expect(res.body.attachments).toEqual([]);
  });

  it("preserves direct continuation summary lookup in GET /issues/:id/heartbeat-context", async () => {
    mockDocumentsService.getIssueDocumentByKey.mockResolvedValue({
      key: "continuation-summary",
      title: "Continuation Summary",
      body: "# Handoff",
      latestRevisionId: "revision-1",
      latestRevisionNumber: 1,
      updatedAt: new Date("2026-04-19T12:00:00.000Z"),
    });

    const res = await request(createApp()).get(
      "/api/issues/11111111-1111-4111-8111-111111111111/heartbeat-context",
    );

    expect(res.status).toBe(200);
    expect(mockDocumentsService.getIssueDocumentByKey).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "continuation-summary",
    );
    expect(res.body.continuationSummary).toEqual(expect.objectContaining({
      key: "continuation-summary",
      body: "# Handoff",
    }));
  });

  it("surfaces blocker summaries on GET /issues/:id/heartbeat-context", async () => {
    mockIssueService.getRelationSummaries.mockResolvedValue({
      blockedBy: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          identifier: "PAP-580",
          title: "Finish wakeup plumbing",
          status: "done",
          priority: "medium",
          assigneeAgentId: null,
          assigneeUserId: null,
        },
      ],
      blocks: [],
    });

    const res = await request(createApp()).get(
      "/api/issues/11111111-1111-4111-8111-111111111111/heartbeat-context",
    );

    expect(res.status).toBe(200);
    expect(res.body.issue.blockedBy).toEqual([
      expect.objectContaining({
        id: "55555555-5555-4555-8555-555555555555",
        identifier: "PAP-580",
      }),
    ]);
    expect(res.body.issue.blockedByIssueIds).toEqual(["55555555-5555-4555-8555-555555555555"]);
  });

  it("keeps relation-derived blockedByIssueIds on GET /issues/:id even when document payload includes null", async () => {
    mockIssueService.getRelationSummaries.mockResolvedValue({
      blockedBy: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          identifier: "PAP-580",
          title: "Finish wakeup plumbing",
          status: "done",
          priority: "medium",
          assigneeAgentId: null,
          assigneeUserId: null,
        },
      ],
      blocks: [],
    });
    mockDocumentsService.getIssueDocumentPayload.mockResolvedValue({ blockedByIssueIds: null });

    const res = await request(createApp()).get("/api/issues/11111111-1111-4111-8111-111111111111");

    expect(res.status).toBe(200);
    expect(res.body.blockedByIssueIds).toEqual(["55555555-5555-4555-8555-555555555555"]);
  });

  it("surfaces the current execution workspace from GET /issues/:id/heartbeat-context", async () => {
    mockIssueService.getById.mockResolvedValue({
      ...legacyProjectLinkedIssue,
      executionWorkspaceId: "55555555-5555-4555-8555-555555555555",
    });
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "55555555-5555-4555-8555-555555555555",
      name: "PAP-581 workspace",
      mode: "isolated_workspace",
      status: "active",
      cwd: "/tmp/pap-581",
      runtimeServices: [
        {
          id: "service-1",
          serviceName: "web",
          status: "running",
          url: "http://127.0.0.1:5173",
          healthStatus: "healthy",
        },
      ],
    });

    const res = await request(createApp()).get(
      "/api/issues/11111111-1111-4111-8111-111111111111/heartbeat-context",
    );

    expect(res.status).toBe(200);
    expect(mockExecutionWorkspaceService.getById).toHaveBeenCalledWith("55555555-5555-4555-8555-555555555555");
    expect(res.body.issue.executionWorkspaceId).toBe("55555555-5555-4555-8555-555555555555");
    expect(res.body.issue.currentExecutionWorkspace).toEqual(expect.objectContaining({
      id: "55555555-5555-4555-8555-555555555555",
      mode: "isolated_workspace",
    }));
    expect(res.body.currentExecutionWorkspace).toEqual(expect.objectContaining({
      id: "55555555-5555-4555-8555-555555555555",
      mode: "isolated_workspace",
      runtimeServices: [
        expect.objectContaining({
          serviceName: "web",
          url: "http://127.0.0.1:5173",
        }),
      ],
    }));
  });

  it("keeps checkout and heartbeat-context currentExecutionWorkspace fields in parity for the same issue", async () => {
    const workspaceId = "66666666-6666-4666-8666-666666666666";
    let mutableIssue = {
      ...legacyProjectLinkedIssue,
      executionWorkspaceId: null as string | null,
    };

    mockIssueService.getById.mockImplementation(async () => mutableIssue);
    mockIssueService.checkout.mockImplementation(async () => {
      mutableIssue = {
        ...mutableIssue,
        status: "in_progress",
        executionWorkspaceId: workspaceId,
      };
      return mutableIssue;
    });
    mockExecutionWorkspaceService.getById.mockImplementation(async (id: string) =>
      id === workspaceId
        ? {
            id: workspaceId,
            name: "PAP-581 workspace",
            mode: "isolated_workspace",
            status: "active",
            cwd: "/tmp/pap-581",
            runtimeServices: [],
          }
        : null,
    );

    const checkoutRes = await request(createApp())
      .post("/api/issues/11111111-1111-4111-8111-111111111111/checkout")
      .send({
        agentId: "33333333-3333-4333-8333-333333333333",
        expectedStatuses: ["todo", "backlog", "blocked"],
      });

    expect(checkoutRes.status).toBe(200);
    expect(checkoutRes.body.executionWorkspaceId).toBe(workspaceId);
    expect(checkoutRes.body.currentExecutionWorkspace).toEqual(
      expect.objectContaining({
        id: workspaceId,
        cwd: "/tmp/pap-581",
      }),
    );

    const contextRes = await request(createApp()).get(
      "/api/issues/11111111-1111-4111-8111-111111111111/heartbeat-context",
    );

    expect(contextRes.status).toBe(200);
    expect(contextRes.body.issue.executionWorkspaceId).toBe(workspaceId);
    expect(contextRes.body.issue.currentExecutionWorkspace).toEqual(
      expect.objectContaining({
        id: workspaceId,
        cwd: "/tmp/pap-581",
      }),
    );
    expect(contextRes.body.currentExecutionWorkspace).toEqual(
      expect.objectContaining({
        id: workspaceId,
        cwd: "/tmp/pap-581",
      }),
    );
    expect(contextRes.body.issue.currentExecutionWorkspace).toEqual(checkoutRes.body.currentExecutionWorkspace);
  });

  it("keeps heartbeat-context executionWorkspaceId populated when workspace lookup is null", async () => {
    const workspaceId = "77777777-7777-4777-8777-777777777777";
    const issueWithWorkspace = {
      ...legacyProjectLinkedIssue,
      status: "in_progress",
      executionWorkspaceId: workspaceId,
    };

    mockIssueService.getById.mockResolvedValue(issueWithWorkspace);
    mockExecutionWorkspaceService.getById.mockResolvedValue(null);

    const contextRes = await request(createApp()).get(
      "/api/issues/11111111-1111-4111-8111-111111111111/heartbeat-context",
    );

    expect(contextRes.status).toBe(200);
    expect(contextRes.body.issue.executionWorkspaceId).toBe(workspaceId);
    expect(contextRes.body.issue.currentExecutionWorkspace).toBeNull();
    expect(contextRes.body.currentExecutionWorkspace).toBeNull();
  });

  it("preserves direct PATCH execution workspace fields through the issue route", async () => {
    const issueId = "11111111-1111-4111-8111-111111111111";
    const nextExecutionWorkspaceId = "88888888-8888-4888-8888-888888888888";
    let mutableIssue = {
      ...legacyProjectLinkedIssue,
      executionWorkspaceId: null as string | null,
      executionWorkspacePreference: null as string | null,
      executionWorkspaceSettings: null as Record<string, unknown> | null,
    };

    mockIssueService.getById.mockImplementation(async () => mutableIssue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
      mutableIssue = {
        ...mutableIssue,
        ...patch,
      };
      return mutableIssue;
    });

    const res = await request(createApp())
      .patch(`/api/issues/${issueId}`)
      .send({
        executionWorkspaceId: nextExecutionWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "isolated_workspace" },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      issueId,
      expect.objectContaining({
        executionWorkspaceId: nextExecutionWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "isolated_workspace" },
      }),
    );
    expect(res.body.executionWorkspaceId).toBe(nextExecutionWorkspaceId);
    expect(res.body.executionWorkspacePreference).toBe("reuse_existing");
    expect(res.body.executionWorkspaceSettings).toEqual({ mode: "isolated_workspace" });
  });

  it("accepts and persists agent_default as executionWorkspacePreference on direct PATCH", async () => {
    const issueId = "11111111-1111-4111-8111-111111111111";
    let mutableIssue = {
      ...legacyProjectLinkedIssue,
      executionWorkspaceId: null as string | null,
      executionWorkspacePreference: null as string | null,
      executionWorkspaceSettings: null as Record<string, unknown> | null,
    };

    mockIssueService.getById.mockImplementation(async () => mutableIssue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
      mutableIssue = {
        ...mutableIssue,
        ...patch,
      };
      return mutableIssue;
    });

    const res = await request(createApp())
      .patch(`/api/issues/${issueId}`)
      .send({
        executionWorkspacePreference: "agent_default",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      issueId,
      expect.objectContaining({
        executionWorkspacePreference: "agent_default",
      }),
    );
    expect(res.body.executionWorkspacePreference).toBe("agent_default");
  });

  it("retries with a workspace-only patch when direct PATCH response returns stale workspace linkage", async () => {
    const issueId = "11111111-1111-4111-8111-111111111111";
    const nextExecutionWorkspaceId = "99999999-9999-4999-8999-999999999999";
    const nextPreference = "reuse_existing";
    let mutableIssue = {
      ...legacyProjectLinkedIssue,
      executionWorkspaceId: "55555555-5555-4555-8555-555555555555",
      executionWorkspacePreference: null as string | null,
      executionWorkspaceSettings: null as Record<string, unknown> | null,
    };
    let updateCallCount = 0;

    mockIssueService.getById.mockImplementation(async () => mutableIssue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
      updateCallCount += 1;
      if (updateCallCount === 1) {
        // Simulate the stale response observed in runtime: PATCH returns 200
        // but workspace linkage fields are unchanged.
        return mutableIssue;
      }
      mutableIssue = {
        ...mutableIssue,
        ...patch,
      };
      return mutableIssue;
    });

    const res = await request(createApp())
      .patch(`/api/issues/${issueId}`)
      .send({
        executionWorkspaceId: nextExecutionWorkspaceId,
        executionWorkspacePreference: nextPreference,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledTimes(2);
    expect(mockIssueService.update).toHaveBeenNthCalledWith(
      2,
      issueId,
      expect.objectContaining({
        executionWorkspaceId: nextExecutionWorkspaceId,
        executionWorkspacePreference: nextPreference,
      }),
    );
    expect(res.body.executionWorkspaceId).toBe(nextExecutionWorkspaceId);
    expect(res.body.executionWorkspacePreference).toBe(nextPreference);
  });

  it("returns explicit policy override reason when workspace linkage remains stale after retry", async () => {
    const issueId = "11111111-1111-4111-8111-111111111111";
    const nextExecutionWorkspaceId = "99999999-9999-4999-8999-999999999999";
    const nextPreference = "reuse_existing";
    const staleIssue = {
      ...legacyProjectLinkedIssue,
      executionWorkspaceId: "55555555-5555-4555-8555-555555555555",
      executionWorkspacePreference: "agent_default" as string | null,
      executionWorkspaceSettings: null as Record<string, unknown> | null,
    };

    mockIssueService.getById.mockImplementation(async () => staleIssue);
    mockIssueService.update.mockImplementation(async () => staleIssue);

    const res = await request(createApp())
      .patch(`/api/issues/${issueId}`)
      .send({
        executionWorkspaceId: nextExecutionWorkspaceId,
        executionWorkspacePreference: nextPreference,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body).toMatchObject({
      error: "Execution workspace selection was overridden by policy",
      details: {
        reason: "execution_workspace_policy_override",
        requestedExecutionWorkspaceId: nextExecutionWorkspaceId,
        requestedExecutionWorkspacePreference: nextPreference,
        persistedExecutionWorkspaceId: staleIssue.executionWorkspaceId,
        persistedExecutionWorkspacePreference: staleIssue.executionWorkspacePreference,
      },
    });
  });
});
