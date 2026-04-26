import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  buildSshEnvLabFixtureConfig,
  getSshEnvLabSupport,
  startSshEnvLabFixture,
  stopSshEnvLabFixture,
} from "@paperclipai/adapter-utils/ssh";
import {
  agents,
  companies,
  companySecretVersions,
  companySecrets,
  createDb,
  environmentLeases,
  environments,
  heartbeatRuns,
  plugins,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { environmentRuntimeService, findReusableSandboxLeaseId } from "../services/environment-runtime.ts";
import { environmentService } from "../services/environments.ts";
import { secretService } from "../services/secrets.ts";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const sshFixtureSupport = await getSshEnvLabSupport();

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres environment runtime tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("findReusableSandboxLeaseId", () => {
  it("matches reusable plugin-backed sandbox leases by provider", () => {
    const selected = findReusableSandboxLeaseId({
      config: {
        provider: "fake-plugin",
        image: "template-b",
        timeoutMs: 300000,
        reuseLease: true,
      },
      leases: [
        {
          providerLeaseId: "sandbox-template-a",
          metadata: {
            provider: "fake-plugin",
            image: "template-a",
            timeoutMs: 300000,
            reuseLease: true,
          },
        },
        {
          providerLeaseId: "sandbox-template-b",
          metadata: {
            provider: "fake-plugin",
            image: "template-b",
            timeoutMs: 300000,
            reuseLease: true,
          },
        },
      ],
    });

    expect(selected).toBe("sandbox-template-b");
  });

  it("requires image identity for reusable fake sandbox leases", () => {
    const selected = findReusableSandboxLeaseId({
      config: {
        provider: "fake",
        image: "ubuntu:24.04",
        reuseLease: true,
      },
      leases: [
        {
          providerLeaseId: "sandbox-image-a",
          metadata: {
            provider: "fake",
            image: "debian:12",
            reuseLease: true,
          },
        },
        {
          providerLeaseId: "sandbox-image-b",
          metadata: {
            provider: "fake",
            image: "ubuntu:24.04",
            reuseLease: true,
          },
        },
      ],
    });

    expect(selected).toBe("sandbox-image-b");
  });
});

describeEmbeddedPostgres("environmentRuntimeService", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let runtime!: ReturnType<typeof environmentRuntimeService>;
  const fixtureRoots: string[] = [];

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("environment-runtime");
    stopDb = started.stop;
    db = createDb(started.connectionString);
    runtime = environmentRuntimeService(db);
  });

  afterEach(async () => {
    while (fixtureRoots.length > 0) {
      const root = fixtureRoots.pop();
      if (!root) continue;
      await stopSshEnvLabFixture(path.join(root, "state.json")).catch(() => undefined);
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    await db.delete(environmentLeases);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(plugins);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedEnvironment(input: {
    driver?: string;
    name?: string;
    status?: "active" | "disabled";
    config?: Record<string, unknown>;
  } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const environmentId = randomUUID();
    const runId = randomUUID();
    let config = input.config ?? {};

    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    if (typeof config.privateKey === "string" && config.privateKey.length > 0) {
      const secret = await secretService(db).create(companyId, {
        name: `environment-runtime-private-key-${randomUUID()}`,
        provider: "local_encrypted",
        value: config.privateKey,
      });
      config = {
        ...config,
        privateKey: null,
        privateKeySecretRef: {
          type: "secret_ref",
          secretId: secret.id,
          version: "latest",
        },
      };
    }
    await db.insert(environments).values({
      id: environmentId,
      companyId,
      name: input.name ?? "Local",
      driver: input.driver ?? "local",
      status: input.status ?? "active",
      config,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: "running",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return {
      companyId,
      environment: {
        id: environmentId,
        companyId,
        name: input.name ?? "Local",
        description: null,
        driver: input.driver ?? "local",
        status: input.status ?? "active",
        config,
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as const,
      runId,
    };
  }

  it("acquires and releases a local run lease through the runtime seam", async () => {
    const { companyId, environment, runId } = await seedEnvironment();

    const acquired = await runtime.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    expect(acquired.lease.status).toBe("active");
    expect(acquired.lease.metadata).toMatchObject({
      driver: "local",
      executionWorkspaceMode: null,
    });
    expect(acquired.leaseContext).toEqual({
      executionWorkspaceId: null,
      executionWorkspaceMode: null,
    });

    const released = await runtime.releaseRunLeases(runId);

    expect(released).toHaveLength(1);
    expect(released[0]?.environment.driver).toBe("local");
    expect(released[0]?.lease.status).toBe("released");

    const rows = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.id, acquired.lease.id));
    expect(rows[0]?.status).toBe("released");
  });

  it("allows projectless runs through the runtime seam", async () => {
    const { companyId, environment, runId } = await seedEnvironment();

    const acquired = await runtime.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    expect(acquired.lease.executionWorkspaceId).toBeNull();
    expect(acquired.leaseContext.executionWorkspaceId).toBeNull();
    expect(acquired.leaseContext.executionWorkspaceMode).toBeNull();
  });

  it("rejects truly unsupported drivers before acquiring a lease", async () => {
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "ssh",
      name: "Fixture SSH",
      config: {
        host: "ssh.example.test",
        port: 22,
        username: "ssh-user",
        remoteWorkspacePath: "/srv/paperclip/workspace",
        privateKey: null,
        knownHosts: null,
        strictHostKeyChecking: true,
      },
    });
    const runtimeWithoutSsh = environmentRuntimeService(db, {
      drivers: [
        {
          driver: "local",
          acquireRunLease: async () => {
            throw new Error("should not acquire");
          },
          releaseRunLease: async () => null,
        },
      ],
    });

    await expect(
      runtimeWithoutSsh.acquireRunLease({
        companyId,
        environment,
        issueId: null,
        heartbeatRunId: runId,
        persistedExecutionWorkspace: null,
      }),
    ).rejects.toThrow('Environment driver "ssh" is not registered in the environment runtime yet.');

    const rows = await db.select().from(environmentLeases);
    expect(rows).toHaveLength(0);
  });

  it("acquires and releases an SSH run lease through the runtime seam", async () => {
    if (!sshFixtureSupport.supported) {
      console.warn(
        `Skipping SSH runtime fixture test: ${sshFixtureSupport.reason ?? "unsupported environment"}`,
      );
      return;
    }

    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-environment-runtime-ssh-"));
    fixtureRoots.push(fixtureRoot);
    const statePath = path.join(fixtureRoot, "state.json");
    const fixture = await startSshEnvLabFixture({ statePath });
    const sshConfig = await buildSshEnvLabFixtureConfig(fixture);
    const healthServer = createServer((req, res) => {
      if (req.url === "/api/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve, reject) => {
      healthServer.once("error", reject);
      healthServer.listen(0, "127.0.0.1", () => resolve());
    });
    const address = healthServer.address();
    if (!address || typeof address === "string") {
      await new Promise<void>((resolve) => healthServer.close(() => resolve()));
      throw new Error("Expected the test health server to listen on a TCP port.");
    }
    const runtimeApiUrl = `http://127.0.0.1:${address.port}`;
    const previousCandidates = process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON;
    process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON = JSON.stringify([runtimeApiUrl]);
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "ssh",
      name: "Fixture SSH",
      config: sshConfig,
    });
    try {
      const acquired = await runtime.acquireRunLease({
        companyId,
        environment,
        issueId: null,
        heartbeatRunId: runId,
        persistedExecutionWorkspace: null,
      });

      expect(acquired.lease.status).toBe("active");
      expect(acquired.lease.providerLeaseId).toContain(`ssh://${sshConfig.username}@${sshConfig.host}:${sshConfig.port}`);
      expect(acquired.lease.metadata).toMatchObject({
        driver: "ssh",
        host: sshConfig.host,
        port: sshConfig.port,
        username: sshConfig.username,
        remoteWorkspacePath: sshConfig.remoteWorkspacePath,
        remoteCwd: sshConfig.remoteWorkspacePath,
        paperclipApiUrl: runtimeApiUrl,
      });

      const released = await runtime.releaseRunLeases(runId);

      expect(released).toHaveLength(1);
      expect(released[0]?.environment.driver).toBe("ssh");
      expect(released[0]?.lease.status).toBe("released");
    } finally {
      if (previousCandidates === undefined) {
        delete process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON;
      } else {
        process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON = previousCandidates;
      }
      await new Promise<void>((resolve) => healthServer.close(() => resolve()));
    }
  });

  it("acquires and releases a fake sandbox run lease through the runtime seam", async () => {
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "sandbox",
      name: "Fake Sandbox",
      config: {
        provider: "fake",
        image: "ubuntu:24.04",
        reuseLease: true,
      },
    });

    const acquired = await runtime.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    expect(acquired.lease.status).toBe("active");
    expect(acquired.lease.providerLeaseId).toBe(`sandbox://fake/${environment.id}`);
    expect(acquired.lease.metadata).toMatchObject({
      driver: "sandbox",
      provider: "fake",
      image: "ubuntu:24.04",
      reuseLease: true,
    });

    const released = await runtime.releaseRunLeases(runId);

    expect(released).toHaveLength(1);
    expect(released[0]?.environment.driver).toBe("sandbox");
    expect(released[0]?.lease.status).toBe("released");
  });

  it("uses plugin-backed sandbox config for execute and release", async () => {
    const pluginId = randomUUID();
    const { companyId, environment: baseEnvironment, runId } = await seedEnvironment();
    const fakePluginConfig = {
      provider: "fake-plugin",
      image: "fake:test",
      timeoutMs: 1234,
      reuseLease: false,
    };
    const environment = {
      ...baseEnvironment,
      name: "Fake Plugin Sandbox",
      driver: "sandbox",
      config: fakePluginConfig,
    };
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: fakePluginConfig,
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.fake-plugin-sandbox-provider",
      packageName: "@paperclipai/plugin-fake-sandbox",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "paperclip.fake-plugin-sandbox-provider",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Fake Plugin Sandbox Provider",
        description: "Test fake plugin provider",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: "fake-plugin",
            kind: "sandbox_provider",
            displayName: "Fake Plugin",
            configSchema: { type: "object" },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string, params: any) => {
        expect(params.config).toEqual(expect.objectContaining({
          image: "fake:test",
          timeoutMs: 1234,
          reuseLease: false,
        }));
        expect(params.config).not.toHaveProperty("provider");
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "sandbox-1",
            metadata: {
              provider: "fake-plugin",
              image: "fake:test",
              timeoutMs: 1234,
              reuseLease: false,
              remoteCwd: "/workspace",
            },
          };
        }
        if (method === "environmentExecute") {
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: "ok\n",
            stderr: "",
          };
        }
        if (method === "environmentReleaseLease") {
          expect(params.config).toEqual({
            image: "fake:test",
            timeoutMs: 1234,
            reuseLease: false,
          });
          expect(params.config).not.toHaveProperty("driver");
          expect(params.config).not.toHaveProperty("executionWorkspaceMode");
          expect(params.config).not.toHaveProperty("pluginId");
          expect(params.config).not.toHaveProperty("pluginKey");
          expect(params.config).not.toHaveProperty("providerMetadata");
          expect(params.config).not.toHaveProperty("provider");
          expect(params.config).not.toHaveProperty("sandboxProviderPlugin");
          return undefined;
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });
    const executed = await runtimeWithPlugin.execute({
      environment,
      lease: acquired.lease,
      command: "printf",
      args: ["ok"],
      cwd: "/workspace",
      env: {},
      timeoutMs: 1000,
    });

    await environmentService(db).update(environment.id, {
      driver: "local",
      config: {},
    });
    const released = await runtimeWithPlugin.releaseRunLeases(runId);

    expect(executed.stdout).toBe("ok\n");
    expect(released).toHaveLength(1);
    expect(released[0]?.lease.status).toBe("released");
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentExecute", expect.anything());
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentReleaseLease", expect.anything());
  });

  it("uses resolved secret-ref config for plugin-backed sandbox execute and release", async () => {
    const pluginId = randomUUID();
    const { companyId, environment: baseEnvironment, runId } = await seedEnvironment();
    const apiSecret = await secretService(db).create(companyId, {
      name: `secure-plugin-api-key-${randomUUID()}`,
      provider: "local_encrypted",
      value: "resolved-provider-key",
    });
    const providerConfig = {
      provider: "secure-plugin",
      template: "base",
      apiKey: apiSecret.id,
      timeoutMs: 1234,
      reuseLease: false,
    };
    const environment = {
      ...baseEnvironment,
      name: "Secure Plugin Sandbox",
      driver: "sandbox",
      config: providerConfig,
    };
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: providerConfig,
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "acme.secure-sandbox-provider",
      packageName: "@acme/secure-sandbox-provider",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.secure-sandbox-provider",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Secure Sandbox Provider",
        description: "Test schema-driven provider",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
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
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string, params: any) => {
        expect(params.config.apiKey).toBe("resolved-provider-key");
        expect(params.config).not.toHaveProperty("provider");
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "sandbox-1",
            metadata: {
              provider: "secure-plugin",
              template: "base",
              apiKey: "resolved-provider-key",
              timeoutMs: 1234,
              reuseLease: false,
              sandboxId: "sandbox-1",
              remoteCwd: "/workspace",
            },
          };
        }
        if (method === "environmentExecute") {
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: "ok\n",
            stderr: "",
          };
        }
        if (method === "environmentReleaseLease") {
          return undefined;
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });
    expect(acquired.lease.metadata).toMatchObject({
      provider: "secure-plugin",
      template: "base",
      apiKey: apiSecret.id,
      timeoutMs: 1234,
      sandboxId: "sandbox-1",
    });
    const executed = await runtimeWithPlugin.execute({
      environment,
      lease: acquired.lease,
      command: "printf",
      args: ["ok"],
      cwd: "/workspace",
      env: {},
      timeoutMs: 1000,
    });

    await environmentService(db).update(environment.id, {
      driver: "local",
      config: {},
    });
    const released = await runtimeWithPlugin.releaseRunLeases(runId);

    expect(executed.stdout).toBe("ok\n");
    expect(released).toHaveLength(1);
    expect(released[0]?.lease.status).toBe("released");
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentExecute", expect.objectContaining({
      config: expect.objectContaining({
        apiKey: "resolved-provider-key",
      }),
    }));
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentReleaseLease", expect.objectContaining({
      config: expect.objectContaining({
        apiKey: "resolved-provider-key",
      }),
    }));
  });

  it("falls back to acquire when plugin-backed sandbox lease resume throws", async () => {
    const pluginId = randomUUID();
    const { companyId, environment: baseEnvironment, runId } = await seedEnvironment();
    const providerConfig = {
      provider: "fake-plugin",
      image: "fake:test",
      timeoutMs: 1234,
      reuseLease: true,
    };
    const environment = {
      ...baseEnvironment,
      name: "Reusable Plugin Sandbox",
      driver: "sandbox",
      config: providerConfig,
    };
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: providerConfig,
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "acme.fake-sandbox-provider",
      packageName: "@acme/fake-sandbox-provider",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.fake-sandbox-provider",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Fake Sandbox Provider",
        description: "Test schema-driven provider",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: "fake-plugin",
            kind: "sandbox_provider",
            displayName: "Fake Plugin",
            configSchema: {
              type: "object",
              properties: {
                image: { type: "string" },
                timeoutMs: { type: "number" },
                reuseLease: { type: "boolean" },
              },
            },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);
    await environmentService(db).acquireLease({
      companyId,
      environmentId: environment.id,
      heartbeatRunId: runId,
      leasePolicy: "reuse_by_environment",
      provider: "fake-plugin",
      providerLeaseId: "stale-plugin-lease",
      metadata: {
        provider: "fake-plugin",
        image: "fake:test",
        timeoutMs: 1234,
        reuseLease: true,
      },
    });

    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentResumeLease") {
          throw new Error("stale sandbox");
        }
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "fresh-plugin-lease",
            metadata: {
              provider: "fake-plugin",
              image: "fake:test",
              timeoutMs: 1234,
              reuseLease: true,
              remoteCwd: "/workspace",
            },
          };
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    expect(acquired.lease.providerLeaseId).toBe("fresh-plugin-lease");
    expect(workerManager.call).toHaveBeenNthCalledWith(1, pluginId, "environmentResumeLease", expect.objectContaining({
      driverKey: "fake-plugin",
      providerLeaseId: "stale-plugin-lease",
    }));
    expect(workerManager.call).toHaveBeenNthCalledWith(2, pluginId, "environmentAcquireLease", expect.objectContaining({
      driverKey: "fake-plugin",
      config: {
        image: "fake:test",
        timeoutMs: 1234,
        reuseLease: true,
      },
      runId,
    }));
  });

  it("releases a sandbox run lease from metadata after the environment config changes", async () => {
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "sandbox",
      name: "Fake Sandbox",
      config: {
        provider: "fake",
        image: "ubuntu:24.04",
        reuseLease: true,
      },
    });

    const acquired = await runtime.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    await environmentService(db).update(environment.id, {
      driver: "local",
      config: {},
    });

    const released = await runtime.releaseRunLeases(runId);

    expect(released).toHaveLength(1);
    expect(released[0]?.lease.id).toBe(acquired.lease.id);
    expect(released[0]?.lease.status).toBe("released");
  });

  it("delegates plugin environment leases through the plugin worker manager", async () => {
    const pluginId = randomUUID();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const workerManager = {
      isRunning: vi.fn(() => true),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "plugin-lease-1",
            expiresAt,
            metadata: {
              driver: "local",
              pluginId: "provider-plugin-id",
              pluginKey: "provider.plugin",
              driverKey: "provider-driver",
              executionWorkspaceMode: "provider-mode",
              provider: "test-provider",
              remoteCwd: "/workspace",
            },
          };
        }
        return undefined;
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, {
      pluginWorkerManager: workerManager,
    });
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "plugin",
      name: "Plugin Fake plugin",
      config: {
        pluginKey: "acme.environments",
        driverKey: "fake-plugin",
        driverConfig: {
          template: "base",
        },
      },
    });

    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "acme.environments",
      packageName: "@acme/paperclip-environments",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.environments",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Acme Environments",
        description: "Test plugin environment driver",
        author: "Acme",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: "fake-plugin",
            displayName: "Fake plugin",
            configSchema: { type: "object" },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentAcquireLease", {
      driverKey: "fake-plugin",
      companyId,
      environmentId: environment.id,
      config: { template: "base" },
      runId,
      workspaceMode: undefined,
    });
    expect(acquired.lease.providerLeaseId).toBe("plugin-lease-1");
    expect(acquired.lease.expiresAt?.toISOString()).toBe(expiresAt);
    expect(acquired.lease.metadata).toMatchObject({
      driver: "plugin",
      pluginId,
      pluginKey: "acme.environments",
      driverKey: "fake-plugin",
      executionWorkspaceMode: null,
      providerMetadata: {
        driver: "local",
        pluginId: "provider-plugin-id",
        pluginKey: "provider.plugin",
        driverKey: "provider-driver",
        executionWorkspaceMode: "provider-mode",
        provider: "test-provider",
        remoteCwd: "/workspace",
      },
    });

    await environmentService(db).update(environment.id, {
      driver: "local",
      config: {},
    });

    const released = await runtimeWithPlugin.releaseRunLeases(runId);

    expect(released).toHaveLength(1);
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentReleaseLease", {
      driverKey: "fake-plugin",
      companyId,
      environmentId: environment.id,
      config: {},
      providerLeaseId: "plugin-lease-1",
      leaseMetadata: expect.objectContaining({
        driver: "plugin",
        pluginId,
        providerMetadata: expect.objectContaining({
          driver: "local",
        }),
      }),
    });
    expect(released[0]?.lease.status).toBe("released");
  });

  it("delegates the full plugin environment lifecycle through the worker manager", async () => {
    const pluginId = randomUUID();
    const workerManager = {
      isRunning: vi.fn(() => true),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "plugin-lease-full",
            metadata: {
              remoteCwd: "/workspace",
            },
          };
        }
        if (method === "environmentResumeLease") {
          return {
            providerLeaseId: "plugin-lease-full",
            metadata: {
              resumed: true,
            },
          };
        }
        if (method === "environmentRealizeWorkspace") {
          return {
            cwd: "/workspace/project",
            metadata: {
              realized: true,
            },
          };
        }
        if (method === "environmentExecute") {
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: "ok\n",
            stderr: "",
            metadata: {
              commandId: "cmd-1",
            },
          };
        }
        return undefined;
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, {
      pluginWorkerManager: workerManager,
    });
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "plugin",
      name: "Plugin Full Lifecycle",
      config: {
        pluginKey: "acme.environments",
        driverKey: "fake-plugin",
        driverConfig: {
          template: "base",
        },
      },
    });

    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "acme.environments",
      packageName: "@acme/paperclip-environments",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.environments",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Acme Environments",
        description: "Test plugin environment driver",
        author: "Acme",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: "fake-plugin",
            displayName: "Fake plugin",
            configSchema: { type: "object" },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });
    const resumed = await runtimeWithPlugin.resumeRunLease({
      environment,
      lease: acquired.lease,
    });
    const realized = await runtimeWithPlugin.realizeWorkspace({
      environment,
      lease: acquired.lease,
      workspace: {
        localPath: "/tmp/project",
        mode: "ephemeral",
      },
    });
    const executed = await runtimeWithPlugin.execute({
      environment,
      lease: acquired.lease,
      command: "echo",
      args: ["ok"],
      cwd: realized.cwd,
      env: { FOO: "bar" },
      stdin: "",
      timeoutMs: 1000,
    });
    const destroyed = await runtimeWithPlugin.destroyRunLease({
      environment,
      lease: acquired.lease,
    });

    expect(resumed).toMatchObject({
      providerLeaseId: "plugin-lease-full",
      metadata: {
        resumed: true,
      },
    });
    expect(realized).toEqual({
      cwd: "/workspace/project",
      metadata: {
        realized: true,
      },
    });
    expect(executed).toMatchObject({
      exitCode: 0,
      timedOut: false,
      stdout: "ok\n",
    });
    expect(destroyed?.status).toBe("failed");
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentResumeLease", {
      driverKey: "fake-plugin",
      companyId,
      environmentId: environment.id,
      config: { template: "base" },
      providerLeaseId: "plugin-lease-full",
      leaseMetadata: expect.objectContaining({
        driver: "plugin",
        pluginId,
      }),
    });
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentRealizeWorkspace", expect.objectContaining({
      driverKey: "fake-plugin",
      companyId,
      environmentId: environment.id,
      config: { template: "base" },
      workspace: {
        localPath: "/tmp/project",
        mode: "ephemeral",
      },
    }));
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentExecute", expect.objectContaining({
      driverKey: "fake-plugin",
      companyId,
      environmentId: environment.id,
      command: "echo",
      args: ["ok"],
      cwd: "/workspace/project",
      env: { FOO: "bar" },
    }));
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentDestroyLease", {
      driverKey: "fake-plugin",
      companyId,
      environmentId: environment.id,
      config: { template: "base" },
      providerLeaseId: "plugin-lease-full",
      leaseMetadata: expect.objectContaining({
        driver: "plugin",
        pluginId,
      }),
    });
  });

  it("releases with the driver captured on the lease even if the environment driver changes later", async () => {
    const { companyId, environment, runId } = await seedEnvironment();
    const environmentsSvc = environmentService(db);
    const localRelease = vi.fn(async ({ lease, status }: { lease: { id: string }; status: "released" | "expired" | "failed" }) =>
      await environmentsSvc.releaseLease(lease.id, status)
    );
    const sshRelease = vi.fn(async () => {
      throw new Error("ssh release should not be called");
    });
    const runtimeWithSpies = environmentRuntimeService(db, {
      drivers: [
        {
          driver: "local",
          acquireRunLease: async (input) => await environmentsSvc.acquireLease({
            companyId: input.companyId,
            environmentId: input.environment.id,
            executionWorkspaceId: input.executionWorkspaceId,
            issueId: input.issueId,
            heartbeatRunId: input.heartbeatRunId,
            metadata: {
              driver: input.environment.driver,
              executionWorkspaceMode: input.executionWorkspaceMode,
            },
          }),
          releaseRunLease: localRelease,
        },
        {
          driver: "ssh",
          acquireRunLease: async () => {
            throw new Error("ssh acquire should not be called");
          },
          releaseRunLease: sshRelease,
        },
      ],
    });

    const acquired = await runtimeWithSpies.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    await environmentsSvc.update(environment.id, { driver: "ssh" });

    const released = await runtimeWithSpies.releaseRunLeases(runId);

    expect(released).toHaveLength(1);
    expect(localRelease).toHaveBeenCalledTimes(1);
    expect(sshRelease).not.toHaveBeenCalled();
    expect(acquired.lease.metadata?.driver).toBe("local");
  });
});
