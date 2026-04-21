import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

function registerServiceMocks() {
  vi.doMock("../services/index.js", () => ({
    executionWorkspaceService: () => mockExecutionWorkspaceService,
    logActivity: vi.fn(async () => undefined),
    workspaceOperationService: () => mockWorkspaceOperationService,
  }));
  vi.doMock("../routes/workspace-runtime-service-authz.js", () => ({
    assertCanManageExecutionWorkspaceRuntimeServices: vi.fn(async () => undefined),
    assertCanManageProjectWorkspaceRuntimeServices: vi.fn(async () => undefined),
  }));
  vi.doMock("../services/workspace-runtime.js", () => ({
    startRuntimeServicesForWorkspaceControl: vi.fn(async () => undefined),
    stopRuntimeServicesForExecutionWorkspace: vi.fn(async () => undefined),
    normalizeAdapterManagedRuntimeServices: vi.fn(async () => []),
    buildWorkspaceRuntimeDesiredStatePatch: vi.fn(() => ({ desiredState: "stopped", serviceStates: null })),
    mergeExecutionWorkspaceConfig: vi.fn((meta: unknown, patch: unknown) => patch),
    listConfiguredRuntimeServiceEntries: vi.fn(() => []),
    resolveShell: vi.fn(() => "/bin/sh"),
  }));
  vi.doMock("../services/execution-workspaces.js", () => ({
    mergeExecutionWorkspaceConfig: vi.fn((meta: unknown, patch: unknown) => patch),
    readExecutionWorkspaceConfig: vi.fn(() => null),
  }));
}

async function createApp() {
  const [{ executionWorkspaceRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/execution-workspaces.js")>("../routes/execution-workspaces.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
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

describe("execution workspace routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/execution-workspaces.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerServiceMocks();
    vi.resetAllMocks();
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

  it("returns 422 when targeting a runtime service by id whose configIndex is null", async () => {
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "ws-1",
      companyId: "company-1",
      cwd: "/workspace/path",
      projectWorkspaceId: null,
      projectId: null,
      sourceIssueId: null,
      metadata: null,
      config: null,
      runtimeServices: [
        { id: "11111111-1111-4111-8111-111111111111", configIndex: null, status: "running" },
      ],
    });

    const res = await request(await createApp())
      .post("/api/execution-workspaces/ws-1/runtime-services/stop")
      .send({ runtimeServiceId: "11111111-1111-4111-8111-111111111111" });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/no config position/);
  });

  it("uses summary mode for lightweight workspace lookups", async () => {
    const res = await request(await createApp())
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
});
