import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { executionWorkspaceRoutes } from "../routes/execution-workspaces.js";
import { ExecutionWorkspaceAdoptionError } from "../services/execution-workspaces.js";

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  list: vi.fn(),
  listOverview: vi.fn(),
  listSummaries: vi.fn(),
  getById: vi.fn(),
  getCloseReadiness: vi.fn(),
  adoptGitWorktree: vi.fn(),
  rollbackAdoption: vi.fn(),
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
const mockCleanupExecutionWorkspaceArtifacts = vi.hoisted(() => vi.fn());
const mockStopRuntimeServicesForExecutionWorkspace = vi.hoisted(() => vi.fn(async () => undefined));
const mockDestroyReusableSandboxLeases = vi.hoisted(() => vi.fn(async () => []));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  heartbeatService: () => mockHeartbeatService,
  logActivity: mockLogActivity,
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

vi.mock("../services/workspace-runtime.js", () => ({
  buildWorkspaceRuntimeDesiredStatePatch: vi.fn(),
  cleanupExecutionWorkspaceArtifacts: mockCleanupExecutionWorkspaceArtifacts,
  ensurePersistedExecutionWorkspaceAvailable: vi.fn(),
  listConfiguredRuntimeServiceEntries: vi.fn(),
  runWorkspaceJobForControl: vi.fn(),
  startRuntimeServicesForWorkspaceControl: vi.fn(),
  stopRuntimeServicesForExecutionWorkspace: mockStopRuntimeServicesForExecutionWorkspace,
}));

vi.mock("../services/environment-runtime.js", () => ({
  environmentRuntimeService: () => ({
    destroyReusableSandboxLeases: mockDestroyReusableSandboxLeases,
  }),
}));

function createApp(actor: Record<string, unknown> = {
  type: "board",
  userId: "local-board",
  companyIds: ["company-1"],
  source: "session",
  isInstanceAdmin: false,
}, db: unknown = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", executionWorkspaceRoutes(db as any));
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
    mockExecutionWorkspaceService.adoptGitWorktree.mockResolvedValue({
      workspace: { id: "workspace-1", companyId: "company-1", projectId: "11111111-1111-4111-8111-111111111111" },
      issue: null,
      inspection: { status: "accepted", reasonCode: null },
      operation: { id: "operation-1" },
    });
    mockExecutionWorkspaceService.rollbackAdoption.mockResolvedValue({
      id: "workspace-1",
      companyId: "company-1",
      projectId: "11111111-1111-4111-8111-111111111111",
      status: "archived",
    });
    mockExecutionWorkspaceService.reconcileExecutionWorkspaceBranch.mockResolvedValue(null);
    mockHeartbeatService.wakeup.mockResolvedValue(null);
    mockCleanupExecutionWorkspaceArtifacts.mockResolvedValue({
      cleanedPath: "/tmp/worktree",
      cleaned: true,
      warnings: [],
    });
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

  it("rejects adoption validation failures with redacted activity when company scope is established", async () => {
    const res = await request(createApp())
      .post("/api/companies/company-1/execution-workspaces/adopt-git-worktree")
      .send({
        projectId: "11111111-1111-4111-8111-111111111111",
        projectWorkspaceId: "22222222-2222-4222-8222-222222222222",
        sourceIssueId: "33333333-3333-4333-8333-333333333333",
        cwd: "/tmp/worktree; rm -rf /",
        expectedBranch: "refs/heads/feature/adopt",
        expectedHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        expectedUpstream: "origin/feature/adopt",
        name: "feature/adopt",
      });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ reasonCode: "unsafe_input" });
    expect(mockExecutionWorkspaceService.adoptGitWorktree).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "execution_workspace.adoption_rejected",
      entityType: "company",
      entityId: "company-1",
      details: { reasonCode: "unsafe_input" },
    }));
  });

  it("allows board adoption and delegates exact validated input", async () => {
    const body = {
      projectId: "11111111-1111-4111-8111-111111111111",
      projectWorkspaceId: "22222222-2222-4222-8222-222222222222",
      sourceIssueId: "33333333-3333-4333-8333-333333333333",
      cwd: "/tmp/worktree",
      expectedBranch: "refs/heads/feature/adopt",
      expectedHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      expectedUpstream: "origin/feature/adopt",
      expectedRepoUrl: "git@example.com:paperclip/repo.git",
      name: "feature/adopt",
    };

    const res = await request(createApp())
      .post("/api/companies/company-1/execution-workspaces/adopt-git-worktree")
      .send(body);

    expect(res.status).toBe(201);
    expect(mockAccessService.decide).toHaveBeenCalledWith(expect.objectContaining({
      action: "execution_workspaces:adopt",
      resource: { type: "project", companyId: "company-1", projectId: body.projectId },
      scope: { projectId: body.projectId },
    }));
    expect(mockExecutionWorkspaceService.adoptGitWorktree).toHaveBeenCalledWith("company-1", body, {
      actorType: "user",
      actorId: "local-board",
      agentId: null,
      runId: null,
    }, null);
  });

  it("returns a redacted cross-scope response when adoption source revalidation fails", async () => {
    mockExecutionWorkspaceService.adoptGitWorktree.mockRejectedValue(
      new ExecutionWorkspaceAdoptionError("cross_scope_not_found", 404),
    );

    const res = await request(createApp())
      .post("/api/companies/company-1/execution-workspaces/adopt-git-worktree")
      .send({
        projectId: "11111111-1111-4111-8111-111111111111",
        projectWorkspaceId: "22222222-2222-4222-8222-222222222222",
        sourceIssueId: "33333333-3333-4333-8333-333333333333",
        cwd: "/tmp/worktree",
        expectedBranch: "refs/heads/feature/adopt",
        expectedHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        expectedUpstream: "origin/feature/adopt",
        name: "feature/adopt",
      });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: "Execution workspace adoption rejected",
      reasonCode: "cross_scope_not_found",
    });
    expect(res.body).not.toHaveProperty("workspace");
    expect(res.body).not.toHaveProperty("issue");
    expect(res.body).not.toHaveProperty("inspection");
  });

  it("requires independent issue mutation authorization when binding an adopted workspace", async () => {
    const bindIssueId = "44444444-4444-4444-8444-444444444444";
    const projectId = "11111111-1111-4111-8111-111111111111";
    const db = {
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            limit: async () => [{
              id: bindIssueId,
              companyId: "company-1",
              projectId,
              parentId: null,
              assigneeAgentId: "other-agent",
              assigneeUserId: null,
              status: "todo",
              executionPolicy: null,
              originKind: "manual",
              originId: null,
            }],
          }),
        }),
      })),
    };

    const body = {
      projectId,
      projectWorkspaceId: "22222222-2222-4222-8222-222222222222",
      sourceIssueId: "33333333-3333-4333-8333-333333333333",
      bindIssueId,
      cwd: "/tmp/worktree",
      expectedBranch: "refs/heads/feature/adopt",
      expectedHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      expectedUpstream: "origin/feature/adopt",
      name: "feature/adopt",
    };

    const res = await request(createApp(undefined, db))
      .post("/api/companies/company-1/execution-workspaces/adopt-git-worktree")
      .send(body);

    expect(res.status).toBe(201);
    expect(mockAccessService.decide).toHaveBeenCalledWith(expect.objectContaining({
      action: "issue:mutate",
      resource: expect.objectContaining({
        issueId: bindIssueId,
        assigneeAgentId: "other-agent",
        status: "todo",
      }),
    }));
    expect(mockExecutionWorkspaceService.adoptGitWorktree).toHaveBeenCalledWith(
      "company-1",
      body,
      expect.any(Object),
      expect.objectContaining({ id: bindIssueId, assigneeAgentId: "other-agent", status: "todo" }),
    );
  });

  it("denies agent adoption before service inspection when no project grant is available", async () => {
    mockAccessService.decide.mockResolvedValueOnce({
      allowed: false,
      action: "execution_workspaces:adopt",
      reason: "deny_missing_grant",
      explanation: "Missing permission.",
    });

    const res = await request(createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_jwt",
      runId: "run-1",
    }))
      .post("/api/companies/company-1/execution-workspaces/adopt-git-worktree")
      .send({
        projectId: "11111111-1111-4111-8111-111111111111",
        projectWorkspaceId: "22222222-2222-4222-8222-222222222222",
        sourceIssueId: "33333333-3333-4333-8333-333333333333",
        cwd: "/tmp/worktree",
        expectedBranch: "refs/heads/feature/adopt",
        expectedHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        expectedUpstream: "origin/feature/adopt",
        name: "feature/adopt",
      });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ reasonCode: "cross_scope_not_found" });
    expect(mockExecutionWorkspaceService.adoptGitWorktree).not.toHaveBeenCalled();
  });

  it("rolls back adopted records through the record-only rollback service", async () => {
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "workspace-1",
      companyId: "company-1",
      projectId: "11111111-1111-4111-8111-111111111111",
      sourceIssueId: "issue-1",
    });

    const res = await request(createApp())
      .post("/api/execution-workspaces/workspace-1/rollback-adoption")
      .send({ reason: "operator rollback" });

    expect(res.status).toBe(200);
    expect(mockExecutionWorkspaceService.rollbackAdoption).toHaveBeenCalledWith("workspace-1", {
      actorType: "user",
      actorId: "local-board",
      agentId: null,
      runId: null,
    }, "operator rollback", null, null);
    expect(mockExecutionWorkspaceService.update).not.toHaveBeenCalled();
  });

  it("requires independent issue mutation authorization before rollback", async () => {
    const bindIssueId = "44444444-4444-4444-8444-444444444444";
    const projectId = "11111111-1111-4111-8111-111111111111";
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "workspace-1",
      companyId: "company-1",
      projectId,
      metadata: { adoption: { boundIssueId: "44444444-4444-4444-8444-444444444444" } },
    });
    mockAccessService.decide
      .mockResolvedValueOnce({ allowed: true, action: "execution_workspaces:adopt", reason: "allow_test" })
      .mockResolvedValueOnce({ allowed: false, action: "issue:mutate", reason: "deny_test" });
    const db = {
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            limit: async () => [{
              id: bindIssueId,
              parentId: null,
              assigneeAgentId: "other-agent",
              assigneeUserId: null,
              status: "todo",
              executionPolicy: null,
              originKind: "manual",
              originId: null,
            }],
          }),
        }),
      })),
    };

    const res = await request(createApp(undefined, db))
      .post("/api/execution-workspaces/workspace-1/rollback-adoption")
      .send({ reason: "operator rollback" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ reasonCode: "unauthorized" });
    expect(mockAccessService.decide).toHaveBeenLastCalledWith(expect.objectContaining({
      action: "issue:mutate",
      resource: expect.objectContaining({ issueId: bindIssueId }),
    }));
    expect(mockExecutionWorkspaceService.rollbackAdoption).not.toHaveBeenCalled();
  });

  it("returns a stable conflict when an unbound adopted workspace was already rolled back", async () => {
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "workspace-1",
      companyId: "company-1",
      projectId: "11111111-1111-4111-8111-111111111111",
      status: "archived",
      cleanupReason: "adoption_rollback",
      metadata: {
        adoption: { boundIssueId: null },
        adoptionRollback: { version: 1, reason: "first rollback" },
      },
    });
    mockExecutionWorkspaceService.rollbackAdoption.mockRejectedValue(
      new ExecutionWorkspaceAdoptionError("workspace_conflict", 409),
    );

    const res = await request(createApp())
      .post("/api/execution-workspaces/workspace-1/rollback-adoption")
      .send({ reason: "operator rollback" });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: "Execution workspace adoption rollback rejected",
      reasonCode: "workspace_conflict",
    });
    expect(mockExecutionWorkspaceService.rollbackAdoption).toHaveBeenCalledWith("workspace-1", {
      actorType: "user",
      actorId: "local-board",
      agentId: null,
      runId: null,
    }, "operator rollback", null, null);
  });

  it("returns the stable adoption error shape when rollback targets a non-adopted workspace", async () => {
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "workspace-1",
      companyId: "company-1",
      projectId: "11111111-1111-4111-8111-111111111111",
      status: "active",
      metadata: null,
    });
    mockExecutionWorkspaceService.rollbackAdoption.mockRejectedValue(
      new ExecutionWorkspaceAdoptionError("workspace_conflict", 409),
    );

    const res = await request(createApp())
      .post("/api/execution-workspaces/workspace-1/rollback-adoption")
      .send({ reason: "operator rollback" });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: "Execution workspace adoption rollback rejected",
      reasonCode: "workspace_conflict",
    });
  });

  it("archives an adopted workspace record without scheduling artifact cleanup", async () => {
    const existing = {
      id: "workspace-1",
      companyId: "company-1",
      projectId: "11111111-1111-4111-8111-111111111111",
      projectWorkspaceId: "22222222-2222-4222-8222-222222222222",
      sourceIssueId: "33333333-3333-4333-8333-333333333333",
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Adopted workspace",
      status: "active",
      cwd: "/tmp/worktree",
      repoUrl: "git@example.com:paperclip/repo.git",
      baseRef: "main",
      branchName: "feature/adopted",
      providerType: "git_worktree",
      providerRef: "/tmp/worktree",
      metadata: {
        createdByRuntime: false,
        ownsGitArtifacts: false,
        config: {
          cleanupCommand: "node ./scripts/cleanup.js",
          teardownCommand: "node ./scripts/teardown.js",
        },
      },
    };
    const archived = {
      ...existing,
      status: "archived",
      closedAt: new Date(),
    };
    mockExecutionWorkspaceService.getById.mockResolvedValue(existing);
    mockExecutionWorkspaceService.getCloseReadiness.mockResolvedValue({
      workspaceId: existing.id,
      state: "ready",
      blockingReasons: [],
      warnings: [],
      plannedActions: [{
        kind: "archive_record",
        label: "Archive workspace record",
        description: "Record only",
        command: null,
      }],
    });
    mockExecutionWorkspaceService.update.mockResolvedValue(archived);

    const res = await request(createApp())
      .patch(`/api/execution-workspaces/${existing.id}`)
      .send({ status: "archived" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("archived");
    expect(mockExecutionWorkspaceService.update).toHaveBeenCalledWith(existing.id, expect.objectContaining({
      status: "archived",
      cleanupReason: null,
    }));
    expect(mockDestroyReusableSandboxLeases).toHaveBeenCalledWith({
      companyId: existing.companyId,
      executionWorkspaceId: existing.id,
      failureReason: "execution_workspace_closed",
    });
    expect(mockStopRuntimeServicesForExecutionWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      executionWorkspaceId: existing.id,
      workspaceCwd: existing.cwd,
    }));
    expect(mockCleanupExecutionWorkspaceArtifacts).not.toHaveBeenCalled();
  });

  it("rejects ownership escalation before archive and keeps adopted cleanup record-only", async () => {
    const existing = {
      id: "workspace-1",
      companyId: "company-1",
      projectId: "11111111-1111-4111-8111-111111111111",
      projectWorkspaceId: "22222222-2222-4222-8222-222222222222",
      sourceIssueId: "33333333-3333-4333-8333-333333333333",
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Adopted workspace",
      status: "active",
      closedAt: null,
      cwd: "/tmp/operator-worktree",
      repoUrl: "ssh://git@example.com/paperclip/repo",
      baseRef: "origin/main",
      branchName: "feature/adopted",
      providerType: "git_worktree",
      providerRef: "/tmp/operator-worktree",
      metadata: {
        createdByRuntime: false,
        ownsGitArtifacts: false,
        fullBranchRef: "refs/heads/feature/adopted",
        adoption: {
          version: 1,
          immutableFingerprint: "execution_workspace_adoption:v1:sha256:original",
        },
      },
    };
    mockExecutionWorkspaceService.getById.mockResolvedValue(existing);
    mockExecutionWorkspaceService.getCloseReadiness.mockResolvedValue({
      workspaceId: existing.id,
      state: "ready",
      blockingReasons: [],
      warnings: [],
      plannedActions: [{ kind: "archive_record", command: null }],
    });
    mockExecutionWorkspaceService.update.mockImplementation(async (_id, patch) => ({ ...existing, ...patch }));

    const escalation = await request(createApp())
      .patch(`/api/execution-workspaces/${existing.id}`)
      .send({
        metadata: {
          ...existing.metadata,
          ownsGitArtifacts: true,
        },
      });

    expect(escalation.status).toBe(409);
    expect(escalation.body).toEqual({
      error: "Adopted execution workspace identity is immutable",
      reasonCode: "adopted_workspace_identity_immutable",
    });
    expect(mockExecutionWorkspaceService.update).not.toHaveBeenCalled();
    expect(mockDestroyReusableSandboxLeases).not.toHaveBeenCalled();
    expect(mockStopRuntimeServicesForExecutionWorkspace).not.toHaveBeenCalled();
    expect(mockCleanupExecutionWorkspaceArtifacts).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();

    const archive = await request(createApp())
      .patch(`/api/execution-workspaces/${existing.id}`)
      .send({ status: "archived" });

    expect(archive.status).toBe(200);
    expect(mockExecutionWorkspaceService.update).toHaveBeenCalledTimes(1);
    expect(mockCleanupExecutionWorkspaceArtifacts).not.toHaveBeenCalled();
  });

  it.each([
    ["adoption metadata removal", { metadata: null }],
    ["adoption fingerprint rewrite", {
      metadata: {
        createdByRuntime: false,
        ownsGitArtifacts: false,
        fullBranchRef: "refs/heads/feature/adopted",
        adoption: {
          version: 1,
          immutableFingerprint: "execution_workspace_adoption:v1:sha256:rewritten",
        },
      },
    }],
    ["cwd mutation", { cwd: "/tmp/other" }],
    ["provider ref mutation", { providerRef: "/tmp/other" }],
    ["repository mutation", { repoUrl: "ssh://git@example.com/other/repo" }],
    ["branch mutation", { branchName: "feature/other" }],
    ["base ref mutation", { baseRef: "origin/other" }],
  ])("rejects adopted workspace %s without side effects", async (_label, patch) => {
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "workspace-1",
      companyId: "company-1",
      status: "active",
      closedAt: null,
      cwd: "/tmp/operator-worktree",
      repoUrl: "ssh://git@example.com/paperclip/repo",
      baseRef: "origin/main",
      branchName: "feature/adopted",
      providerRef: "/tmp/operator-worktree",
      metadata: {
        createdByRuntime: false,
        ownsGitArtifacts: false,
        fullBranchRef: "refs/heads/feature/adopted",
        adoption: {
          version: 1,
          immutableFingerprint: "execution_workspace_adoption:v1:sha256:original",
        },
      },
    });

    const res = await request(createApp())
      .patch("/api/execution-workspaces/workspace-1")
      .send(patch);

    expect(res.status).toBe(409);
    expect(res.body.reasonCode).toBe("adopted_workspace_identity_immutable");
    expect(mockExecutionWorkspaceService.update).not.toHaveBeenCalled();
    expect(mockDestroyReusableSandboxLeases).not.toHaveBeenCalled();
    expect(mockStopRuntimeServicesForExecutionWorkspace).not.toHaveBeenCalled();
    expect(mockCleanupExecutionWorkspaceArtifacts).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("preserves adopted metadata for allowlisted name and config updates", async () => {
    const existing = {
      id: "workspace-1",
      companyId: "company-1",
      status: "active",
      closedAt: null,
      metadata: {
        createdByRuntime: false,
        ownsGitArtifacts: false,
        fullBranchRef: "refs/heads/feature/adopted",
        adoption: {
          version: 1,
          immutableFingerprint: "execution_workspace_adoption:v1:sha256:original",
        },
      },
    };
    mockExecutionWorkspaceService.getById.mockResolvedValue(existing);
    mockExecutionWorkspaceService.update.mockImplementation(async (_id, patch) => ({ ...existing, ...patch }));

    const res = await request(createApp())
      .patch(`/api/execution-workspaces/${existing.id}`)
      .send({
        name: "Updated label",
        config: { provisionCommand: "pnpm install" },
      });

    expect(res.status).toBe(200);
    expect(mockExecutionWorkspaceService.update).toHaveBeenCalledWith(existing.id, {
      name: "Updated label",
      metadata: expect.objectContaining({
        ...existing.metadata,
        config: expect.objectContaining({ provisionCommand: "pnpm install" }),
      }),
    });
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["adoption", { version: 1, immutableFingerprint: "execution_workspace_adoption:v1:sha256:forged" }],
    ["adoptionRollback", { version: 1, reason: "forged" }],
    ["fullBranchRef", "refs/heads/feature/forged"],
    ["ownsGitArtifacts", true],
    ["createdByRuntime", false],
  ])("rejects forged server-owned %s metadata on a normal workspace before side effects", async (key, value) => {
    const existing = {
      id: "workspace-1",
      companyId: "company-1",
      status: "active",
      metadata: { runtimeNote: "ordinary" },
    };
    mockExecutionWorkspaceService.getById.mockResolvedValue(existing);

    const res = await request(createApp())
      .patch(`/api/execution-workspaces/${existing.id}`)
      .send({
        name: "Attempted forged adoption",
        metadata: {
          ...existing.metadata,
          runtimeNote: "still ordinary",
          [key]: value,
        },
      });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: "Execution workspace server-owned metadata is immutable",
      reasonCode: "execution_workspace_server_owned_metadata_immutable",
      protectedKeys: [key],
    });
    expect(mockExecutionWorkspaceService.update).not.toHaveBeenCalled();
    expect(mockDestroyReusableSandboxLeases).not.toHaveBeenCalled();
    expect(mockStopRuntimeServicesForExecutionWorkspace).not.toHaveBeenCalled();
    expect(mockCleanupExecutionWorkspaceArtifacts).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("keeps ordinary runtime-owned workspace updates valid", async () => {
    const existing = {
      id: "workspace-1",
      companyId: "company-1",
      status: "active",
      cwd: "/tmp/runtime-worktree",
      providerRef: "/tmp/runtime-worktree",
      metadata: {
        createdByRuntime: true,
        ownsGitArtifacts: true,
      },
    };
    mockExecutionWorkspaceService.getById.mockResolvedValue(existing);
    mockExecutionWorkspaceService.update.mockImplementation(async (_id, patch) => ({ ...existing, ...patch }));

    const res = await request(createApp())
      .patch(`/api/execution-workspaces/${existing.id}`)
      .send({
        cwd: "/tmp/runtime-worktree-moved",
        providerRef: "/tmp/runtime-worktree-moved",
        metadata: {
          createdByRuntime: true,
          ownsGitArtifacts: true,
          runtimeNote: "refreshed",
        },
      });

    expect(res.status).toBe(200);
    expect(mockExecutionWorkspaceService.update).toHaveBeenCalledWith(existing.id, {
      cwd: "/tmp/runtime-worktree-moved",
      providerRef: "/tmp/runtime-worktree-moved",
      metadata: {
        createdByRuntime: true,
        ownsGitArtifacts: true,
        runtimeNote: "refreshed",
      },
    });
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
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
});
