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

const mockEnvironmentService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  listLeases: vi.fn(),
  getLeaseById: vi.fn(),
}));
const mockExecutionWorkspaceService = vi.hoisted(() => ({
  clearEnvironmentSelection: vi.fn(),
}));
const mockIssueService = vi.hoisted(() => ({
  clearExecutionWorkspaceEnvironmentSelection: vi.fn(),
}));
const mockProjectService = vi.hoisted(() => ({
  clearExecutionWorkspaceEnvironmentSelection: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockProbeEnvironment = vi.hoisted(() => vi.fn());
const mockSecretService = vi.hoisted(() => ({
  create: vi.fn(),
  remove: vi.fn(),
  resolveSecretValue: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  environmentService: () => mockEnvironmentService,
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
}));

vi.mock("../services/environment-probe.js", () => ({
  probeEnvironment: mockProbeEnvironment,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
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
function createApp(actor: Record<string, unknown>) {
  currentActor = actor;
  if (server) return server;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = currentActor;
    next();
  });
  app.use("/api", environmentRoutes({} as any));
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
    mockEnvironmentService.list.mockReset();
    mockEnvironmentService.getById.mockReset();
    mockEnvironmentService.create.mockReset();
    mockEnvironmentService.update.mockReset();
    mockEnvironmentService.remove.mockReset();
    mockEnvironmentService.listLeases.mockReset();
    mockEnvironmentService.getLeaseById.mockReset();
    mockExecutionWorkspaceService.clearEnvironmentSelection.mockReset();
    mockIssueService.clearExecutionWorkspaceEnvironmentSelection.mockReset();
    mockProjectService.clearExecutionWorkspaceEnvironmentSelection.mockReset();
    mockLogActivity.mockReset();
    mockProbeEnvironment.mockReset();
    mockSecretService.create.mockReset();
    mockSecretService.remove.mockReset();
    mockSecretService.resolveSecretValue.mockReset();
    mockSecretService.create.mockResolvedValue({
      id: "11111111-1111-1111-1111-111111111111",
    });
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

  it("returns environment capabilities for the company", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app).get("/api/companies/company-1/environments/capabilities");

    expect(res.status).toBe(200);
    expect(res.body.drivers.ssh).toBe("supported");
    expect(res.body.drivers.local).toBe("supported");
    expect(res.body.sandboxProviders).toBeUndefined();
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

  it("redacts config and metadata for board members without environments:manage", async () => {
    mockEnvironmentService.list.mockResolvedValue([createEnvironment()]);
    mockAccessService.canUser.mockResolvedValue(false);
    const app = createApp({
      type: "board",
      userId: "member-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
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

  it("redacts config and metadata for board detail reads without environments:manage", async () => {
    mockEnvironmentService.getById.mockResolvedValue(createEnvironment());
    mockAccessService.canUser.mockResolvedValue(false);
    const app = createApp({
      type: "board",
      userId: "member-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
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
        metadata: { provider: "local" },
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

  it("rejects environment lease listing for board users without environments:manage", async () => {
    const environment = createEnvironment();
    mockEnvironmentService.getById.mockResolvedValue(environment);
    mockAccessService.canUser.mockResolvedValue(false);
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "dashboard_session",
      companyIds: ["company-1"],
    });

    const res = await request(app).get(`/api/environments/${environment.id}/leases`);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("environments:manage");
    expect(mockEnvironmentService.listLeases).not.toHaveBeenCalled();
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

  it("rejects single-lease reads for board users without environments:manage", async () => {
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
    mockAccessService.canUser.mockResolvedValue(false);
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "dashboard_session",
      companyIds: ["company-1"],
    });

    const res = await request(app).get("/api/environment-leases/lease-1");

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("environments:manage");
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
          configTopLevelKeyCount: 3,
          metadataChanged: true,
          metadataTopLevelKeyCount: 1,
        },
      }),
    );
    expect(JSON.stringify(mockLogActivity.mock.calls[0][1].details)).not.toContain("super-secret");
    expect(JSON.stringify(mockLogActivity.mock.calls[0][1].details)).not.toContain("do-not-log");
  });

  it("preserves the stored SSH private key secret ref on partial config updates", async () => {
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
        privateKeySecretRef: {
          type: "secret_ref",
          secretId: "11111111-1111-1111-1111-111111111111",
          version: "latest",
        },
        knownHosts: null,
        strictHostKeyChecking: true,
      },
    };
    mockEnvironmentService.getById.mockResolvedValue(environment);
    mockEnvironmentService.update.mockResolvedValue({
      ...environment,
      config: {
        ...environment.config,
        port: 2222,
      },
    });
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .patch(`/api/environments/${environment.id}`)
      .send({
        config: {
          port: 2222,
        },
      });

    expect(res.status).toBe(200);
    expect(mockEnvironmentService.update).toHaveBeenCalledWith(
      environment.id,
      expect.objectContaining({
        config: expect.objectContaining({
          host: "ssh.example.test",
          port: 2222,
          username: "ssh-user",
          remoteWorkspacePath: "/srv/paperclip/workspace",
          privateKey: null,
          privateKeySecretRef: {
            type: "secret_ref",
            secretId: "11111111-1111-1111-1111-111111111111",
            version: "latest",
          },
        }),
      }),
    );
    expect(mockSecretService.create).not.toHaveBeenCalled();
    expect(mockSecretService.remove).not.toHaveBeenCalled();
  });

  it("replaces the stored SSH private key secret when a new private key is provided", async () => {
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
        privateKeySecretRef: {
          type: "secret_ref",
          secretId: "22222222-2222-2222-2222-222222222222",
          version: "latest",
        },
        knownHosts: null,
        strictHostKeyChecking: true,
      },
    };
    mockEnvironmentService.getById.mockResolvedValue(environment);
    mockEnvironmentService.update.mockResolvedValue(environment);
    mockSecretService.create.mockResolvedValue({
      id: "33333333-3333-3333-3333-333333333333",
    });
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .patch(`/api/environments/${environment.id}`)
      .send({
        config: {
          privateKey: "  replacement-private-key  ",
        },
      });

    expect(res.status).toBe(200);
    expect(mockEnvironmentService.update).toHaveBeenCalledWith(
      environment.id,
      expect.objectContaining({
        config: expect.objectContaining({
          privateKey: null,
          privateKeySecretRef: {
            type: "secret_ref",
            secretId: "33333333-3333-3333-3333-333333333333",
            version: "latest",
          },
        }),
      }),
    );
    expect(mockSecretService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        provider: "local_encrypted",
        value: "replacement-private-key",
      }),
      expect.any(Object),
    );
    expect(mockSecretService.remove).toHaveBeenCalledWith("22222222-2222-2222-2222-222222222222");
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

  it("deletes an environment and logs the removal", async () => {
    const environment = createEnvironment();
    mockEnvironmentService.getById.mockResolvedValue(environment);
    mockEnvironmentService.remove.mockResolvedValue(environment);
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app).delete(`/api/environments/${environment.id}`);

    expect(res.status).toBe(200);
    expect(mockEnvironmentService.remove).toHaveBeenCalledWith(environment.id);
    expect(mockExecutionWorkspaceService.clearEnvironmentSelection).toHaveBeenCalledWith(
      environment.companyId,
      environment.id,
    );
    expect(mockIssueService.clearExecutionWorkspaceEnvironmentSelection).toHaveBeenCalledWith(
      environment.companyId,
      environment.id,
    );
    expect(mockProjectService.clearExecutionWorkspaceEnvironmentSelection).toHaveBeenCalledWith(
      environment.companyId,
      environment.id,
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "environment.deleted",
        entityId: environment.id,
        details: {
          name: environment.name,
          driver: environment.driver,
          status: environment.status,
        },
      }),
    );
  });

  it("deletes the stored SSH private-key secret after removing the environment", async () => {
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
        privateKeySecretRef: {
          type: "secret_ref",
          secretId: "11111111-1111-4111-8111-111111111111",
          version: "latest",
        },
        knownHosts: null,
        strictHostKeyChecking: true,
      },
    };
    mockEnvironmentService.getById.mockResolvedValue(environment);
    mockEnvironmentService.remove.mockResolvedValue(environment);
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app).delete(`/api/environments/${environment.id}`);

    expect(res.status).toBe(200);
    expect(mockEnvironmentService.remove).toHaveBeenCalledWith(environment.id);
    expect(mockSecretService.remove).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    expect(mockEnvironmentService.remove.mock.invocationCallOrder[0]).toBeLessThan(
      mockSecretService.remove.mock.invocationCallOrder[0],
    );
    expect(mockExecutionWorkspaceService.clearEnvironmentSelection).toHaveBeenCalledWith(
      environment.companyId,
      environment.id,
    );
    expect(mockIssueService.clearExecutionWorkspaceEnvironmentSelection).toHaveBeenCalledWith(
      environment.companyId,
      environment.id,
    );
    expect(mockProjectService.clearExecutionWorkspaceEnvironmentSelection).toHaveBeenCalledWith(
      environment.companyId,
      environment.id,
    );
  });

  it("skips SSH secret cleanup gracefully when stored SSH config no longer parses", async () => {
    const environment = {
      ...createEnvironment(),
      name: "SSH Fixture",
      driver: "ssh" as const,
      config: {
        host: "",
        username: "ssh-user",
      },
    };
    mockEnvironmentService.getById.mockResolvedValue(environment);
    mockEnvironmentService.remove.mockResolvedValue(environment);
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app).delete(`/api/environments/${environment.id}`);

    expect(res.status).toBe(200);
    expect(mockEnvironmentService.remove).toHaveBeenCalledWith(environment.id);
    expect(mockSecretService.remove).not.toHaveBeenCalled();
  });

  it("returns 404 when deleting a missing environment", async () => {
    mockEnvironmentService.getById.mockResolvedValue(null);
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app).delete("/api/environments/missing-env");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Environment not found");
    expect(mockEnvironmentService.remove).not.toHaveBeenCalled();
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
    expect(mockProbeEnvironment).toHaveBeenCalledWith(expect.anything(), environment);
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

  it("probes unsaved SSH config without persisting secrets", async () => {
    mockProbeEnvironment.mockResolvedValue({
      ok: true,
      driver: "ssh",
      summary: "Connected to ssh-user@ssh.example.test and verified the remote workspace path.",
      details: { remoteCwd: "/srv/paperclip/workspace" },
    });
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/companies/company-1/environments/probe-config")
      .send({
        name: "Draft SSH",
        description: "Probe this SSH target before saving it.",
        driver: "ssh",
        config: {
          host: "ssh.example.test",
          username: "ssh-user",
          remoteWorkspacePath: "/srv/paperclip/workspace",
          privateKey: "unsaved-test-key",
        },
      });

    expect(res.status).toBe(200);
    expect(mockEnvironmentService.create).not.toHaveBeenCalled();
    expect(mockSecretService.create).not.toHaveBeenCalled();
    expect(mockProbeEnvironment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: "unsaved",
        driver: "ssh",
        config: expect.objectContaining({
          privateKey: "unsaved-test-key",
        }),
      }),
      expect.objectContaining({
        resolvedConfig: expect.objectContaining({
          driver: "ssh",
        }),
      }),
    );
    expect(JSON.stringify(mockLogActivity.mock.calls[0][1].details)).not.toContain("unsaved-test-key");
  });
});
