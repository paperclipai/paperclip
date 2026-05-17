import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const ownerAgentId = "33333333-3333-4333-8333-333333333333";
const ownerRunId = "44444444-4444-4444-8444-444444444444";
const executionWorkspaceId = "55555555-5555-4555-8555-555555555555";

const mockIssueService = vi.hoisted(() => ({
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  getByIdentifier: vi.fn(),
  getById: vi.fn(),
  getRelationSummaries: vi.fn(),
  getDependencyReadiness: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  listAttachments: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
  findMentionedAgents: vi.fn(),
}));

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockInspectDirty = vi.hoisted(() => vi.fn());

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockTreeControlService = vi.hoisted(() => ({
  getActivePauseHoldGate: vi.fn(async () => null),
}));

const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

function registerRouteMocks() {
  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentTaskCompleted: vi.fn(),
    trackErrorHandlerCrash: vi.fn(),
  }));

  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
  }));

  vi.doMock("../services/access.js", () => ({
    accessService: () => mockAccessService,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));

  vi.doMock("../services/execution-workspaces.js", () => ({
    executionWorkspaceService: () => mockExecutionWorkspaceService,
    inspectExecutionWorkspaceDirtyForDoneTransition: mockInspectDirty,
  }));

  vi.doMock("../services/heartbeat.js", () => ({
    heartbeatService: () => mockHeartbeatService,
  }));

  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));

  vi.doMock("../services/projects.js", () => ({
    projectService: () => ({ getById: vi.fn(async () => null) }),
  }));

  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    companyService: () => mockCompanyService,
    documentService: () => ({}),
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
      listCompanyIds: vi.fn(async () => [companyId]),
    }),
    issueApprovalService: () => ({}),
    issueReferenceService: () => ({
      deleteDocumentSource: async () => undefined,
      diffIssueReferenceSummary: () => ({
        addedReferencedIssues: [],
        removedReferencedIssues: [],
        currentReferencedIssues: [],
      }),
      emptySummary: () => ({ outbound: [], inbound: [] }),
      listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
      syncComment: async () => undefined,
      syncDocument: async () => undefined,
      syncIssue: async () => undefined,
    }),
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: mockLogActivity,
    projectService: () => ({ getById: vi.fn(async () => null) }),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    treeControlService: () => mockTreeControlService,
    workProductService: () => ({}),
  }));
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId,
    status: "in_progress",
    priority: "high",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: ownerAgentId,
    assigneeUserId: null,
    createdByUserId: "board-user",
    identifier: "PAP-2287",
    title: "Issue with execution workspace",
    executionPolicy: null,
    executionState: null,
    executionWorkspaceId,
    executionRunId: null,
    checkoutRunId: null,
    hiddenAt: null,
    labels: [],
    labelIds: [],
    ...overrides,
  };
}

function makeWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    id: executionWorkspaceId,
    companyId,
    projectId: "project-1",
    name: "isolated-worktree",
    mode: "isolated_workspace",
    strategyType: "git_worktree",
    status: "active",
    cwd: "/tmp/workspaces/PAP-2287",
    repoUrl: null,
    baseRef: null,
    branchName: "PAP-2287-thing",
    providerType: "git_worktree",
    providerRef: "/tmp/workspaces/PAP-2287",
    metadata: null,
    closedAt: null,
    ...overrides,
  };
}

function ownerActor() {
  return {
    type: "agent",
    agentId: ownerAgentId,
    companyId,
    source: "agent_key",
    runId: ownerRunId,
  };
}

function boardActor() {
  return {
    type: "board",
    userId: "board-user",
    companyIds: [companyId],
    source: "local_implicit",
    isInstanceAdmin: false,
  };
}

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
  ]);
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

describe.sequential("dirty execution workspace done guardrail", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/execution-workspaces.js");
    vi.doUnmock("../services/heartbeat.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../services/projects.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerRouteMocks();
    vi.clearAllMocks();

    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAgentService.getById.mockResolvedValue({
      id: ownerAgentId,
      companyId,
      role: "engineer",
      reportsTo: null,
      permissions: { canCreateAgents: false },
    });
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: null });
    mockCompanyService.getById.mockResolvedValue({ id: companyId, issuePrefix: "PAP" });
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.getDependencyReadiness?.mockResolvedValue?.({
      unresolvedBlockerCount: 0,
      unresolvedBlockerIssueIds: [],
    });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue(),
      ...patch,
    }));
    mockIssueService.addComment.mockResolvedValue({
      id: "66666666-6666-4666-8666-666666666666",
      issueId,
      companyId,
      body: "comment",
    });
    mockIssueService.listAttachments.mockResolvedValue([]);
    mockIssueService.remove.mockResolvedValue(makeIssue({ status: "cancelled" }));
    mockExecutionWorkspaceService.getById.mockResolvedValue(makeWorkspace());
    mockInspectDirty.mockResolvedValue({
      status: "clean",
      reason: null,
      workspacePath: "/tmp/workspaces/PAP-2287",
      dirtyEntries: [],
      untrackedEntries: [],
      totalRelevantEntries: 0,
      errorMessage: null,
    });
  });

  it("blocks the agent done transition when the execution workspace has uncommitted changes", async () => {
    mockInspectDirty.mockResolvedValue({
      status: "dirty",
      reason: null,
      workspacePath: "/tmp/workspaces/PAP-2287",
      dirtyEntries: [{ path: "src/feature.ts", statusCode: " M" }],
      untrackedEntries: [{ path: "src/scratch.ts" }],
      totalRelevantEntries: 2,
      errorMessage: null,
    });

    const res = await request(await createApp(ownerActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("uncommitted changes");
    expect(res.body.code).toBe("execution_workspace_dirty");
    expect(res.body.details.executionWorkspaceId).toBe(executionWorkspaceId);
    expect(res.body.details.workspacePath).toBe("/tmp/workspaces/PAP-2287");
    expect(res.body.details.totalRelevantEntries).toBe(2);
    expect(res.body.details.dirtyEntries).toEqual([{ path: "src/feature.ts", statusCode: " M" }]);
    expect(res.body.details.untrackedEntries).toEqual([{ path: "src/scratch.ts" }]);
    expect(res.body.details.bypassHints).toEqual(
      expect.arrayContaining([expect.stringContaining("no-code")]),
    );
    expect(mockInspectDirty).toHaveBeenCalledWith(expect.objectContaining({ id: executionWorkspaceId }));
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("allows the agent done transition when the workspace inspector reports clean", async () => {
    const res = await request(await createApp(ownerActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockInspectDirty).toHaveBeenCalledWith(expect.objectContaining({ id: executionWorkspaceId }));
    expect(mockIssueService.update).toHaveBeenCalledWith(
      issueId,
      expect.objectContaining({ status: "done" }),
    );
  });

  it("does not call the inspector when the issue carries the no-code label, even if the workspace is dirty", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({
        labels: [{ id: "label-1", companyId, name: "no-code", color: "#000000" }],
        labelIds: ["label-1"],
      }),
    );

    const res = await request(await createApp(ownerActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockInspectDirty).not.toHaveBeenCalled();
    expect(mockIssueService.update).toHaveBeenCalledWith(
      issueId,
      expect.objectContaining({ status: "done" }),
    );
  });

  it("matches the no-code label case-insensitively", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({
        labels: [{ id: "label-1", companyId, name: "No-Code", color: "#000000" }],
        labelIds: ["label-1"],
      }),
    );

    await request(await createApp(ownerActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" })
      .expect(200);

    expect(mockInspectDirty).not.toHaveBeenCalled();
  });

  it("does not enforce the guardrail for board user transitions", async () => {
    mockInspectDirty.mockResolvedValue({
      status: "dirty",
      reason: null,
      workspacePath: "/tmp/workspaces/PAP-2287",
      dirtyEntries: [{ path: "README.md", statusCode: " M" }],
      untrackedEntries: [],
      totalRelevantEntries: 1,
      errorMessage: null,
    });

    await request(await createApp(boardActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" })
      .expect(200);

    expect(mockInspectDirty).not.toHaveBeenCalled();
    expect(mockIssueService.update).toHaveBeenCalled();
  });

  it("does not run the inspector when the agent is not transitioning to done", async () => {
    mockInspectDirty.mockResolvedValue({
      status: "dirty",
      reason: null,
      workspacePath: "/tmp/workspaces/PAP-2287",
      dirtyEntries: [{ path: "src/foo.ts", statusCode: " M" }],
      untrackedEntries: [],
      totalRelevantEntries: 1,
      errorMessage: null,
    });

    await request(await createApp(ownerActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ priority: "low" })
      .expect(200);

    expect(mockInspectDirty).not.toHaveBeenCalled();
  });

  it("does not run the inspector when the issue is already done", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "done" }));

    await request(await createApp(ownerActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", title: "Tweak title only" })
      .expect(200);

    expect(mockInspectDirty).not.toHaveBeenCalled();
  });

  it("does not run the inspector when the issue has no execution workspace", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ executionWorkspaceId: null }));

    await request(await createApp(ownerActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" })
      .expect(200);

    expect(mockInspectDirty).not.toHaveBeenCalled();
    expect(mockExecutionWorkspaceService.getById).not.toHaveBeenCalled();
  });

  it("allows the done transition when the inspector skips (cannot inspect the workspace)", async () => {
    mockInspectDirty.mockResolvedValue({
      status: "skipped",
      reason: "shared_workspace",
      workspacePath: null,
      dirtyEntries: [],
      untrackedEntries: [],
      totalRelevantEntries: 0,
      errorMessage: null,
    });

    await request(await createApp(ownerActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" })
      .expect(200);

    expect(mockInspectDirty).toHaveBeenCalled();
    expect(mockIssueService.update).toHaveBeenCalled();
  });
});
