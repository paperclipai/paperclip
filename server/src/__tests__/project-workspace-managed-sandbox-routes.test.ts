import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Managed-sandbox-only policy (`enableManagedSandboxOnly`): a project workspace
 * `cwd` is an absolute path on the execution host. When every agent runs in the
 * platform-managed environment there is no host for a user to point at, so the
 * project-workspace write routes refuse a payload that carries one. These tests
 * pin the floor behind the hidden UI field on all three write paths.
 */

const MANAGED_SANDBOX_CWD_ERROR =
  "This instance runs agents only in the platform-managed environment; local folders are not configurable.";

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
  listBoundCompanyIds: vi.fn(),
}));
const mockInstanceSettingsService = vi.hoisted(() => ({
  getExperimental: vi.fn(),
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

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));

vi.mock("../services/workspace-runtime.js", () => ({
  startRuntimeServicesForWorkspaceControl: vi.fn(),
  stopRuntimeServicesForProjectWorkspace: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/activity-log.js", async () => ({
    ...await vi.importActual<typeof import("../services/activity-log.js")>("../services/activity-log.js"),
    persistActivity: async (db: unknown, input: unknown) => { await mockLogActivity(db, input); return { activity: { id: "activity" }, publication: null }; },
    publishActivity: vi.fn(),
  }));
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

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));

  vi.doMock("../services/workspace-runtime.js", () => ({
    startRuntimeServicesForWorkspaceControl: vi.fn(),
    stopRuntimeServicesForProjectWorkspace: vi.fn(),
  }));
}

async function createApp(actorOverrides: Record<string, unknown> = {}) {
  const [{ projectRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/projects.js")>("../routes/projects.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
      ...actorOverrides,
    };
    next();
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use("/api", projectRoutes({ transaction: async (effect: (tx: unknown) => unknown) => effect({}) } as any));
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

function buildWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    id: "workspace-1",
    companyId: "company-1",
    projectId: "project-1",
    name: "Primary",
    sourceType: "local_path",
    cwd: "/srv/projects/paperclip",
    repoUrl: null,
    isPrimary: true,
    ...overrides,
  };
}

function setManagedSandboxOnly(enabled: boolean) {
  mockInstanceSettingsService.getExperimental.mockResolvedValue({
    enableManagedSandboxOnly: enabled,
  });
}

describe("project workspace host-path floor", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/projects.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../services/environments.js");
    vi.doUnmock("../services/instance-settings.js");
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
    mockProjectService.getById.mockResolvedValue(buildProject());
    mockProjectService.create.mockResolvedValue(buildProject());
    mockProjectService.createWorkspace.mockResolvedValue(buildWorkspace());
    mockProjectService.updateWorkspace.mockResolvedValue(buildWorkspace());
    mockProjectService.listWorkspaces.mockResolvedValue([buildWorkspace()]);
    mockSecretService.normalizeEnvBindingsForPersistence.mockImplementation(async (_companyId, env) => env);
    setManagedSandboxOnly(false);
    mockEnvironmentService.listBoundCompanyIds.mockResolvedValue([]);
  });

  it("accepts a Daytona project environment without enabling checkout isolation", async () => {
    const environmentId = "11111111-1111-4111-8111-111111111111";
    setManagedSandboxOnly(true);
    mockEnvironmentService.getById.mockResolvedValue({ id: environmentId, driver: "sandbox", status: "active", config: { provider: "daytona", disk: 30 } });
    mockProjectService.update.mockResolvedValue(buildProject({ executionWorkspacePolicy: { enabled: false, environmentId } }));
    const app = await createApp();
    const res = await request(app).patch("/api/projects/project-1").send({ executionWorkspacePolicy: { enabled: false, environmentId } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockProjectService.update).toHaveBeenCalledWith("project-1", { executionWorkspacePolicy: { enabled: false, environmentId } });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "project.updated" }));
  });

  it.each(["missing", "archived", "fake"])("rejects a %s project environment before saving", async state => {
    const environmentId = "11111111-1111-4111-8111-111111111111";
    mockEnvironmentService.getById.mockResolvedValue(state === "missing" ? null : {
      id: environmentId, driver: "sandbox", status: state === "archived" ? "archived" : "active", config: { provider: "fake" },
    });
    const app = await createApp();
    const res = await request(app).patch("/api/projects/project-1").send({ executionWorkspacePolicy: { enabled: false, environmentId } });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(mockProjectService.update).not.toHaveBeenCalled();
  });

  it("clears a project environment without requiring the old target to exist", async () => {
    mockProjectService.update.mockResolvedValue(buildProject({ executionWorkspacePolicy: { enabled: false, environmentId: null } }));
    const app = await createApp();
    const res = await request(app).patch("/api/projects/project-1").send({ executionWorkspacePolicy: { enabled: false, environmentId: null } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockEnvironmentService.getById).not.toHaveBeenCalled();
  });

  it("allows unrelated policy edits while the unchanged environment is archived", async () => {
    const environmentId = "11111111-1111-4111-8111-111111111111";
    mockProjectService.getById.mockResolvedValue(buildProject({ executionWorkspacePolicy: { enabled: true, environmentId, sharedWorkspaceConcurrency: "auto" } }));
    mockEnvironmentService.getById.mockResolvedValue({ id: environmentId, driver: "sandbox", status: "archived", config: { provider: "daytona" } });
    const executionWorkspacePolicy = { enabled: true, environmentId, sharedWorkspaceConcurrency: "serialize" };
    mockProjectService.update.mockResolvedValue(buildProject({ executionWorkspacePolicy }));
    const app = await createApp();
    const res = await request(app).patch("/api/projects/project-1").send({ executionWorkspacePolicy });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockProjectService.update).toHaveBeenCalledWith("project-1", { executionWorkspacePolicy });
    expect(mockEnvironmentService.getById).not.toHaveBeenCalled();
  });

  it("requires workspace-write authority to change a project environment", async () => {
    const environmentId = "11111111-1111-4111-8111-111111111111";
    mockAccessService.decide.mockImplementation(async input => ({ allowed: input.action !== "project:write_workspace", explanation: "Workspace write permission required." }));
    mockEnvironmentService.getById.mockResolvedValue({ id: environmentId, driver: "sandbox", status: "active", config: { provider: "daytona" } });
    const app = await createApp();
    await request(app).patch("/api/projects/project-1").send({ executionWorkspacePolicy: { enabled: false, environmentId } }).expect(403);
    expect(mockProjectService.update).not.toHaveBeenCalled();
  });

  it.each([null, { enabled: false }, { enabled: false, environmentId: null }])("requires write authority when policy replacement clears an environment (%j)", async executionWorkspacePolicy => {
    mockProjectService.getById.mockResolvedValue(buildProject({ executionWorkspacePolicy: { enabled: false, environmentId: "11111111-1111-4111-8111-111111111111" } }));
    mockAccessService.decide.mockImplementation(async input => ({ allowed: input.action !== "project:write_workspace", explanation: "Workspace write permission required." }));
    const app = await createApp();
    await request(app).patch("/api/projects/project-1").send({ executionWorkspacePolicy }).expect(403);
    expect(mockProjectService.update).not.toHaveBeenCalled();
  });

  it("rejects a project environment bound only to another company", async () => {
    const environmentId = "11111111-1111-4111-8111-111111111111";
    mockEnvironmentService.getById.mockResolvedValue({ id: environmentId, driver: "sandbox", status: "active", config: { provider: "daytona" } });
    mockEnvironmentService.listBoundCompanyIds.mockResolvedValue(["other-company"]);
    const app = await createApp();
    await request(app).patch("/api/projects/project-1").send({ executionWorkspacePolicy: { enabled: false, environmentId } }).expect(403);
    expect(mockProjectService.update).not.toHaveBeenCalled();
  });

  it("requires write authority to create a project with an environment", async () => {
    const environmentId = "11111111-1111-4111-8111-111111111111";
    mockAccessService.decide.mockImplementation(async input => ({ allowed: !["project:write_workspace", "tasks:assign"].includes(input.action), explanation: "Workspace write permission required." }));
    mockEnvironmentService.getById.mockResolvedValue({ id: environmentId, driver: "sandbox", status: "active", config: { provider: "daytona" } });
    const app = await createApp();
    await request(app).post("/api/companies/company-1/projects").send({ name: "Project", executionWorkspacePolicy: { enabled: false, environmentId } }).expect(403);
    expect(mockProjectService.create).not.toHaveBeenCalled();
  });

  it.each([
    { source: "local_implicit", isInstanceAdmin: false },
    { source: "cloud_tenant", isInstanceAdmin: true },
  ])("creates a project with an environment using real authorization (%j)", async actorOverrides => {
    const { accessService } = await vi.importActual<typeof import("../services/access.js")>("../services/access.js");
    // These administrator paths do not query the database. Keep the real
    // authorization dispatch so missing creation-time context cannot be mocked away.
    const access = accessService({} as Parameters<typeof accessService>[0]);
    mockAccessService.decide.mockImplementation(access.decide);
    const environmentId = "11111111-1111-4111-8111-111111111111";
    mockEnvironmentService.getById.mockResolvedValue({ id: environmentId, driver: "sandbox", status: "active", config: { provider: "daytona" } });
    const app = await createApp(actorOverrides);
    const res = await request(app).post("/api/companies/company-1/projects").send({ name: "Project", executionWorkspacePolicy: { enabled: false, environmentId } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockProjectService.create).toHaveBeenCalledWith("company-1", expect.objectContaining({ executionWorkspacePolicy: { enabled: false, environmentId } }));
  });

  it("creates a project workspace with a cwd when the policy is off", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/projects/project-1/workspaces")
      .send({ name: "Primary", cwd: "/srv/projects/paperclip" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockProjectService.createWorkspace).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({ cwd: "/srv/projects/paperclip" }),
    );
  });

  it("refuses a project workspace create that carries a cwd when the policy is on", async () => {
    setManagedSandboxOnly(true);
    const app = await createApp();
    const res = await request(app)
      .post("/api/projects/project-1/workspaces")
      .send({ name: "Primary", cwd: "/srv/projects/paperclip" });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toBe(MANAGED_SANDBOX_CWD_ERROR);
    expect(mockProjectService.createWorkspace).not.toHaveBeenCalled();
  });

  it("refuses a project workspace patch that carries a cwd when the policy is on", async () => {
    setManagedSandboxOnly(true);
    const app = await createApp();
    const res = await request(app)
      .patch("/api/projects/project-1/workspaces/workspace-1")
      .send({ cwd: "/srv/projects/paperclip" });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toBe(MANAGED_SANDBOX_CWD_ERROR);
    expect(mockProjectService.updateWorkspace).not.toHaveBeenCalled();
  });

  it("still allows clearing a stale cwd when the policy is on", async () => {
    setManagedSandboxOnly(true);
    mockProjectService.updateWorkspace.mockResolvedValue(buildWorkspace({ cwd: null }));
    const app = await createApp();
    const res = await request(app)
      .patch("/api/projects/project-1/workspaces/workspace-1")
      .send({ cwd: null });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockProjectService.updateWorkspace).toHaveBeenCalledWith(
      "project-1",
      "workspace-1",
      expect.objectContaining({ cwd: null }),
    );
  });

  it("patches a project workspace cwd when the policy is off", async () => {
    const app = await createApp();
    const res = await request(app)
      .patch("/api/projects/project-1/workspaces/workspace-1")
      .send({ cwd: "/srv/projects/paperclip" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockProjectService.updateWorkspace).toHaveBeenCalledWith(
      "project-1",
      "workspace-1",
      expect.objectContaining({ cwd: "/srv/projects/paperclip" }),
    );
  });

  it("refuses a nested workspace cwd on project create when the policy is on", async () => {
    setManagedSandboxOnly(true);
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/projects")
      .send({
        name: "Project",
        workspace: { name: "Primary", cwd: "/srv/projects/paperclip" },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toBe(MANAGED_SANDBOX_CWD_ERROR);
    // The floor runs before the project row is written, so nothing is orphaned.
    expect(mockProjectService.create).not.toHaveBeenCalled();
    expect(mockProjectService.createWorkspace).not.toHaveBeenCalled();
  });

  it("accepts a nested workspace with only a repo URL when the policy is on", async () => {
    setManagedSandboxOnly(true);
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/projects")
      .send({
        name: "Project",
        workspace: { name: "Primary", repoUrl: "https://github.com/paperclipai/paperclip" },
      });

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(mockProjectService.createWorkspace).toHaveBeenCalled();
  });
});
