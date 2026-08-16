import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { conflict } from "../errors.js";
import { executionWorkspaceRoutes } from "../routes/execution-workspaces.js";
import { attachWorkspaceOperationFailureEvidence } from "../services/workspace-operations.js";

const mockExecutionWorkspaceService = vi.hoisted(() => ({
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
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  heartbeatService: () => mockHeartbeatService,
  logActivity: mockLogActivity,
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

vi.mock("../services/environment-runtime.js", () => ({
  environmentRuntimeService: () => mockEnvironmentRuntimeService,
}));

const mockWorkspaceRuntimeTeardown = vi.hoisted(() => ({
  stopRuntimeServicesForExecutionWorkspace: vi.fn(async () => undefined),
  cleanupExecutionWorkspaceArtifacts: vi.fn(async () => ({ cleaned: true, warnings: [] as string[] })),
}));

vi.mock("../services/workspace-runtime.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/workspace-runtime.js")>();
  return {
    ...actual,
    stopRuntimeServicesForExecutionWorkspace:
      mockWorkspaceRuntimeTeardown.stopRuntimeServicesForExecutionWorkspace,
    cleanupExecutionWorkspaceArtifacts: mockWorkspaceRuntimeTeardown.cleanupExecutionWorkspaceArtifacts,
  };
});

vi.mock("../routes/workspace-runtime-authz.js", () => ({
  assertCanManageExecutionWorkspaceRuntimeServices: vi.fn(async () => undefined),
}));

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
    mockExecutionWorkspaceService.list.mockResolvedValue([]);
    mockExecutionWorkspaceService.listOverview.mockResolvedValue({
      items: [],
      total: 0,
      limit: 50,
      offset: 0,
      hasMore: false,
      nextOffset: null,
    });
    mockExecutionWorkspaceService.listSummaries.mockResolvedValue([
      {
        id: "workspace-1",
        name: "Alpha",
        mode: "isolated_workspace",
        projectWorkspaceId: null,
      },
    ]);
    mockExecutionWorkspaceService.getById.mockResolvedValue(null);
    mockExecutionWorkspaceService.reconcileExecutionWorkspaceBranch.mockResolvedValue(null);
    mockWorkspaceOperationService.createRecorder.mockReturnValue({
      recordOperation: vi.fn(),
    });
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
    expect(mockExecutionWorkspaceService.listSummaries).toHaveBeenCalledWith("company-1", {
      projectId: undefined,
      projectWorkspaceId: undefined,
      issueId: undefined,
      status: undefined,
      reuseEligible: true,
    });
    expect(mockExecutionWorkspaceService.list).not.toHaveBeenCalled();
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
    expect(mockExecutionWorkspaceService.listOverview).toHaveBeenCalledWith("company-1", {
      status: ["active", "idle"],
      limit: 25,
      offset: 10,
    });
  });

  it("rejects invalid workspace overview pagination", async () => {
    const res = await request(createApp())
      .get("/api/companies/company-1/workspace-overview?limit=1000");

    expect(res.status).toBe(422);
    expect(mockExecutionWorkspaceService.listOverview).not.toHaveBeenCalled();
  });

  it("returns effective inherited runtime config and the current failed service row", async () => {
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "workspace-1",
      companyId: "company-1",
      projectWorkspaceId: "project-workspace-1",
      effectiveRuntimeConfig: {
        workspaceRuntime: { services: [{ name: "web", command: "pnpm dev" }] },
        source: { type: "project_workspace", id: "project-workspace-1" },
        desiredState: "running",
        serviceStates: null,
      },
      runtimeServices: [{
        id: "service-1",
        serviceName: "web",
        status: "failed",
        actualState: "failed",
        desiredState: "running",
        latestFailure: {
          operationId: "operation-1",
          operationLogPath: "/api/workspace-operations/operation-1/log",
          code: "workspace_runtime_start_failed",
          message: "Workspace runtime service failed to start.",
          remediation: "Review the workspace operation log and retry.",
          details: null,
          failedAt: new Date("2026-08-11T12:00:00.000Z"),
        },
      }],
    });

    const res = await request(createApp()).get("/api/execution-workspaces/workspace-1");

    expect(res.status).toBe(200);
    expect(res.body.effectiveRuntimeConfig.source).toEqual({
      type: "project_workspace",
      id: "project-workspace-1",
    });
    expect(res.body.runtimeServices).toEqual([
      expect.objectContaining({
        id: "service-1",
        actualState: "failed",
        desiredState: "running",
        latestFailure: expect.objectContaining({ operationId: "operation-1" }),
      }),
    ]);
  });

  it("does not expose workspace detail across company scope", async () => {
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "workspace-1",
      companyId: "company-1",
    });

    const res = await request(createApp({
      type: "board",
      userId: "other-board",
      companyIds: ["company-2"],
      source: "session",
      isInstanceAdmin: false,
    })).get("/api/execution-workspaces/workspace-1");

    expect(res.status).toBe(404);
  });

  it("returns a safe operation reference when runtime start fails", async () => {
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "workspace-1",
      companyId: "company-1",
      projectId: null,
      projectWorkspaceId: null,
      sourceIssueId: null,
      name: "Runtime failure workspace",
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      cwd: "/tmp/runtime-failure-workspace",
      repoUrl: null,
      baseRef: "master",
      branchName: "runtime-failure",
      providerType: "git_worktree",
      providerRef: "/tmp/runtime-failure-workspace",
      config: {
        workspaceRuntime: { services: [{ name: "web", command: "pnpm dev" }] },
        desiredState: "running",
        serviceStates: null,
      },
      effectiveRuntimeConfig: {
        workspaceRuntime: { services: [{ name: "web", command: "pnpm dev" }] },
        source: { type: "execution_workspace", id: "workspace-1" },
        desiredState: "running",
        serviceStates: null,
      },
      runtimeServices: [],
      metadata: null,
    });
    const operationError = attachWorkspaceOperationFailureEvidence(
      conflict("No safe automatically allocated runtime service port is available.", {
        code: "workspace_runtime_port_allocation_exhausted",
        attemptedPortCount: 10,
        cwd: "/secret/workspace/path",
        remediation: "Configure a different runtime service port.",
      }),
      {
        operationId: "operation-1",
        operationLogPath: "/api/workspace-operations/operation-1/log",
        code: "workspace_runtime_port_allocation_exhausted",
        message: "No safe automatically allocated runtime service port is available.",
        remediation: "Configure a different runtime service port.",
        details: { attemptedPortCount: 10 },
        failedAt: "2026-08-11T12:00:00.000Z",
      },
    );
    mockWorkspaceOperationService.createRecorder.mockReturnValue({
      recordOperation: vi.fn(async () => {
        throw operationError;
      }),
    });

    const res = await request(createApp())
      .post("/api/execution-workspaces/workspace-1/runtime-services/start")
      .send({ workspaceCommandId: "service:web" });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: "No safe automatically allocated runtime service port is available.",
      details: {
        code: "workspace_runtime_port_allocation_exhausted",
        attemptedPortCount: 10,
        remediation: "Configure a different runtime service port.",
        operationId: "operation-1",
        operationLogPath: "/api/workspace-operations/operation-1/log",
        failedAt: "2026-08-11T12:00:00.000Z",
      },
    });
    expect(JSON.stringify(res.body)).not.toContain("/secret/workspace/path");
  });

  it("derives configured service identity when a stop targets only a runtime service id", async () => {
    const runtimeServiceId = "11111111-1111-4111-8111-111111111111";
    const runtimeConfig = {
      services: [
        { name: "web", command: "pnpm dev" },
        { name: "worker", command: "pnpm worker" },
      ],
    };
    const workspace = {
      id: "workspace-1",
      companyId: "company-1",
      projectId: null,
      projectWorkspaceId: null,
      sourceIssueId: null,
      name: "Targeted runtime stop",
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      cwd: "/tmp/targeted-runtime-stop",
      repoUrl: null,
      baseRef: "master",
      branchName: "targeted-runtime-stop",
      providerType: "git_worktree",
      providerRef: "/tmp/targeted-runtime-stop",
      config: {
        workspaceRuntime: runtimeConfig,
        desiredState: "running",
        serviceStates: { "0": "running", "1": "running" },
      },
      effectiveRuntimeConfig: {
        workspaceRuntime: runtimeConfig,
        source: { type: "execution_workspace", id: "workspace-1" },
        desiredState: "running",
        serviceStates: { "0": "running", "1": "running" },
      },
      runtimeServices: [{
        id: runtimeServiceId,
        serviceName: "worker",
        status: "running",
        configIndex: 1,
        workspaceCommandId: "service:worker",
      }],
      metadata: {
        config: {
          workspaceRuntime: runtimeConfig,
          desiredState: "running",
          serviceStates: { "0": "running", "1": "running" },
        },
      },
    };
    mockExecutionWorkspaceService.getById.mockResolvedValue(workspace);
    mockExecutionWorkspaceService.update.mockResolvedValue(workspace);
    const recordOperation = vi.fn(async (input: { run: () => Promise<Record<string, unknown>> }) => ({
      id: "operation-1",
      ...await input.run(),
    }));
    mockWorkspaceOperationService.createRecorder.mockReturnValue({ recordOperation });

    const res = await request(createApp())
      .post("/api/execution-workspaces/workspace-1/runtime-services/stop")
      .send({ runtimeServiceId });

    expect(res.status).toBe(200);
    expect(recordOperation).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        runtimeServiceId,
        serviceIndex: 1,
        workspaceCommandId: "service:worker",
      }),
    }));
    expect(mockWorkspaceRuntimeTeardown.stopRuntimeServicesForExecutionWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeServiceId }),
    );
    expect(mockExecutionWorkspaceService.update).toHaveBeenCalledWith("workspace-1", {
      metadata: expect.objectContaining({
        config: expect.objectContaining({
          desiredState: "running",
          serviceStates: { "0": "running", "1": "stopped" },
        }),
      }),
    });
  });

  it.each([
    ["forward", { mode: "forward" }],
    ["override", { mode: "override", reason: "operator break-glass" }],
    ["quarantine_restore", { mode: "quarantine_restore", reason: "rescue dirty branch" }],
  ])("rejects agent actors for %s branch reconciliation", async (_mode, body) => {
    mockExecutionWorkspaceService.getById.mockResolvedValue({
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
    expect(mockExecutionWorkspaceService.reconcileExecutionWorkspaceBranch).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("logs branch reconciliation activity after the service operation succeeds", async () => {
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "workspace-1",
      companyId: "company-1",
      sourceIssueId: "issue-1",
    });
    mockExecutionWorkspaceService.reconcileExecutionWorkspaceBranch.mockResolvedValue({
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
    expect(mockExecutionWorkspaceService.reconcileExecutionWorkspaceBranch).toHaveBeenCalledWith("workspace-1", {
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
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "workspace-1",
      companyId: "company-1",
      sourceIssueId: "issue-1",
    });
    mockExecutionWorkspaceService.reconcileExecutionWorkspaceBranch.mockResolvedValue({
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
    expect(mockExecutionWorkspaceService.reconcileExecutionWorkspaceBranch).toHaveBeenCalledWith("workspace-1", {
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
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "workspace-1",
      companyId: "company-1",
      sourceIssueId: "issue-1",
    });
    mockExecutionWorkspaceService.reconcileExecutionWorkspaceBranch.mockResolvedValue({
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
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "workspace-1",
      companyId: "company-1",
      sourceIssueId: "issue-1",
      status: "active",
      mode: "isolated_workspace",
    });
    mockExecutionWorkspaceService.getCloseReadiness.mockResolvedValue({
      state: "ready",
      blockingReasons: [],
    });
    mockExecutionWorkspaceService.archiveWorkspaceUnderLifecycleLock.mockResolvedValue({
      outcome: "reopen_pending",
    });

    const res = await request(createApp())
      .patch("/api/execution-workspaces/workspace-1")
      .send({ status: "archived" });

    expect(res.status).toBe(409);
    expect(mockExecutionWorkspaceService.archiveWorkspaceUnderLifecycleLock).toHaveBeenCalledTimes(1);
    // The destruction fence never runs, so no worktree is removed.
    expect(mockExecutionWorkspaceService.fenceClosedWorkspaceDestruction).not.toHaveBeenCalled();
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
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      ...archivedWorkspace,
      status: "active",
    });
    mockExecutionWorkspaceService.getCloseReadiness.mockResolvedValue({
      state: "ready",
      blockingReasons: [],
    });
    mockExecutionWorkspaceService.archiveWorkspaceUnderLifecycleLock.mockResolvedValue({
      outcome: "archived",
      workspace: archivedWorkspace,
      capturedGeneration: 3,
    });
    mockExecutionWorkspaceService.fenceClosedWorkspaceDestruction.mockImplementation(
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
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      ...archivedWorkspace,
      status: "active",
    });
    mockExecutionWorkspaceService.getCloseReadiness.mockResolvedValue({
      state: "ready",
      blockingReasons: [],
    });
    mockExecutionWorkspaceService.archiveWorkspaceUnderLifecycleLock.mockResolvedValue({
      outcome: "archived",
      workspace: archivedWorkspace,
      capturedGeneration: 3,
    });
    // The fence detects the reopen and never runs the destroy callback.
    mockExecutionWorkspaceService.fenceClosedWorkspaceDestruction.mockResolvedValue({
      skippedReopened: true,
    });

    const res = await request(createApp())
      .patch("/api/execution-workspaces/workspace-1")
      .send({ status: "archived" });

    expect(res.status).toBe(200);
    expect(mockExecutionWorkspaceService.fenceClosedWorkspaceDestruction).toHaveBeenCalledTimes(1);
    // The reopen keeps its reusable leases because the fence skipped the destroy.
    expect(mockEnvironmentRuntimeService.destroyReusableSandboxLeases).not.toHaveBeenCalled();
  });
});
