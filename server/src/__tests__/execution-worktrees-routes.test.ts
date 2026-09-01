import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { executionWorkspaceRoutes } from "../routes/execution-worktrees.js";

const mockExecutionWorktreeService = vi.hoisted(() => ({
  list: vi.fn(),
  listOverview: vi.fn(),
  listSummaries: vi.fn(),
  getById: vi.fn(),
  getCloseReadiness: vi.fn(),
  archiveWorkspaceUnderLifecycleLock: vi.fn(),
  fenceClosedWorkspaceDestruction: vi.fn(),
  reconcileExecutionWorkspaceBranch: vi.fn(),
  update: vi.fn(),
}));

const mockWorkspaceOperationService = vi.hoisted(() => ({
  listForExecutionWorkspace: vi.fn(),
  createRecorder: vi.fn(),
  assertRuntimeControlAvailable: vi.fn(async () => undefined),
}));

const mockWorkspaceRuntimeLeaseService = vi.hoisted(() => ({
  claim: vi.fn(async () => ({ outcome: "created", ownerKey: "issue:issue-1", lease: null, reclaimedFrom: null })),
  release: vi.fn(async () => ({ released: false, ownerKey: null })),
  get: vi.fn(async () => null),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

const mockEnvironmentRuntimeService = vi.hoisted(() => ({
  destroyReusableSandboxLeases: vi.fn(async () => undefined),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  executionWorktreeService: () => mockExecutionWorktreeService,
  heartbeatService: () => mockHeartbeatService,
  logActivity: mockLogActivity,
  worktreeOperationService: () => mockWorkspaceOperationService,
  workspaceRuntimeLeaseService: () => mockWorkspaceRuntimeLeaseService,
  LEASED_WORKSPACE_RUNTIME_ACTIONS: ["start", "stop", "restart", "repair"],
}));

vi.mock("../services/environment-runtime.js", () => ({
  environmentRuntimeService: () => mockEnvironmentRuntimeService,
}));

const mockWorkspaceRuntimeTeardown = vi.hoisted(() => ({
  stopRuntimeServicesForExecutionWorktree: vi.fn(async () => undefined),
  cleanupExecutionWorkspaceArtifacts: vi.fn(async () => ({ cleaned: true, warnings: [] as string[] })),
}));

vi.mock("../services/worktree-runtime.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/worktree-runtime.js")>();
  return {
    ...actual,
    stopRuntimeServicesForExecutionWorktree:
      mockWorkspaceRuntimeTeardown.stopRuntimeServicesForExecutionWorktree,
    cleanupExecutionWorkspaceArtifacts: mockWorkspaceRuntimeTeardown.cleanupExecutionWorkspaceArtifacts,
  };
});

function createApp(actor: Record<string, unknown> = {
  type: "board",
  userId: "local-board",
  companyIds: ["company-1"],
  source: "session",
  isInstanceAdmin: false,
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", executionWorkspaceRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe.sequential("execution workspace routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockExecutionWorktreeService.list.mockResolvedValue([]);
    mockExecutionWorktreeService.listOverview.mockResolvedValue({
      items: [],
      total: 0,
      limit: 50,
      offset: 0,
      hasMore: false,
      nextOffset: null,
    });
    mockExecutionWorktreeService.listSummaries.mockResolvedValue([
      {
        id: "workspace-1",
        name: "Alpha",
        mode: "isolated_workspace",
        projectWorkspaceId: null,
      },
    ]);
    mockExecutionWorktreeService.getById.mockResolvedValue(null);
    mockExecutionWorktreeService.reconcileExecutionWorkspaceBranch.mockResolvedValue(null);
    mockHeartbeatService.wakeup.mockResolvedValue(null);
  });

  it("uses summary mode for lightweight workspace lookups", async () => {
    const res = await request(createApp())
      .get("/api/companies/company-1/execution-workspaces?summary=true&reuseEligible=true");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: "workspace-1",
        name: "Alpha",
        mode: "isolated_workspace",
        projectWorkspaceId: null,
      },
    ]);
    expect(mockExecutionWorktreeService.listSummaries).toHaveBeenCalledWith("company-1", {
      projectId: undefined,
      projectWorkspaceId: undefined,
      issueId: undefined,
      status: undefined,
      reuseEligible: true,
    });
    expect(mockExecutionWorktreeService.list).not.toHaveBeenCalled();
  });

  it("delegates bounded workspace overview queries", async () => {
    const res = await request(createApp())
      .get("/api/companies/company-1/workspace-overview?status=active,idle&limit=25&offset=10");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      items: [],
      total: 0,
      limit: 50,
      offset: 0,
      hasMore: false,
      nextOffset: null,
    });
    expect(mockExecutionWorktreeService.listOverview).toHaveBeenCalledWith("company-1", {
      status: ["active", "idle"],
      limit: 25,
      offset: 10,
    });
  });

  it("rejects invalid workspace overview pagination", async () => {
    const res = await request(createApp())
      .get("/api/companies/company-1/workspace-overview?limit=1000");

    expect(res.status).toBe(422);
    expect(mockExecutionWorktreeService.listOverview).not.toHaveBeenCalled();
  });

  it.each([
    ["forward", { mode: "forward" }],
    ["override", { mode: "override", reason: "operator break-glass" }],
    ["quarantine_restore", { mode: "quarantine_restore", reason: "rescue dirty branch" }],
  ])("rejects agent actors for %s branch reconciliation", async (_mode, body) => {
    mockExecutionWorktreeService.getById.mockResolvedValue({
      id: "workspace-1",
      companyId: "company-1",
      sourceIssueId: "issue-1",
    });

    const res = await request(createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_jwt",
      runId: "run-1",
    }))
      .post("/api/execution-workspaces/workspace-1/reconcile-branch")
      .send(body);

    expect(res.status).toBe(403);
    expect(mockExecutionWorktreeService.reconcileExecutionWorkspaceBranch).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("logs branch reconciliation activity after the service operation succeeds", async () => {
    mockExecutionWorktreeService.getById.mockResolvedValue({
      id: "workspace-1",
      companyId: "company-1",
      sourceIssueId: "issue-1",
    });
    mockExecutionWorktreeService.reconcileExecutionWorkspaceBranch.mockResolvedValue({
      workspace: {
        id: "workspace-1",
        companyId: "company-1",
        sourceIssueId: "issue-1",
        branchName: "feature/current",
      },
      inspection: {
        fingerprint: "workspace_incoherence:v1:sha256:test",
        worktreePath: "/tmp/worktree",
        repoRoot: "/tmp/repo",
        fromBranch: "feature/recorded",
        toBranch: "feature/current",
        fromSha: "1111111",
        toSha: "2222222",
        ancestryVerdict: "ancestor",
        cleanliness: "clean",
        statusEntryCount: 0,
        plainLanguageReason: "forward",
      },
      recoveryAction: {
        id: "recovery-1",
      },
      auditCommentId: "comment-1",
    });

    const res = await request(createApp())
      .post("/api/execution-workspaces/workspace-1/reconcile-branch")
      .send({ mode: "forward" });

    expect(res.status).toBe(200);
    expect(mockExecutionWorktreeService.reconcileExecutionWorkspaceBranch).toHaveBeenCalledWith("workspace-1", {
      mode: "forward",
      reason: null,
      actor: {
        actorType: "user",
        actorId: "local-board",
        agentId: null,
        runId: null,
      },
    });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "execution_workspace.branch_reconciled",
      entityType: "execution_workspace",
      entityId: "workspace-1",
      details: expect.objectContaining({
        mode: "forward",
        fromBranch: "feature/recorded",
        toBranch: "feature/current",
        fromSha: "1111111",
        toSha: "2222222",
        ancestryVerdict: "ancestor",
        fingerprint: "workspace_incoherence:v1:sha256:test",
        sourceIssueId: "issue-1",
        auditCommentId: "comment-1",
        recoveryActionId: "recovery-1",
      }),
    }));
  });

  it("accepts quarantine_restore, logs the rescue ref, and wakes the restored source issue", async () => {
    mockExecutionWorktreeService.getById.mockResolvedValue({
      id: "workspace-1",
      companyId: "company-1",
      sourceIssueId: "issue-1",
    });
    mockExecutionWorktreeService.reconcileExecutionWorkspaceBranch.mockResolvedValue({
      workspace: {
        id: "workspace-1",
        companyId: "company-1",
        sourceIssueId: "issue-1",
        branchName: "feature/recorded",
      },
      inspection: {
        fingerprint: "workspace_incoherence:v1:sha256:dirty",
        worktreePath: "/tmp/worktree",
        repoRoot: "/tmp/repo",
        fromBranch: "feature/recorded",
        toBranch: "feature/live",
        fromSha: "1111111",
        toSha: "2222222",
        ancestryVerdict: "diverged",
        cleanliness: "dirty",
        statusEntryCount: 2,
        plainLanguageReason: "dirty live branch",
      },
      recoveryAction: {
        id: "recovery-1",
      },
      auditCommentId: "comment-1",
      rescueRef: {
        branchName: "paperclip/rescue/PAP-123/20260709T120000Z",
        commitSha: "3333333",
        fileCount: 2,
        sourceAuditCommentId: "comment-0",
        claimantAuditCommentId: null,
      },
      restoredSourceIssue: {
        id: "issue-1",
        companyId: "company-1",
        status: "todo",
        assigneeAgentId: "agent-1",
      },
      sourceIssueStatusChanged: true,
    });

    const res = await request(createApp())
      .post("/api/execution-workspaces/workspace-1/reconcile-branch")
      .send({ mode: "quarantine_restore" });

    expect(res.status).toBe(200);
    expect(mockExecutionWorktreeService.reconcileExecutionWorkspaceBranch).toHaveBeenCalledWith("workspace-1", {
      mode: "quarantine_restore",
      reason: null,
      actor: {
        actorType: "user",
        actorId: "local-board",
        agentId: null,
        runId: null,
      },
    });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "execution_workspace.branch_reconciled",
      entityType: "execution_workspace",
      entityId: "workspace-1",
      details: expect.objectContaining({
        mode: "quarantine_restore",
        fingerprint: "workspace_incoherence:v1:sha256:dirty",
        recoveryActionId: "recovery-1",
        rescueRef: expect.objectContaining({
          branchName: "paperclip/rescue/PAP-123/20260709T120000Z",
          commitSha: "3333333",
        }),
        sourceIssueStatus: "todo",
      }),
    }));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith("agent-1", expect.objectContaining({
      source: "automation",
      reason: "issue_recovery_action_restored",
      payload: expect.objectContaining({
        issueId: "issue-1",
        recoveryActionId: "recovery-1",
        executionWorkspaceId: "workspace-1",
        rescueRef: "paperclip/rescue/PAP-123/20260709T120000Z",
        mutation: "execution_workspace_quarantine_restore",
      }),
      contextSnapshot: expect.objectContaining({
        issueId: "issue-1",
        taskId: "issue-1",
        wakeReason: "issue_recovery_action_restored",
        source: "execution_workspace.quarantine_restore",
        recoveryActionId: "recovery-1",
        executionWorkspaceId: "workspace-1",
        rescueRef: "paperclip/rescue/PAP-123/20260709T120000Z",
      }),
    }));
  });

  it("wakes a restored in_review agent participant after quarantine_restore", async () => {
    mockExecutionWorktreeService.getById.mockResolvedValue({
      id: "workspace-1",
      companyId: "company-1",
      sourceIssueId: "issue-1",
    });
    mockExecutionWorktreeService.reconcileExecutionWorkspaceBranch.mockResolvedValue({
      workspace: {
        id: "workspace-1",
        companyId: "company-1",
        sourceIssueId: "issue-1",
        branchName: "feature/recorded",
      },
      inspection: {
        fingerprint: "workspace_incoherence:v1:sha256:dirty",
        worktreePath: "/tmp/worktree",
        repoRoot: "/tmp/repo",
        fromBranch: "feature/recorded",
        toBranch: "feature/live",
        fromSha: "1111111",
        toSha: "2222222",
        ancestryVerdict: "diverged",
        cleanliness: "dirty",
        statusEntryCount: 2,
        plainLanguageReason: "dirty live branch",
      },
      recoveryAction: {
        id: "recovery-1",
      },
      auditCommentId: "comment-1",
      rescueRef: null,
      restoredSourceIssue: {
        id: "issue-1",
        companyId: "company-1",
        status: "in_review",
        assigneeAgentId: "reviewer-agent-1",
      },
      sourceIssueStatusChanged: true,
    });

    const res = await request(createApp())
      .post("/api/execution-workspaces/workspace-1/reconcile-branch")
      .send({ mode: "quarantine_restore" });

    expect(res.status).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      details: expect.objectContaining({
        sourceIssueStatus: "in_review",
      }),
    }));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith("reviewer-agent-1", expect.objectContaining({
      reason: "issue_recovery_action_restored",
      payload: expect.objectContaining({
        issueId: "issue-1",
        mutation: "execution_workspace_quarantine_restore",
      }),
      contextSnapshot: expect.objectContaining({
        issueId: "issue-1",
        wakeReason: "issue_recovery_action_restored",
        source: "execution_workspace.quarantine_restore",
      }),
    }));
  });

  it("returns 409 and skips destructive cleanup when the archive hits a reopen-pending workspace", async () => {
    // A reopen published the workspace active while its source issue is still
    // terminal. The archive control must return 409 before any lease teardown,
    // runtime-service stop, or artifact cleanup, so it never removes the rebuilt
    // worktree.
    mockExecutionWorktreeService.getById.mockResolvedValue({
      id: "workspace-1",
      companyId: "company-1",
      sourceIssueId: "issue-1",
      status: "active",
      mode: "isolated_workspace",
    });
    mockExecutionWorktreeService.getCloseReadiness.mockResolvedValue({
      state: "ready",
      blockingReasons: [],
    });
    mockExecutionWorktreeService.archiveWorkspaceUnderLifecycleLock.mockResolvedValue({
      outcome: "reopen_pending",
    });

    const res = await request(createApp())
      .patch("/api/execution-workspaces/workspace-1")
      .send({ status: "archived" });

    expect(res.status).toBe(409);
    expect(mockExecutionWorktreeService.archiveWorkspaceUnderLifecycleLock).toHaveBeenCalledTimes(1);
    // The destruction fence never runs, so no worktree is removed.
    expect(mockExecutionWorktreeService.fenceClosedWorkspaceDestruction).not.toHaveBeenCalled();
  });

  it("destroys the reusable sandbox leases inside the destruction fence when the archive wins", async () => {
    // The archive wins the lifecycle race. The fence runs the destroy callback,
    // so the reusable sandbox lease teardown runs with the worktree teardown.
    const archivedWorkspace = {
      id: "workspace-1",
      companyId: "company-1",
      sourceIssueId: "issue-1",
      status: "archived",
      mode: "isolated_workspace",
      projectWorkspaceId: null,
      projectId: null,
      cwd: "/tmp/worktree",
    };
    mockExecutionWorktreeService.getById.mockResolvedValue({
      ...archivedWorkspace,
      status: "active",
    });
    mockExecutionWorktreeService.getCloseReadiness.mockResolvedValue({
      state: "ready",
      blockingReasons: [],
    });
    mockExecutionWorktreeService.archiveWorkspaceUnderLifecycleLock.mockResolvedValue({
      outcome: "archived",
      workspace: archivedWorkspace,
      capturedGeneration: 3,
    });
    mockExecutionWorktreeService.fenceClosedWorkspaceDestruction.mockImplementation(
      async ({ destroy }: { destroy: () => Promise<unknown> }) => ({
        skippedReopened: false,
        result: await destroy(),
      }),
    );

    const res = await request(createApp())
      .patch("/api/execution-workspaces/workspace-1")
      .send({ status: "archived" });

    expect(res.status).toBe(200);
    // The lease teardown runs inside the fence, so it uses the closed-workspace
    // failure reason and targets the archived row.
    expect(mockEnvironmentRuntimeService.destroyReusableSandboxLeases).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        executionWorkspaceId: "workspace-1",
        failureReason: "execution_workspace_closed",
      }),
    );
  });

  it("keeps the reusable sandbox leases when a reopen makes the fence skip the archive teardown", async () => {
    // A reopen raised the lifecycle generation after the archive captured its
    // own generation. The fence skips the destroy callback and keeps the
    // reopened row, so the lease teardown must not run. Before the fix the lease
    // teardown ran before the fence, so an overlapping reopen lost its leases.
    const archivedWorkspace = {
      id: "workspace-1",
      companyId: "company-1",
      sourceIssueId: "issue-1",
      status: "archived",
      mode: "isolated_workspace",
      projectWorkspaceId: null,
      projectId: null,
      cwd: "/tmp/worktree",
    };
    mockExecutionWorktreeService.getById.mockResolvedValue({
      ...archivedWorkspace,
      status: "active",
    });
    mockExecutionWorktreeService.getCloseReadiness.mockResolvedValue({
      state: "ready",
      blockingReasons: [],
    });
    mockExecutionWorktreeService.archiveWorkspaceUnderLifecycleLock.mockResolvedValue({
      outcome: "archived",
      workspace: archivedWorkspace,
      capturedGeneration: 3,
    });
    // The fence detects the reopen and never runs the destroy callback.
    mockExecutionWorktreeService.fenceClosedWorkspaceDestruction.mockResolvedValue({
      skippedReopened: true,
    });

    const res = await request(createApp())
      .patch("/api/execution-workspaces/workspace-1")
      .send({ status: "archived" });

    expect(res.status).toBe(200);
    expect(mockExecutionWorktreeService.fenceClosedWorkspaceDestruction).toHaveBeenCalledTimes(1);
    // The reopen keeps its reusable leases because the fence skipped the destroy.
    expect(mockEnvironmentRuntimeService.destroyReusableSandboxLeases).not.toHaveBeenCalled();
  });
});
