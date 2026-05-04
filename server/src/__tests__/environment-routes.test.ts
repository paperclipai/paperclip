import type { Server } from "node:http";
import express from "express";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { environmentRoutes } from "../routes/environments.js";
import { errorHandler } from "../middleware/index.js";

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockEnvironmentService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  listLeases: vi.fn(),
  getLeaseById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockProbeEnvironment = vi.hoisted(() => vi.fn());
const mockSecretService = vi.hoisted(() => ({
  create: vi.fn(),
  resolveSecretValue: vi.fn(),
}));
const mockValidatePluginEnvironmentDriverConfig = vi.hoisted(() => vi.fn());
const mockValidatePluginSandboxProviderConfig = vi.hoisted(() => vi.fn());
const mockListReadyPluginEnvironmentDrivers = vi.hoisted(() => vi.fn());
const mockExecutionWorkspaceService = vi.hoisted(() => ({}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  issueService: () => mockIssueService,
  environmentService: () => mockEnvironmentService,
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
}));

vi.mock("../services/environment-probe.js", () => ({
  probeEnvironment: mockProbeEnvironment,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => mockEnvironmentService,
}));

vi.mock("../services/execution-workspaces.js", () => ({
  executionWorkspaceService: () => mockExecutionWorkspaceService,
}));

vi.mock("../services/plugin-environment-driver.js", () => ({
  listReadyPluginEnvironmentDrivers: mockListReadyPluginEnvironmentDrivers,
  validatePluginEnvironmentDriverConfig: mockValidatePluginEnvironmentDriverConfig,
  validatePluginSandboxProviderConfig: mockValidatePluginSandboxProviderConfig,
}));

function createEnvironment() {
  const now = new Date("2026-04-16T05:00:00.000Z");
  return {
    id: "env-1",
    companyId: "company-1",
    name: "Local",
    description: "Current development machine",
    driver: "local",
    status: "active" as const,
    config: { shell: "zsh" },
    metadata: { source: "manual" },
    createdAt: now,
    updatedAt: now,
  };
}

let server: Server | null = null;
let currentActor: Record<string, unknown> = {
  type: "board",
  userId: "user-1",
  source: "local_implicit",
};
const routeOptions: Record<string, unknown> = {};

function createApp(actor: Record<string, unknown>, options: Record<string, unknown> = {}) {
  currentActor = actor;
  for (const key of Object.keys(routeOptions)) {
    delete routeOptions[key];
  }
  Object.assign(routeOptions, options);
  if (server) return server;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = currentActor;
    next();
  });
  app.use("/api", environmentRoutes({} as any, routeOptions as any));
  app.use(errorHandler);
  server = app.listen(0);
  return server;
}

describe("environment routes", () => {
  afterAll(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server?.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    server = null;
  });

  beforeEach(() => {
    mockAccessService.canUser.mockReset();
    mockAccessService.hasPermission.mockReset();
    mockAgentService.getById.mockReset();
    mockIssueService.getById.mockReset();
    mockProjectService.getById.mockReset();
    mockEnvironmentService.list.mockReset();
    mockEnvironmentService.getById.mockReset();
    mockEnvironmentService.create.mockReset();
    mockEnvironmentService.update.mockReset();
    mockEnvironmentService.listLeases.mockReset();
    mockEnvironmentService.getLeaseById.mockReset();
    mockLogActivity.mockReset();
    mockProbeEnvironment.mockReset();
    mockSecretService.create.mockReset();
    mockSecretService.resolveSecretValue.mockReset();
    mockSecretService.create.mockResolvedValue({
      id: "11111111-1111-1111-1111-111111111111",
    });
    mockValidatePluginEnvironmentDriverConfig.mockReset();
    mockValidatePluginEnvironmentDriverConfig.mockImplementation(async ({ config }) => config);
    mockValidatePluginSandboxProviderConfig.mockReset();
    mockValidatePluginSandboxProviderConfig.mockImplementation(async ({ provider, config }) => ({
      normalizedConfig: config,
      pluginId: `plugin-${provider}`,
      pluginKey: `plugin.${provider}`,
      driver: {
        driverKey: provider,
        kind: "sandbox_provider",
        displayName: provider,
        configSchema: { type: "object" },
      },
    }));
    mockListReadyPluginEnvironmentDrivers.mockReset();
    mockListReadyPluginEnvironmentDrivers.mockResolvedValue([]);
  });

  it("lists company-scoped environments", async () => {
    mockEnvironmentService.list.mockResolvedValue([createEnvironment()]);
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app).get("/api/companies/company-1/environments?driver=local");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(mockEnvironmentService.list).toHaveBeenCalledWith("company-1", {
      status: undefined,
      driver: "local",
    });
  });

  it("returns provider capabilities for the company", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app).get("/api/companies/company-1/environments/capabilities");

    expect(res.status).toBe(200);
    expect(res.body.drivers.ssh).toBe("supported");
    expect(res.body.sandboxProviders.fake.supportsRunExecution).toBe(false);
    expect(res.body.sandboxProviders).not.toHaveProperty("fake-plugin");
  });

  it("returns installed plugin-backed sandbox capabilities for environment creation", async () => {
    mockListReadyPluginEnvironmentDrivers.mockResolvedValue([
      {
        pluginId: "plugin-1",
        pluginKey: "acme.secure-sandbox-provider",
        driverKey: "secure-plugin",
        displayName: "Secure Sandbox",
        description: "Provisions schema-driven cloud sandboxes.",
        configSchema: {
          type: "object",
          properties: {
            template: { type: "string" },
            apiKey: { type: "string", format: "secret-ref" },
          },
        },
      },
    ]);
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app).get("/api/companies/company-1/environments/capabilities");

    expect(res.status).toBe(200);
    expect(res.body.sandboxProviders["secure-plugin"]).toMatchObject({
      status: "supported",
      supportsRunExecution: true,
      supportsReusableLeases: true,
      displayName: "Secure Sandbox",
      source: "plugin",
      pluginKey: "acme.secure-sandbox-provider",
      pluginId: "plugin-1",
      configSchema: {
        type: "object",
        properties: {
          template: { type: "string" },
          apiKey: { type: "string", format: "secret-ref" },
        },
      },
    });
    expect(res.body.adapters.find((row: any) => row.adapterType === "codex_local").sandboxProviders["secure-plugin"])
      .toBe("supported");
  });

  it("redacts config and metadata for unprivileged agent list reads", async () => {
    mockEnvironmentService.list.mockResolvedValue([createEnvironment()]);
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      role: "engineer",
      permissions: { canCreateAgents: false },
    });
    mockAccessService.hasPermission.mockResolvedValue(false);
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app).get("/api/companies/company-1/environments");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({
        id: "env-1",
        config: {},
        metadata: null,
        configRedacted: true,
        metadataRedacted: true,
      }),
    ]);
  });

  it("returns full config for privileged environment readers", async () => {
    mockEnvironmentService.getById.mockResolvedValue(createEnvironment());
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      role: "cto",
      permissions: { canCreateAgents: true },
    });
    mockAccessService.hasPermission.mockResolvedValue(false);
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app).get("/api/environments/env-1");

    expect(res.status).toBe(200);
    expect(res.body.config).toEqual({ shell: "zsh" });
    expect(res.body.metadata).toEqual({ source: "manual" });
    expect(res.body.configRedacted).toBeUndefined();
  });

  it("redacts config and metadata for unprivileged agent detail reads", async () => {
    mockEnvironmentService.getById.mockResolvedValue(createEnvironment());
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      role: "engineer",
      permissions: { canCreateAgents: false },
    });
    mockAccessService.hasPermission.mockResolvedValue(false);
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app).get("/api/environments/env-1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        id: "env-1",
        config: {},
        metadata: null,
        configRedacted: true,
        metadataRedacted: true,
      }),
    );
  });

  it("creates an environment and logs activity", async () => {
    const environment = createEnvironment();
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      role: "cto",
      permissions: { canCreateAgents: true },
    });
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockEnvironmentService.create.mockResolvedValue(environment);
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/companies/company-1/environments")
      .send({
        name: "Local",
        driver: "local",
        description: "Current development machine",
        config: { shell: "zsh" },
      });

    expect(res.status).toBe(201);
    expect(mockEnvironmentService.create).toHaveBeenCalledWith("company-1", {
      name: "Local",
      driver: "local",
      description: "Current development machine",
      status: "active",
      config: { shell: "zsh" },
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        actorType: "agent",
        actorId: "agent-1",
        agentId: "agent-1",
        runId: "run-1",
        action: "environment.created",
        entityType: "environment",
        entityId: environment.id,
      }),
    );
  });

  it("allows non-admin board users with environments:manage to create environments", async () => {
    const environment = createEnvironment();
    mockAccessService.canUser.mockResolvedValue(true);
    mockEnvironmentService.create.mockResolvedValue(environment);
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
        name: "Local",
        driver: "local",
        config: {},
      });

    expect(res.status).toBe(201);
    expect(mockAccessService.canUser).toHaveBeenCalledWith(
      "company-1",
      "user-1",
      "environments:manage",
    );
  });

  it("rejects non-admin board users without environments:manage", async () => {
    mockAccessService.canUser.mockResolvedValue(false);
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
        name: "Local",
        driver: "local",
        config: {},
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("environments:manage");
    expect(mockEnvironmentService.create).not.toHaveBeenCalled();
  });

  it("allows agents with explicit environments:manage grants to create environments", async () => {
    const environment = createEnvironment();
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      role: "engineer",
      permissions: { canCreateAgents: false },
    });
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockEnvironmentService.create.mockResolvedValue(environment);
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/companies/company-1/environments")
      .send({
        name: "Local",
        driver: "local",
        config: {},
      });

    expect(res.status).toBe(201);
    expect(mockAccessService.hasPermission).toHaveBeenCalledWith(
      "company-1",
      "agent",
      "agent-1",
      "environments:manage",
    );
  });

  it("rejects invalid SSH config on create", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .post("/api/companies/company-1/environments")
      .send({
        name: "SSH Fixture",
        driver: "ssh",
        config: {
          host: "ssh.example.test",
          username: "ssh-user",
        },
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("remote workspace path");
    expect(mockEnvironmentService.create).not.toHaveBeenCalled();
  });

  it("normalizes SSH private keys into secret refs before persistence", async () => {
    const environment = {
      ...createEnvironment(),
      id: "env-ssh",
      name: "SSH Fixture",
      driver: "ssh" as const,
      config: {
        host: "ssh.example.test",
        port: 22,
        username: "ssh-user",
        remoteWorkspacePath: "/srv/paperclip/workspace",
        privateKey: null,
        privateKeySecretRef: {
          type: "secret_ref",
          secretId: "11111111-1111-1111-1111-111111111111",
          version: "latest",
        },
        knownHosts: null,
        strictHostKeyChecking: true,
      },
    };
    mockEnvironmentService.create.mockResolvedValue(environment);
    const pluginWorkerManager = {};
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    }, { pluginWorkerManager });

    const res = await request(app)
      .post("/api/companies/company-1/environments")
      .send({
        name: "SSH Fixture",
        driver: "ssh",
        config: {
          host: "ssh.example.test",
          username: "ssh-user",
          remoteWorkspacePath: "/srv/paperclip/workspace",
          privateKey: "  super-secret-key  ",
        },
      });

    expect(res.status).toBe(201);
    expect(mockEnvironmentService.create).toHaveBeenCalledWith("company-1", expect.objectContaining({
      config: expect.objectContaining({
        privateKey: null,
        privateKeySecretRef: {
          type: "secret_ref",
          secretId: "11111111-1111-1111-1111-111111111111",
          version: "latest",
        },
      }),
    }));
    expect(JSON.stringify(mockEnvironmentService.create.mock.calls[0][1])).not.toContain("super-secret-key");
    expect(mockSecretService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        provider: "local_encrypted",
        value: "super-secret-key",
      }),
      expect.any(Object),
    );
  });

  it("rejects persisted fake sandbox environments", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .post("/api/companies/company-1/environments")
      .send({
        name: "Fake Sandbox",
        driver: "sandbox",
        config: {
          provider: "fake",
          image: "  ubuntu:24.04  ",
        },
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("reserved for internal probes");
    expect(mockEnvironmentService.create).not.toHaveBeenCalled();
  });

  it("creates a sandbox environment with normalized Fake plugin config", async () => {
    const environment = {
      ...createEnvironment(),
      id: "env-sandbox-fake-plugin",
      name: "Fake plugin Sandbox",
      driver: "sandbox" as const,
      config: {
        provider: "fake-plugin",
        image: "fake:test",
        timeoutMs: 450000,
        reuseLease: true,
      },
    };
    mockEnvironmentService.create.mockResolvedValue(environment);
    const pluginWorkerManager = {};
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    }, { pluginWorkerManager });

    const res = await request(app)
      .post("/api/companies/company-1/environments")
      .send({
        name: "Fake plugin Sandbox",
        driver: "sandbox",
        config: {
          provider: "fake-plugin",
          image: "fake:test",
          timeoutMs: "450000",
          reuseLease: true,
        },
      });

    expect(res.status).toBe(201);
    expect(mockValidatePluginSandboxProviderConfig).toHaveBeenCalledWith({
      db: expect.anything(),
      workerManager: pluginWorkerManager,
      provider: "fake-plugin",
      config: {
        image: "fake:test",
        timeoutMs: 450000,
        reuseLease: true,
      },
    });
    expect(mockEnvironmentService.create).toHaveBeenCalledWith("company-1", {
      name: "Fake plugin Sandbox",
      driver: "sandbox",
      status: "active",
      config: {
        provider: "fake-plugin",
        image: "fake:test",
        timeoutMs: 450000,
        reuseLease: true,
      },
    });
    expect(mockSecretService.create).not.toHaveBeenCalled();
  });

  it("creates a schema-driven sandbox environment with secret-ref fields persisted as secrets", async () => {
    const environment = {
      ...createEnvironment(),
      id: "env-sandbox-secure-plugin",
      name: "Secure Sandbox",
      driver: "sandbox" as const,
      config: {
        provider: "secure-plugin",
        template: "base",
        apiKey: "11111111-1111-1111-1111-111111111111",
        timeoutMs: 450000,
        reuseLease: true,
      },
    };
    mockEnvironmentService.create.mockResolvedValue(environment);
    mockValidatePluginSandboxProviderConfig.mockResolvedValue({
      normalizedConfig: {
        template: "base",
        apiKey: "test-provider-key",
        timeoutMs: 450000,
        reuseLease: true,
      },
      pluginId: "plugin-secure",
      pluginKey: "acme.secure-sandbox-provider",
      driver: {
        driverKey: "secure-plugin",
        kind: "sandbox_provider",
        displayName: "Secure Sandbox",
        configSchema: {
          type: "object",
          properties: {
            template: { type: "string" },
            apiKey: { type: "string", format: "secret-ref" },
            timeoutMs: { type: "number" },
            reuseLease: { type: "boolean" },
          },
        },
      },
    });
    const pluginWorkerManager = {};
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    }, { pluginWorkerManager });

    const res = await request(app)
      .post("/api/companies/company-1/environments")
      .send({
        name: "Secure Sandbox",
        driver: "sandbox",
        config: {
          provider: "secure-plugin",
          template: "  base  ",
          apiKey: "  test-provider-key  ",
          timeoutMs: "450000",
          reuseLease: true,
        },
      });

    expect(res.status).toBe(201);
    expect(mockValidatePluginSandboxProviderConfig).toHaveBeenCalledWith({
      db: expect.anything(),
      workerManager: pluginWorkerManager,
      provider: "secure-plugin",
      config: {
        template: "  base  ",
        apiKey: "  test-provider-key  ",
        timeoutMs: 450000,
        reuseLease: true,
      },
    });
    expect(mockEnvironmentService.create).toHaveBeenCalledWith("company-1", {
      name: "Secure Sandbox",
      driver: "sandbox",
      status: "active",
      config: {
        provider: "secure-plugin",
        template: "base",
        apiKey: "11111111-1111-1111-1111-111111111111",
        timeoutMs: 450000,
        reuseLease: true,
      },
    });
    expect(JSON.stringify(mockEnvironmentService.create.mock.calls[0][1])).not.toContain("test-provider-key");
    expect(mockSecretService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        provider: "local_encrypted",
        value: "test-provider-key",
      }),
      expect.any(Object),
    );
  });

  it("validates plugin environment config through the plugin driver host", async () => {
    const environment = {
      ...createEnvironment(),
      id: "env-plugin",
      name: "Plugin Sandbox",
      driver: "plugin" as const,
      config: {
        pluginKey: "acme.environments",
        driverKey: "sandbox",
        driverConfig: {
          template: "normalized",
        },
      },
    };
    mockValidatePluginEnvironmentDriverConfig.mockResolvedValue(environment.config);
    mockEnvironmentService.create.mockResolvedValue(environment);
    const pluginWorkerManager = {};
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    }, { pluginWorkerManager });

    const res = await request(app)
      .post("/api/companies/company-1/environments")
      .send({
        name: "Plugin Sandbox",
        driver: "plugin",
        config: {
          pluginKey: "acme.environments",
          driverKey: "sandbox",
          driverConfig: {
            template: "base",
          },
        },
      });

    expect(res.status).toBe(201);
    expect(mockValidatePluginEnvironmentDriverConfig).toHaveBeenCalledWith({
      db: expect.anything(),
      workerManager: pluginWorkerManager,
      config: {
        pluginKey: "acme.environments",
        driverKey: "sandbox",
        driverConfig: {
          template: "base",
        },
      },
    });
    expect(mockEnvironmentService.create).toHaveBeenCalledWith("company-1", expect.objectContaining({
      config: environment.config,
    }));
  });

  it("rejects unprivileged agent mutations for shared environments", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      role: "engineer",
      permissions: { canCreateAgents: false },
    });
    mockAccessService.hasPermission.mockResolvedValue(false);
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/companies/company-1/environments")
      .send({
        name: "Sandbox host",
        driver: "local",
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("environments:manage");
    expect(mockEnvironmentService.create).not.toHaveBeenCalled();
  });

  it("lists leases for an environment after company access is confirmed", async () => {
    const environment = createEnvironment();
    mockEnvironmentService.getById.mockResolvedValue(environment);
    mockEnvironmentService.listLeases.mockResolvedValue([
      {
        id: "lease-1",
        companyId: "company-1",
        environmentId: environment.id,
        executionWorkspaceId: "workspace-1",
        issueId: null,
        heartbeatRunId: null,
        status: "active",
        providerLeaseId: "provider-lease-1",
        acquiredAt: new Date("2026-04-16T05:00:00.000Z"),
        lastUsedAt: new Date("2026-04-16T05:05:00.000Z"),
        expiresAt: null,
        releasedAt: null,
        metadata: { provider: "fake" },
        createdAt: new Date("2026-04-16T05:00:00.000Z"),
        updatedAt: new Date("2026-04-16T05:05:00.000Z"),
      },
    ]);
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app).get(`/api/environments/${environment.id}/leases?status=active`);

    expect(res.status).toBe(200);
    expect(mockEnvironmentService.listLeases).toHaveBeenCalledWith(environment.id, {
      status: "active",
    });
  });

  it("returns a single lease after company access is confirmed", async () => {
    mockEnvironmentService.getLeaseById.mockResolvedValue({
      id: "lease-1",
      companyId: "company-1",
      environmentId: "env-1",
      executionWorkspaceId: "workspace-1",
      issueId: null,
      heartbeatRunId: "run-1",
      status: "active",
      leasePolicy: "ephemeral",
      provider: "ssh",
      providerLeaseId: "ssh://ssh-user@example.test:22/workspace",
      acquiredAt: new Date("2026-04-16T05:00:00.000Z"),
      lastUsedAt: new Date("2026-04-16T05:05:00.000Z"),
      expiresAt: null,
      releasedAt: null,
      failureReason: null,
      cleanupStatus: null,
      metadata: { remoteCwd: "/workspace" },
      createdAt: new Date("2026-04-16T05:00:00.000Z"),
      updatedAt: new Date("2026-04-16T05:05:00.000Z"),
    });
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app).get("/api/environment-leases/lease-1");

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe("ssh");
    expect(mockEnvironmentService.getLeaseById).toHaveBeenCalledWith("lease-1");
  });

  it("rejects cross-company agent access", async () => {
    mockEnvironmentService.list.mockResolvedValue([]);
    const app = createApp({
      type: "agent",
      agentId: "agent-2",
      companyId: "company-2",
      source: "agent_key",
      runId: "run-2",
    });

    const res = await request(app).get("/api/companies/company-1/environments");

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("another company");
    expect(mockEnvironmentService.list).not.toHaveBeenCalled();
  });

  it("logs a redacted update summary instead of raw config or metadata", async () => {
    const environment = createEnvironment();
    mockEnvironmentService.getById.mockResolvedValue(environment);
    mockEnvironmentService.update.mockResolvedValue({
      ...environment,
      status: "archived",
    });
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .patch(`/api/environments/${environment.id}`)
      .send({
        status: "archived",
        config: {
          apiKey: "super-secret",
          token: "another-secret",
        },
        metadata: {
          password: "do-not-log",
        },
      });

    expect(res.status).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "environment.updated",
        details: {
          changedFields: ["config", "metadata", "status"],
          status: "archived",
          configChanged: true,
          configTopLevelKeyCount: expect.any(Number),
          metadataChanged: true,
          metadataTopLevelKeyCount: 1,
        },
      }),
    );
    expect(JSON.stringify(mockLogActivity.mock.calls[0][1].details)).not.toContain("super-secret");
    expect(JSON.stringify(mockLogActivity.mock.calls[0][1].details)).not.toContain("do-not-log");
  });

  it("resets config instead of inheriting SSH secrets when switching to local without an explicit config", async () => {
    const environment = {
      ...createEnvironment(),
      name: "SSH Fixture",
      driver: "ssh" as const,
      config: {
        host: "ssh.example.test",
        port: 22,
        username: "ssh-user",
        remoteWorkspacePath: "/srv/paperclip/workspace",
        privateKey: "super-secret-key",
        knownHosts: "known-host",
        strictHostKeyChecking: true,
      },
    };
    mockEnvironmentService.getById.mockResolvedValue(environment);
    mockEnvironmentService.update.mockResolvedValue({
      ...createEnvironment(),
      driver: "local" as const,
      config: {},
    });
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .patch(`/api/environments/${environment.id}`)
      .send({
        driver: "local",
      });

    expect(res.status).toBe(200);
    expect(mockEnvironmentService.update).toHaveBeenCalledWith(environment.id, {
      driver: "local",
      config: {},
    });
    expect(JSON.stringify(mockEnvironmentService.update.mock.calls[0][1])).not.toContain("super-secret-key");
    expect(JSON.stringify(mockEnvironmentService.update.mock.calls[0][1])).not.toContain("known-host");
  });

  it("requires explicit SSH config when switching from local to SSH", async () => {
    mockEnvironmentService.getById.mockResolvedValue(createEnvironment());
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .patch("/api/environments/env-1")
      .send({
        driver: "ssh",
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("host");
    expect(mockEnvironmentService.update).not.toHaveBeenCalled();
  });

  it("rejects switching an environment to the built-in fake sandbox provider", async () => {
    mockEnvironmentService.getById.mockResolvedValue(createEnvironment());
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .patch("/api/environments/env-1")
      .send({
        driver: "sandbox",
        config: {
          provider: "fake",
          image: "ubuntu:24.04",
        },
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("reserved for internal probes");
    expect(mockEnvironmentService.update).not.toHaveBeenCalled();
  });

  it("returns 404 when patching a missing environment", async () => {
    mockEnvironmentService.getById.mockResolvedValue(null);
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .patch("/api/environments/missing-env")
      .send({ status: "archived" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Environment not found");
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("probes an SSH environment and logs the result", async () => {
    const environment = {
      ...createEnvironment(),
      name: "SSH Fixture",
      driver: "ssh" as const,
      config: {
        host: "ssh.example.test",
        port: 22,
        username: "ssh-user",
        remoteWorkspacePath: "/srv/paperclip/workspace",
        privateKey: null,
        knownHosts: null,
        strictHostKeyChecking: true,
      },
    };
    mockEnvironmentService.getById.mockResolvedValue(environment);
    mockProbeEnvironment.mockResolvedValue({
      ok: true,
      driver: "ssh",
      summary: "Connected to ssh-user@ssh.example.test and verified the remote workspace path.",
      details: {
        host: "ssh.example.test",
      },
    });
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
      runId: "run-1",
    });

    const res = await request(app)
      .post(`/api/environments/${environment.id}/probe`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockProbeEnvironment).toHaveBeenCalledWith(expect.anything(), environment, {
      pluginWorkerManager: undefined,
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        action: "environment.probed",
        entityType: "environment",
        entityId: environment.id,
        details: expect.objectContaining({
          driver: "ssh",
          ok: true,
        }),
      }),
    );
  });

  it("probes a sandbox environment and logs the result", async () => {
    const environment = {
      ...createEnvironment(),
      id: "env-sandbox",
      name: "Fake Sandbox",
      driver: "sandbox" as const,
      config: {
        provider: "fake",
        image: "ubuntu:24.04",
        reuseLease: true,
      },
    };
    mockEnvironmentService.getById.mockResolvedValue(environment);
    mockProbeEnvironment.mockResolvedValue({
      ok: true,
      driver: "sandbox",
      summary: "Fake sandbox provider is ready for image ubuntu:24.04.",
      details: {
        provider: "fake",
        image: "ubuntu:24.04",
        reuseLease: true,
      },
    });
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
      runId: "run-1",
    });

    const res = await request(app)
      .post(`/api/environments/${environment.id}/probe`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.driver).toBe("sandbox");
    expect(mockProbeEnvironment).toHaveBeenCalledWith(expect.anything(), environment, {
      pluginWorkerManager: undefined,
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        action: "environment.probed",
        entityType: "environment",
        entityId: environment.id,
        details: expect.objectContaining({
          driver: "sandbox",
          ok: true,
        }),
      }),
    );
  });

  it("probes unsaved provider config without persisting secrets", async () => {
    mockProbeEnvironment.mockResolvedValue({
      ok: true,
      driver: "sandbox",
      summary: "Fake plugin sandbox provider is ready.",
      details: { provider: "fake-plugin" },
    });
    const pluginWorkerManager = {};
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
      runId: "run-1",
    }, { pluginWorkerManager });

    const res = await request(app)
      .post("/api/companies/company-1/environments/probe-config")
      .send({
        name: "Draft Fake plugin",
        driver: "sandbox",
        config: {
          provider: "fake-plugin",
          template: "base",
          apiKey: "unsaved-test-key",
          timeoutMs: 300000,
          reuseLease: true,
        },
      });

    expect(res.status).toBe(200);
    expect(mockEnvironmentService.create).not.toHaveBeenCalled();
    expect(mockSecretService.create).not.toHaveBeenCalled();
    expect(mockProbeEnvironment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: "unsaved",
        driver: "sandbox",
        config: expect.objectContaining({
          apiKey: "unsaved-test-key",
        }),
      }),
      expect.objectContaining({
        pluginWorkerManager,
        resolvedConfig: expect.objectContaining({
          driver: "sandbox",
        }),
      }),
    );
    expect(JSON.stringify(mockLogActivity.mock.calls[0][1].details)).not.toContain("unsaved-test-key");
  });
});
