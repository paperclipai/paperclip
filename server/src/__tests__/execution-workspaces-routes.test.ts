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
