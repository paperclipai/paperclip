import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { environmentRoutes } from "../routes/environments.js";
import { errorHandler } from "../middleware/index.js";

const mockIssueService = vi.hoisted(() => ({
  clearExecutionWorkspaceEnvironmentSelection: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  clearExecutionWorkspaceEnvironmentSelection: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  listCompanyIds: vi.fn(),
}));

const mockEnvironmentService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
}));

const mockEnvironmentCustomImageService = vi.hoisted(() => ({
  getOverview: vi.fn(),
  getActiveTemplate: vi.fn(),
  getSessionById: vi.fn(),
  startSetupSession: vi.fn(),
  refreshSetupSession: vi.fn(),
  finishSetupSession: vi.fn(),
  cancelSetupSession: vi.fn(),
  rollbackTemplate: vi.fn(),
  disableTemplate: vi.fn(),
  cleanupExpiredSetupSessions: vi.fn(),
}));

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  clearEnvironmentSelection: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

const mockSecretService = vi.hoisted(() => ({
  create: vi.fn(),
  normalizeEnvBindingsForPersistence: vi.fn(),
  listBindingCompanyIdsForTarget: vi.fn(),
  resolveSecretValueForEphemeralAccess: vi.fn(),
  syncEnvBindingsForTarget: vi.fn(),
  syncSecretRefsForTarget: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  issueService: () => mockIssueService,
  instanceSettingsService: () => mockInstanceSettingsService,
  environmentCustomImageService: () => mockEnvironmentCustomImageService,
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => mockEnvironmentService,
}));

vi.mock("../services/execution-workspaces.js", () => ({
  executionWorkspaceService: () => mockExecutionWorkspaceService,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

vi.mock("../services/plugin-environment-driver.js", () => ({
  listReadyPluginEnvironmentDrivers: vi.fn(async () => []),
  resolvePluginSandboxProviderDriverByKey: vi.fn(async () => null),
  validatePluginEnvironmentDriverConfig: vi.fn(async ({ config }) => config),
  validatePluginSandboxProviderConfig: vi.fn(async ({ provider, config }) => ({
    normalizedConfig: config,
    pluginId: `plugin-${provider}`,
    pluginKey: `plugin.${provider}`,
    driver: {
      driverKey: provider,
      kind: "sandbox_provider",
      displayName: provider,
      configSchema: { type: "object" },
    },
  })),
  startPluginEnvironmentInteractiveSetup: vi.fn(),
  getPluginEnvironmentInteractiveSetup: vi.fn(),
  capturePluginEnvironmentTemplate: vi.fn(),
  cancelPluginEnvironmentInteractiveSetup: vi.fn(),
  deletePluginEnvironmentTemplate: vi.fn(),
}));

function createEnvironment(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-06-20T00:00:00.000Z");
  return {
    id: "env-1",
    name: "Local",
    description: "Default execution environment",
    driver: "local",
    status: "active" as const,
    config: {},
    envVars: {},
    metadata: { managedByPaperclip: true },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as typeof req & { actor: Record<string, unknown> }).actor = actor;
    next();
  });
  app.use("/api", environmentRoutes({} as never));
  app.use(errorHandler);
  return app;
}

describe("environment instance routes", () => {
  beforeEach(() => {
    mockIssueService.clearExecutionWorkspaceEnvironmentSelection.mockReset();
    mockProjectService.clearExecutionWorkspaceEnvironmentSelection.mockReset();
    mockInstanceSettingsService.listCompanyIds.mockReset();
    mockEnvironmentService.list.mockReset();
    mockEnvironmentService.getById.mockReset();
    mockEnvironmentService.create.mockReset();
    Object.values(mockEnvironmentCustomImageService).forEach((mock) => mock.mockReset());
    mockEnvironmentCustomImageService.getOverview.mockResolvedValue({
      activeTemplate: null,
      activeSession: null,
      latestSession: null,
    });
    mockEnvironmentCustomImageService.getActiveTemplate.mockResolvedValue(null);
    mockEnvironmentCustomImageService.getSessionById.mockResolvedValue(null);
    mockExecutionWorkspaceService.clearEnvironmentSelection.mockReset();
    mockLogActivity.mockReset();
    mockSecretService.create.mockReset();
    mockSecretService.normalizeEnvBindingsForPersistence.mockReset();
    mockSecretService.listBindingCompanyIdsForTarget.mockReset();
    mockSecretService.resolveSecretValueForEphemeralAccess.mockReset();
    mockSecretService.syncEnvBindingsForTarget.mockReset();
    mockSecretService.syncSecretRefsForTarget.mockReset();

    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1", "company-2"]);
    mockEnvironmentService.list.mockResolvedValue([]);
    mockEnvironmentService.create.mockResolvedValue(createEnvironment());
    mockSecretService.normalizeEnvBindingsForPersistence.mockImplementation(async (_companyId, env) => env ?? {});
    mockSecretService.listBindingCompanyIdsForTarget.mockResolvedValue([]);
    mockSecretService.syncEnvBindingsForTarget.mockResolvedValue([]);
    mockSecretService.syncSecretRefsForTarget.mockResolvedValue([]);
  });

  it("lists the instance environment catalog for a local board actor", async () => {
    mockEnvironmentService.list.mockResolvedValue([createEnvironment()]);
    const app = createApp({
      type: "board",
      userId: "board-1",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app).get("/api/companies/company-1/environments?driver=local");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(mockEnvironmentService.list).toHaveBeenCalledWith({
      status: undefined,
      driver: "local",
    });
  });

  it("allows non-admin board members with company access to read the shared environment catalog", async () => {
    mockEnvironmentService.list.mockResolvedValue([createEnvironment()]);
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", membershipRole: "member", status: "active" }],
      isInstanceAdmin: false,
    });

    const res = await request(app).get("/api/companies/company-1/environments");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(mockEnvironmentService.list).toHaveBeenCalledTimes(1);
  });

  it("rejects company agents from enumerating the shared environment catalog", async () => {
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app).get("/api/companies/company-1/environments");

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Board access required");
  });

  it("rejects non-admin signed-in board members from mutating instance environments", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      companyIds: ["company-1"],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post("/api/companies/company-1/environments")
      .send({
        name: "Shared Local",
        driver: "local",
        config: {},
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Instance admin");
    expect(mockEnvironmentService.create).not.toHaveBeenCalled();
  });

  it("creates an instance-scoped environment and logs the mutation to every company", async () => {
    const app = createApp({
      type: "board",
      userId: "board-1",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .post("/api/companies/company-1/environments")
      .send({
        name: "Shared Local",
        driver: "local",
        config: {},
      });

    expect(res.status).toBe(201);
    expect(mockEnvironmentService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Shared Local",
        driver: "local",
        status: "active",
      }),
    );
    expect(mockSecretService.syncSecretRefsForTarget).toHaveBeenCalledWith(
      "company-1",
      { targetType: "environment", targetId: "env-1" },
      [],
    );
    expect(mockSecretService.syncEnvBindingsForTarget).toHaveBeenCalledWith(
      "company-1",
      { targetType: "environment", targetId: "env-1" },
      {},
    );
    expect(mockLogActivity).toHaveBeenCalledTimes(2);
    expect(mockLogActivity.mock.calls.map((call) => call[1].companyId)).toEqual(["company-1", "company-2"]);
  });

  it("normalizes and syncs environment envVars on create", async () => {
    const envVars = {
      ANTHROPIC_API_KEY: { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111", version: "latest" },
    };
    mockSecretService.normalizeEnvBindingsForPersistence.mockResolvedValue(envVars);
    mockEnvironmentService.create.mockResolvedValue(createEnvironment({ envVars }));
    const app = createApp({
      type: "board",
      userId: "board-1",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .post("/api/companies/company-1/environments")
      .send({
        name: "Shared Local",
        driver: "local",
        config: {},
        envVars,
      });

    expect(res.status).toBe(201);
    expect(mockSecretService.normalizeEnvBindingsForPersistence).toHaveBeenCalledWith(
      "company-1",
      envVars,
      expect.objectContaining({ fieldPath: "envVars" }),
    );
    expect(mockEnvironmentService.create).toHaveBeenCalledWith(expect.objectContaining({ envVars }));
    expect(mockSecretService.syncEnvBindingsForTarget).toHaveBeenCalledWith(
      "company-1",
      { targetType: "environment", targetId: "env-1" },
      envVars,
    );
  });

  it("returns full environment details for an instance admin", async () => {
    mockEnvironmentService.getById.mockResolvedValue(createEnvironment({ config: { shell: "zsh" } }));
    const app = createApp({
      type: "board",
      userId: "board-1",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app).get("/api/environments/env-1");

    expect(res.status).toBe(200);
    expect(res.body.config).toEqual({ shell: "zsh" });
  });
});
