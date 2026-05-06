import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { executionWorkspaceRoutes } from "../routes/execution-workspaces.js";

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  list: vi.fn(),
  listSummaries: vi.fn(),
  getById: vi.fn(),
  getCloseReadiness: vi.fn(),
  update: vi.fn(),
}));

const mockWorkspaceOperationService = vi.hoisted(() => ({
  listForExecutionWorkspace: vi.fn(),
  createRecorder: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockCleanupExecutionWorkspaceArtifacts = vi.hoisted(() => vi.fn());
const mockStopRuntimeServicesForExecutionWorkspace = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  logActivity: mockLogActivity,
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

vi.mock("../services/workspace-runtime.js", () => ({
  buildWorkspaceRuntimeDesiredStatePatch: vi.fn(),
  cleanupExecutionWorkspaceArtifacts: mockCleanupExecutionWorkspaceArtifacts,
  ensurePersistedExecutionWorkspaceAvailable: vi.fn(),
  listConfiguredRuntimeServiceEntries: vi.fn(() => []),
  runWorkspaceJobForControl: vi.fn(),
  startRuntimeServicesForWorkspaceControl: vi.fn(),
  stopRuntimeServicesForExecutionWorkspace: mockStopRuntimeServicesForExecutionWorkspace,
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
  app.use("/api", executionWorkspaceRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe.sequential("execution workspace routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecutionWorkspaceService.list.mockResolvedValue([]);
    mockExecutionWorkspaceService.listSummaries.mockResolvedValue([
      {
        id: "workspace-1",
        name: "Alpha",
        mode: "isolated_workspace",
        projectWorkspaceId: null,
      },
    ]);
    mockExecutionWorkspaceService.getById.mockResolvedValue(null);
    mockExecutionWorkspaceService.getCloseReadiness.mockResolvedValue(null);
    mockExecutionWorkspaceService.update.mockResolvedValue(null);
    mockWorkspaceOperationService.createRecorder.mockReturnValue({});
    mockCleanupExecutionWorkspaceArtifacts.mockResolvedValue({ cleaned: true, warnings: [] });
    mockStopRuntimeServicesForExecutionWorkspace.mockResolvedValue(undefined);
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

  it("persists close snapshot and cleanup_failed evidence when cleanup is incomplete", async () => {
    const existingWorkspace = {
      id: "workspace-1",
      companyId: "company-1",
      projectId: null,
      projectWorkspaceId: null,
      sourceIssueId: null,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Workspace",
      status: "active",
      cwd: "/tmp/workspace",
      repoUrl: null,
      baseRef: "main",
      branchName: "feature/test",
      providerType: "git_worktree",
      providerRef: "/tmp/workspace",
      derivedFromExecutionWorkspaceId: null,
      lastUsedAt: new Date(),
      openedAt: new Date(),
      closedAt: null,
      cleanupEligibleAt: null,
      cleanupReason: null,
      config: null,
      metadata: { createdByRuntime: true },
      runtimeServices: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const archivedWorkspace = {
      ...existingWorkspace,
      status: "archived",
      closedAt: new Date(),
      metadata: {
        createdByRuntime: true,
        closeSnapshot: {
          version: 1,
          cleanupStatus: "pending",
        },
      },
    };
    const failedCleanupWorkspace = {
      ...archivedWorkspace,
      status: "cleanup_failed",
      cleanupReason: "leftover worktree",
      metadata: {
        createdByRuntime: true,
        closeSnapshot: {
          version: 1,
          cleanupStatus: "incomplete",
          cleanupWarnings: ["leftover worktree"],
          cleaned: false,
        },
      },
    };

    mockExecutionWorkspaceService.getById.mockResolvedValue(existingWorkspace);
    mockExecutionWorkspaceService.getCloseReadiness.mockResolvedValue({
      workspaceId: "workspace-1",
      state: "ready",
      blockingReasons: [],
      warnings: [],
      linkedIssues: [],
      plannedActions: [{ kind: "archive_record" }],
      isDestructiveCloseAllowed: true,
      isSharedWorkspace: false,
      isProjectPrimaryWorkspace: false,
      git: null,
      runtimeServices: [],
    });
    mockExecutionWorkspaceService.update
      .mockResolvedValueOnce(archivedWorkspace)
      .mockResolvedValueOnce(failedCleanupWorkspace);
    mockCleanupExecutionWorkspaceArtifacts.mockResolvedValue({
      cleaned: false,
      warnings: ["leftover worktree"],
    });

    const res = await request(createApp())
      .patch("/api/execution-workspaces/workspace-1")
      .send({ status: "archived" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cleanup_failed");
    expect(mockExecutionWorkspaceService.update).toHaveBeenNthCalledWith(
      1,
      "workspace-1",
      expect.objectContaining({
        status: "archived",
        metadata: expect.objectContaining({
          closeSnapshot: expect.objectContaining({
            cleanupStatus: "pending",
            statusBeforeClose: "active",
          }),
        }),
      }),
    );
    expect(mockExecutionWorkspaceService.update).toHaveBeenNthCalledWith(
      2,
      "workspace-1",
      expect.objectContaining({
        status: "cleanup_failed",
        cleanupReason: "leftover worktree",
        metadata: expect.objectContaining({
          closeSnapshot: expect.objectContaining({
            cleanupStatus: "incomplete",
            cleanupWarnings: ["leftover worktree"],
            cleaned: false,
          }),
        }),
      }),
    );
  });
});
