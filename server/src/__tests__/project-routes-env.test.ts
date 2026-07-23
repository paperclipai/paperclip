import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockProjectService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  createWorkspace: vi.fn(),
  listWorkspaces: vi.fn(),
  updateWorkspace: vi.fn(),
  removeWorkspace: vi.fn(),
  remove: vi.fn(),
  resolveByReference: vi.fn(),
}));
const mockSecretService = vi.hoisted(() => ({
  normalizeEnvBindingsForPersistence: vi.fn(),
}));
const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));
const mockWorkspaceOperationService = vi.hoisted(() => ({}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: mockGetTelemetryClient,
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  environmentService: () => mockEnvironmentService,
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
  secretService: () => mockSecretService,
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => mockEnvironmentService,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

vi.mock("../services/workspace-runtime.js", () => ({
  startRuntimeServicesForWorkspaceControl: vi.fn(),
  stopRuntimeServicesForProjectWorkspace: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: mockGetTelemetryClient,
  }));

  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    environmentService: () => mockEnvironmentService,
    logActivity: mockLogActivity,
    projectService: () => mockProjectService,
    secretService: () => mockSecretService,
    workspaceOperationService: () => mockWorkspaceOperationService,
  }));

  vi.doMock("../services/environments.js", () => ({
    environmentService: () => mockEnvironmentService,
  }));

  vi.doMock("../services/secrets.js", () => ({
    secretService: () => mockSecretService,
  }));

  vi.doMock("../services/workspace-runtime.js", () => ({
    startRuntimeServicesForWorkspaceControl: vi.fn(),
    stopRuntimeServicesForProjectWorkspace: vi.fn(),
  }));
}

async function createApp() {
  const [{ projectRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/projects.js")>("../routes/projects.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", projectRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function buildProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-1",
    companyId: "company-1",
    urlKey: "project-1",
    goalId: null,
    goalIds: [],
    goals: [],
    name: "Project",
    description: null,
    status: "backlog",
    leadAgentId: null,
    targetDate: null,
    color: null,
    env: null,
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
      managedFolder: "/tmp/project",
      effectiveLocalFolder: "/tmp/project",
      origin: "managed_checkout",
    },
    workspaces: [],
    primaryWorkspace: null,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("project env routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/projects.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../services/environments.js");
    vi.doUnmock("../services/secrets.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "project:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockProjectService.resolveByReference.mockResolvedValue({ ambiguous: false, project: null });
    mockProjectService.createWorkspace.mockResolvedValue(null);
    mockProjectService.listWorkspaces.mockResolvedValue([]);
    mockEnvironmentService.getById.mockReset();
    mockSecretService.normalizeEnvBindingsForPersistence.mockImplementation(async (_companyId, env) => env);
  });

  it("returns only value-free env metadata from project list and detail reads", async () => {
    const project = buildProject({
      env: {
        LEGACY_PLAIN: "legacy-value-must-not-serialize",
        PLAIN: { type: "plain", value: "plain-value-must-not-serialize" },
        SECRET: {
          type: "secret_ref",
          secretId: "11111111-1111-4111-8111-111111111111",
          version: 3,
        },
        USER_SECRET: {
          type: "user_secret_ref",
          key: "USER_TOKEN",
          version: "latest",
          required: true,
        },
      },
    });
    mockProjectService.list.mockResolvedValue([project]);
    mockProjectService.getById.mockResolvedValue(project);

    const app = await createApp();
    const [listRes, detailRes] = await Promise.all([
      request(app).get("/api/companies/company-1/projects"),
      request(app).get("/api/projects/project-1"),
    ]);

    expect(listRes.status, JSON.stringify(listRes.body)).toBe(200);
    expect(detailRes.status, JSON.stringify(detailRes.body)).toBe(200);
    for (const responseProject of [listRes.body[0], detailRes.body]) {
      expect(responseProject.env).toBeNull();
      expect(responseProject.envMetadata).toEqual({
        keys: ["LEGACY_PLAIN", "PLAIN", "SECRET", "USER_SECRET"],
        bindings: {
          LEGACY_PLAIN: { type: "plain", configured: true },
          PLAIN: { type: "plain", configured: true },
          SECRET: {
            type: "secret_ref",
            configured: true,
            secretId: "11111111-1111-4111-8111-111111111111",
            version: 3,
          },
          USER_SECRET: {
            type: "user_secret_ref",
            configured: true,
            key: "USER_TOKEN",
            version: "latest",
            required: true,
          },
        },
      });
      expect(JSON.stringify(responseProject)).not.toContain("value-must-not-serialize");
    }
  });

  it("normalizes env bindings on create and logs only env keys", async () => {
    const normalizedEnv = {
      API_KEY: {
        type: "secret_ref",
        secretId: "11111111-1111-4111-8111-111111111111",
        version: "latest",
      },
    };
    mockSecretService.normalizeEnvBindingsForPersistence.mockResolvedValue(normalizedEnv);
    mockProjectService.create.mockResolvedValue(buildProject({ env: normalizedEnv }));

    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/projects")
      .send({
        name: "Project",
        env: normalizedEnv,
      });

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(mockSecretService.normalizeEnvBindingsForPersistence).toHaveBeenCalledWith(
      "company-1",
      normalizedEnv,
      expect.objectContaining({ fieldPath: "env" }),
    );
    expect(mockProjectService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ env: normalizedEnv }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({
          envKeys: ["API_KEY"],
        }),
      }),
    );
    expect(res.body.env).toBeNull();
    expect(res.body.envMetadata.bindings.API_KEY).toEqual({
      type: "secret_ref",
      configured: true,
      secretId: "11111111-1111-4111-8111-111111111111",
      version: "latest",
    });
  });

  it("normalizes env bindings on update and avoids logging raw values", async () => {
    const normalizedEnv = {
      PLAIN_KEY: { type: "plain", value: "top-secret" },
    };
    mockSecretService.normalizeEnvBindingsForPersistence.mockResolvedValue(normalizedEnv);
    mockProjectService.getById.mockResolvedValue(buildProject());
    mockProjectService.update.mockResolvedValue(buildProject({ env: normalizedEnv }));

    const app = await createApp();
    const res = await request(app)
      .patch("/api/projects/project-1")
      .send({
        env: normalizedEnv,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: {
          changedKeys: ["env"],
          envKeys: ["PLAIN_KEY"],
        },
      }),
    );
    expect(res.body.env).toBeNull();
    expect(res.body.envMetadata.bindings.PLAIN_KEY).toEqual({ type: "plain", configured: true });
    expect(JSON.stringify(res.body)).not.toContain("top-secret");
  });

  it("patches write-only env bindings without returning or replacing untouched values", async () => {
    const existingEnv = {
      KEEP: { type: "plain", value: "untouched-value" },
      REMOVE: { type: "plain", value: "removed-value" },
      REPLACE: { type: "plain", value: "old-value" },
    };
    const patchSet = {
      REPLACE: {
        type: "secret_ref",
        secretId: "11111111-1111-4111-8111-111111111111",
        version: "latest",
      },
    };
    const expectedEnv = {
      KEEP: existingEnv.KEEP,
      REPLACE: patchSet.REPLACE,
    };
    mockProjectService.getById.mockResolvedValue(buildProject({ env: existingEnv }));
    mockSecretService.normalizeEnvBindingsForPersistence.mockResolvedValue(patchSet);
    mockProjectService.update.mockResolvedValue(buildProject({ env: expectedEnv }));

    const res = await request(await createApp())
      .patch("/api/projects/project-1")
      .send({ envPatch: { set: patchSet, remove: ["REMOVE"] } });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockSecretService.normalizeEnvBindingsForPersistence).toHaveBeenCalledWith(
      "company-1",
      patchSet,
      expect.objectContaining({ fieldPath: "envPatch.set" }),
    );
    expect(mockProjectService.update).toHaveBeenCalledWith("project-1", { env: expectedEnv });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: {
          changedKeys: ["envPatch"],
          envKeys: ["KEEP", "REPLACE"],
        },
      }),
    );
    expect(res.body.env).toBeNull();
    expect(res.body.envMetadata.keys).toEqual(["KEEP", "REPLACE"]);
    expect(JSON.stringify(res.body)).not.toContain("untouched-value");
    expect(JSON.stringify(res.body)).not.toContain("removed-value");
    expect(JSON.stringify(res.body)).not.toContain("old-value");
  });

  it("does not echo env values from project delete responses", async () => {
    mockProjectService.getById.mockResolvedValue(buildProject());
    mockProjectService.remove.mockResolvedValue(buildProject({
      env: { DELETED_SECRET: { type: "plain", value: "deleted-value-must-not-serialize" } },
    }));

    const res = await request(await createApp()).delete("/api/projects/project-1");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.env).toBeNull();
    expect(res.body.envMetadata.bindings.DELETED_SECRET).toEqual({ type: "plain", configured: true });
    expect(JSON.stringify(res.body)).not.toContain("deleted-value-must-not-serialize");
  });
});
