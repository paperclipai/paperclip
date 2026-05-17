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
const mockCloseExecutionWorkspace = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  logActivity: mockLogActivity,
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

vi.mock("../services/execution-workspace-closeout.js", () => ({
  closeExecutionWorkspace: mockCloseExecutionWorkspace,
}));

function createApp(db: any = {} as any) {
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
  app.use("/api", executionWorkspaceRoutes(db));
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

  it("keeps shared project-primary archival in archived status when cleanup preserves the project workspace path", async () => {
    const existingWorkspace = {
      id: "workspace-1",
      companyId: "company-1",
      projectId: null,
      projectWorkspaceId: null,
      sourceIssueId: "issue-1",
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Shared primary session",
      status: "active",
      cwd: "/tmp/project-primary",
      repoUrl: null,
      baseRef: null,
      branchName: null,
      providerType: "local_fs",
      providerRef: null,
      derivedFromExecutionWorkspaceId: null,
      lastUsedAt: new Date("2026-04-19T20:00:00.000Z"),
      openedAt: new Date("2026-04-19T20:00:00.000Z"),
      closedAt: null,
      cleanupEligibleAt: null,
      cleanupReason: null,
      config: null,
      metadata: {
        source: "project_primary",
      },
      runtimeServices: [],
      createdAt: new Date("2026-04-19T20:00:00.000Z"),
      updatedAt: new Date("2026-04-19T20:00:00.000Z"),
    };
    const closedAt = new Date("2026-04-19T21:00:00.000Z");
    const cleanupWarning = "Refusing to remove path \"/tmp/project-primary\" because it contains the project workspace.";
    mockExecutionWorkspaceService.getById.mockResolvedValue(existingWorkspace);
    mockCloseExecutionWorkspace.mockResolvedValue({
      outcome: "archived",
      workspace: {
        ...existingWorkspace,
        status: "archived",
        closedAt,
        cleanupReason: cleanupWarning,
      },
      closeReadiness: {
        workspaceId: existingWorkspace.id,
        state: "ready_with_warnings",
        blockingReasons: [],
        warnings: [
          "This shared workspace session points at project workspace infrastructure. Archiving it only removes the session record.",
        ],
        linkedIssues: [],
        plannedActions: [],
        isDestructiveCloseAllowed: true,
        isSharedWorkspace: true,
        isProjectPrimaryWorkspace: true,
        git: null,
        runtimeServices: [],
      },
      cleanupWarnings: [cleanupWarning],
      blockingReasons: [],
      failureReason: null,
    });

    const db = {} as any;
    const res = await request(createApp(db))
      .patch(`/api/execution-workspaces/${existingWorkspace.id}`)
      .send({ status: "archived" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: existingWorkspace.id,
      status: "archived",
      cleanupReason: cleanupWarning,
    });
    expect(mockCloseExecutionWorkspace).toHaveBeenCalledWith(db, {
      executionWorkspaceId: existingWorkspace.id,
      mode: "manual",
      patch: expect.objectContaining({
        status: "archived",
      }),
    });
  });
});
