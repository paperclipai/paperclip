import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockBrabrixSettingsService = vi.hoisted(() => ({
  resolveConfig: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

const mockSyncService = vi.hoisted(() => ({
  isEnabled: vi.fn(),
  fetchNextTask: vi.fn(),
}));

const mockCreateBrabrixAgentSyncService = vi.hoisted(() => vi.fn(() => mockSyncService));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockBrabrixProjectImporter = vi.hoisted(() => ({
  testConnection: vi.fn(),
  listProjects: vi.fn(),
  importProject: vi.fn(),
  syncProject: vi.fn(),
  listImportedProjects: vi.fn(),
  disconnectProject: vi.fn(),
}));
const mockCreateBrabrixProjectImporter = vi.hoisted(() => vi.fn(() => mockBrabrixProjectImporter));

function registerModuleMocks() {
  vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));
  vi.doMock("../services/index.js", () => ({
    brabrixSettingsService: () => mockBrabrixSettingsService,
    createBrabrixAgentSyncService: mockCreateBrabrixAgentSyncService,
    logActivity: mockLogActivity,
  }));
  vi.doMock("../integrations/brabrix/brabrix-project-importer.js", () => ({
    createBrabrixProjectImporter: mockCreateBrabrixProjectImporter,
    BrabrixProjectImporterHttpError: class BrabrixProjectImporterHttpError extends Error {
      details: Record<string, unknown>;
      constructor(message: string, details: Record<string, unknown>) {
        super(message);
        this.name = "BrabrixProjectImporterHttpError";
        this.details = details;
      }
    },
  }));
}

async function createApp(actor: Record<string, unknown>) {
  const [{ brabrixRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/brabrix.js")>("../routes/brabrix.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", brabrixRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("brabrix routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/brabrix.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../integrations/brabrix/brabrix-project-importer.js");
    registerModuleMocks();
    vi.clearAllMocks();

    mockBrabrixSettingsService.resolveConfig.mockResolvedValue({
      apiUrl: "https://api.brabrix.com",
      agentToken: "token-123",
      projectId: "project-1",
      tenantId: "tenant-1",
      agentId: null,
      provider: "brabrix-dev",
      endpoints: {
        projectContext: "/v1/projects/{projectId}/context",
        nextTask: "/v1/projects/{projectId}/tasks/next",
        sendRunLogs: "/v1/projects/{projectId}/runs/{runId}/logs",
        completeTask: "/v1/projects/{projectId}/tasks/{taskId}/complete",
      },
      timeoutMs: 10_000,
      maxRetries: 2,
      retryDelayMs: 400,
    });
    mockBrabrixSettingsService.getSettings.mockResolvedValue({
      provider: "brabrix_agent_sync",
      agentTokenSecretId: null,
      projectIdSecretId: null,
      tenantIdSecretId: null,
      credentialSource: {
        agentToken: "none",
        projectId: "none",
        tenantId: "none",
      },
      enabled: false,
    });
    mockBrabrixSettingsService.updateSettings.mockResolvedValue({
      provider: "brabrix_agent_sync",
      agentTokenSecretId: "11111111-1111-4111-8111-111111111111",
      projectIdSecretId: "22222222-2222-4222-8222-222222222222",
      tenantIdSecretId: "33333333-3333-4333-8333-333333333333",
      credentialSource: {
        agentToken: "settings",
        projectId: "settings",
        tenantId: "settings",
      },
      enabled: true,
    });
    mockSyncService.isEnabled.mockReturnValue(true);
    mockSyncService.fetchNextTask.mockResolvedValue({
      projectContext: null,
      task: null,
      goal: null,
      context: null,
    });
    mockBrabrixProjectImporter.testConnection.mockResolvedValue({
      ok: true,
      message: "Brabrix connection is healthy.",
      projectCount: 1,
    });
    mockBrabrixProjectImporter.listProjects.mockResolvedValue([
      {
        projectId: "bbx_project_1",
        name: "Brabrix Sample",
      },
    ]);
    mockBrabrixProjectImporter.importProject.mockResolvedValue({
      mode: "import",
      brabrixProjectId: "bbx_project_1",
      localProjectId: "local_project_1",
      localWorkspaceId: "workspace_1",
      projectName: "Brabrix Sample",
      importedAt: "2026-05-27T00:00:00.000Z",
      lastSyncedAt: "2026-05-27T00:00:00.000Z",
      counts: {
        goalsUpserted: 2,
        issuesUpserted: 3,
        skillsImported: 1,
        prdImported: true,
        specsImported: 1,
      },
      warnings: [],
    });
    mockBrabrixProjectImporter.syncProject.mockResolvedValue({
      mode: "sync",
      brabrixProjectId: "bbx_project_1",
      localProjectId: "local_project_1",
      localWorkspaceId: "workspace_1",
      projectName: "Brabrix Sample",
      importedAt: "2026-05-27T00:00:00.000Z",
      lastSyncedAt: "2026-05-27T01:00:00.000Z",
      counts: {
        goalsUpserted: 3,
        issuesUpserted: 5,
        skillsImported: 2,
        prdImported: true,
        specsImported: 2,
      },
      warnings: [],
    });
    mockBrabrixProjectImporter.listImportedProjects.mockResolvedValue([
      {
        brabrixProjectId: "bbx_project_1",
        localProjectId: "local_project_1",
        localProjectName: "Brabrix Sample",
        workspaceId: "workspace_1",
        workspaceName: "Brabrix Workspace",
        brabrixImportedAt: "2026-05-27T00:00:00.000Z",
        brabrixLastSyncedAt: "2026-05-27T01:00:00.000Z",
        brabrixSourceUrl: "https://api.brabrix.com/projects/bbx_project_1",
        badges: {
          imported: true,
          synced: true,
          outOfSync: false,
        },
      },
    ]);
    mockBrabrixProjectImporter.disconnectProject.mockResolvedValue({
      disconnected: true,
      localProjectId: "local_project_1",
    });
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("returns sync settings for a company", async () => {
    const res = await request(await createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    }))
      .get("/api/companies/company-1/brabrix/settings");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      provider: "brabrix_agent_sync",
      enabled: false,
    });
    expect(mockBrabrixSettingsService.getSettings).toHaveBeenCalledWith("company-1");
  });

  it("updates sync settings for board actors", async () => {
    const res = await request(await createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    }))
      .patch("/api/companies/company-1/brabrix/settings")
      .send({
        agentTokenSecretId: "11111111-1111-4111-8111-111111111111",
        projectIdSecretId: "22222222-2222-4222-8222-222222222222",
        tenantIdSecretId: "33333333-3333-4333-8333-333333333333",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockBrabrixSettingsService.updateSettings).toHaveBeenCalledWith("company-1", {
      agentTokenSecretId: "11111111-1111-4111-8111-111111111111",
      projectIdSecretId: "22222222-2222-4222-8222-222222222222",
      tenantIdSecretId: "33333333-3333-4333-8333-333333333333",
    });
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
  });

  it("returns 409 when sync integration is not ready", async () => {
    mockSyncService.isEnabled.mockReturnValue(false);
    const res = await request(await createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    }))
      .post("/api/companies/company-1/brabrix/sync-next-task")
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toContain("Company Settings");
  });

  it("syncs next task when integration is enabled", async () => {
    const res = await request(await createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    }))
      .post("/api/companies/company-1/brabrix/sync-next-task")
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      projectContext: null,
      task: null,
      goal: null,
      context: null,
    });
    expect(mockBrabrixSettingsService.resolveConfig).toHaveBeenCalledWith("company-1");
    expect(mockCreateBrabrixAgentSyncService).toHaveBeenCalledWith({
      config: expect.objectContaining({
        projectId: "project-1",
      }),
    });
  });

  it("lists Brabrix projects for import", async () => {
    const res = await request(await createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    }))
      .get("/api/companies/company-1/brabrix/projects");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.projects).toEqual([
      expect.objectContaining({
        projectId: "bbx_project_1",
        name: "Brabrix Sample",
      }),
    ]);
    expect(mockBrabrixProjectImporter.listProjects).toHaveBeenCalledTimes(1);
  });

  it("imports a Brabrix project", async () => {
    const res = await request(await createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    }))
      .post("/api/companies/company-1/brabrix/projects/bbx_project_1/import")
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      mode: "import",
      brabrixProjectId: "bbx_project_1",
      localProjectId: "local_project_1",
    });
    expect(mockBrabrixProjectImporter.importProject).toHaveBeenCalledWith("bbx_project_1");
  });

  it("lists imported Brabrix projects", async () => {
    const res = await request(await createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    }))
      .get("/api/companies/company-1/brabrix/projects/imported");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.projects).toEqual([
      expect.objectContaining({
        brabrixProjectId: "bbx_project_1",
        localProjectId: "local_project_1",
      }),
    ]);
    expect(mockBrabrixProjectImporter.listImportedProjects).toHaveBeenCalledTimes(1);
  });
});
