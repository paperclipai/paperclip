import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  buildSshEnvLabFixtureConfig,
  getSshEnvLabSupport,
  startSshEnvLabFixture,
  stopSshEnvLabFixture,
} from "@paperclipai/adapter-utils/ssh";
import {
  agents,
  builtInManagedResources,
  companies,
  companySecretVersions,
  companySecrets,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRuns,
  plugins,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { resolveEnvironmentDriverConfigForRuntime } from "../services/environment-config.ts";
import {
  SANDBOX_CAPABILITY_KEYS,
  environmentRuntimeService,
  findReusableSandboxLeaseId,
  SandboxOrphanCleanupWriteError,
} from "../services/environment-runtime.ts";
import * as sandboxProviderRuntime from "../services/sandbox-provider-runtime.ts";
import * as environmentsModule from "../services/environments.ts";
import { logger } from "../middleware/logger.ts";
import { environmentService } from "../services/environments.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { secretService } from "../services/secrets.ts";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.ts";
import {
  getActiveStepContext,
  runWithRuntimeParent,
  type StartupSpanContext,
} from "@paperclipai/adapter-utils/acpx-engine/startup-timing";
import { traceparentFromContextToken } from "../instrumentation.ts";
import { ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { buildNativeHarnessBackupManifest } from "../services/native-runtime/native-session-executor.ts";
import { createNativeHarnessBackupStamp } from "../services/native-runtime/native-harness-backup-stamp.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const sshFixtureSupport = await getSshEnvLabSupport();

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres environment runtime tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function reusableRuntimeFingerprint(input: {
  provider: string;
  adapterType: string | null;
  config: Record<string, unknown>;
}) {
  return createHash("sha256").update(stableStringify(input)).digest("hex");
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
  // Give each test its own orphan-cleanup spool directory, so a spool file one
  // test writes never leaks into another test's flush. The default runtime reads
  // this env override when a test does not pass an explicit spool directory.
  let orphanCleanupSpoolDir: string | null = null;
  const previousOrphanCleanupSpoolDir = process.env.SANDBOX_ORPHAN_CLEANUP_SPOOL_DIR;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("environment-runtime");
    stopDb = started.stop;
    db = createDb(started.connectionString);
    runtime = environmentRuntimeService(db);
  });

  beforeEach(async () => {
    orphanCleanupSpoolDir = await mkdtemp(path.join(os.tmpdir(), "orphan-cleanup-spool-"));
    process.env.SANDBOX_ORPHAN_CLEANUP_SPOOL_DIR = orphanCleanupSpoolDir;
  });

  afterEach(async () => {
    if (orphanCleanupSpoolDir) {
      await rm(orphanCleanupSpoolDir, { recursive: true, force: true }).catch(() => undefined);
      orphanCleanupSpoolDir = null;
    }
    if (previousOrphanCleanupSpoolDir === undefined) {
      delete process.env.SANDBOX_ORPHAN_CLEANUP_SPOOL_DIR;
    } else {
      process.env.SANDBOX_ORPHAN_CLEANUP_SPOOL_DIR = previousOrphanCleanupSpoolDir;
    }
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
    await db.delete(executionWorkspaces);
    await db.delete(plugins);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(projects);
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
    const driver = input.driver ?? "local";
    const environmentName = input.name ?? `${driver}-${environmentId.slice(0, 8)}`;
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
      await secretService(db).createBinding({
        companyId,
        secretId: secret.id,
        targetType: "environment",
        targetId: environmentId,
        configPath: "privateKeySecretRef",
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
    const existingLocalEnvironment = driver === "local"
      ? await db
        .select()
        .from(environments)
        .where(eq(environments.driver, "local"))
        .then((rows) => rows[0] ?? null)
      : null;
    const environmentRecord = existingLocalEnvironment ?? {
      id: environmentId,
      name: environmentName,
      description: null,
      driver,
      status: input.status ?? "active",
      config,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    if (!existingLocalEnvironment) {
      await db.insert(environments).values({
        id: environmentRecord.id,
        name: environmentRecord.name,
        driver: environmentRecord.driver,
        status: environmentRecord.status,
        config: environmentRecord.config,
        createdAt: environmentRecord.createdAt,
        updatedAt: environmentRecord.updatedAt,
      });
    }
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
      agentId,
      environment: {
        id: environmentRecord.id,
        companyId,
        name: environmentRecord.name,
        description: environmentRecord.description,
        driver: environmentRecord.driver,
        status: environmentRecord.status,
        config: environmentRecord.config,
        metadata: environmentRecord.metadata,
        createdAt: environmentRecord.createdAt,
        updatedAt: environmentRecord.updatedAt,
      } as const,
      runId,
    };
  }

  async function seedReusablePluginSandboxLease(adapterType: string | null = null) {
    const pluginId = randomUUID();
    const { companyId, agentId, environment: baseEnvironment, runId } = await seedEnvironment();
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
      pluginKey: "acme.reusable-sandbox-provider",
      packageName: "@acme/reusable-sandbox-provider",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.reusable-sandbox-provider",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Reusable Sandbox Provider",
        description: "Test provider with reusable lease support",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: "fake-plugin",
            kind: "sandbox_provider",
            displayName: "Fake Plugin",
            supportsReusableLeases: true,
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
    const executionWorkspaceId = randomUUID();
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: `Workspace ${projectId.slice(0, 8)}`,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Reusable workspace",
      status: "active",
      providerType: "local_fs",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const reusableLease = await environmentService(db).acquireLease({
      companyId,
      environmentId: environment.id,
      executionWorkspaceId,
      heartbeatRunId: runId,
      leasePolicy: "reuse_by_environment",
      provider: "fake-plugin",
      providerLeaseId: "reusable-plugin-lease",
      metadata: {
        agentId,
        driver: "sandbox",
        pluginId,
        pluginKey: "acme.reusable-sandbox-provider",
        sandboxProviderPlugin: true,
        provider: "fake-plugin",
        image: "fake:test",
        timeoutMs: 1234,
        reuseLease: true,
        reusableSandboxLease: {
          version: 1,
          companyId,
          environmentId: environment.id,
          executionWorkspaceId,
          agentId,
          adapterType,
          provider: "fake-plugin",
          runtimeFingerprint: reusableRuntimeFingerprint({
            provider: "fake-plugin",
            adapterType,
            config: providerConfig,
          }),
        },
      },
    });

    return { pluginId, companyId, agentId, environment, runId, executionWorkspaceId, reusableLease };
  }

  it("retains a successful reusable sandbox lease without stopping the provider resource", async () => {
    const { pluginId, runId, reusableLease } = await seedReusablePluginSandboxLease();
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        throw new Error(`Unexpected plugin method while retaining warm lease: ${method}`);
      }),
      getWorker: vi.fn(() => ({
        supportedMethods: [
          "environmentResumeLease",
          "environmentReleaseLease",
          "environmentDestroyLease",
        ],
      })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const released = await runtimeWithPlugin.releaseRunLeases(
      runId,
      "released",
      undefined,
      "keep_running",
    );

    expect(released).toHaveLength(1);
    expect(released[0]?.lease).toMatchObject({
      id: reusableLease.id,
      status: "retained",
      cleanupStatus: "success",
    });
    await expect(environmentService(db).getLeaseById(reusableLease.id)).resolves.toMatchObject({
      status: "retained",
      cleanupStatus: "success",
    });
    expect(workerManager.call).not.toHaveBeenCalled();
  });

  it("stops a reusable sandbox and keeps its lease resumable", async () => {
    const { pluginId, runId, reusableLease } = await seedReusablePluginSandboxLease();
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentReleaseLease") return undefined;
        throw new Error(`Unexpected plugin method while stopping lease: ${method}`);
      }),
      getWorker: vi.fn(() => ({
        supportedMethods: [
          "environmentResumeLease",
          "environmentReleaseLease",
          "environmentDestroyLease",
        ],
      })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const released = await runtimeWithPlugin.releaseRunLeases(
      runId,
      "failed",
      undefined,
      "stop_and_retain",
    );

    expect(released[0]?.lease).toMatchObject({
      id: reusableLease.id,
      status: "released",
    });
    expect(workerManager.call).toHaveBeenCalledWith(
      pluginId,
      "environmentReleaseLease",
      expect.objectContaining({ providerLeaseId: reusableLease.providerLeaseId }),
      expect.any(Number),
    );
  });

  it("resumes the same provider lease on the next per-turn run", async () => {
    const seeded = await seedReusablePluginSandboxLease();
    const workerManager = {
      isRunning: vi.fn((id: string) => id === seeded.pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "sandbox-exact-resume",
            metadata: {
              provider: "fake-plugin",
              image: "fake:test",
              timeoutMs: 1234,
              reuseLease: true,
              remoteCwd: "/workspace",
            },
          };
        }
        if (method === "environmentReleaseLease") return undefined;
        if (method === "environmentResumeLease") {
          return {
            providerLeaseId: "sandbox-exact-resume",
            metadata: {
              provider: "fake-plugin",
              image: "fake:test",
              timeoutMs: 1234,
              reuseLease: true,
              remoteCwd: "/workspace",
            },
          };
        }
        throw new Error(`Unexpected plugin method during exact resume: ${method}`);
      }),
      getWorker: vi.fn(() => ({
        supportedMethods: [
          "environmentResumeLease",
          "environmentReleaseLease",
          "environmentDestroyLease",
        ],
      })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });
    await environmentService(db).releaseLease(seeded.reusableLease.id, "expired");
    const first = await runtimeWithPlugin.acquireRunLease({
      companyId: seeded.companyId,
      environment: seeded.environment,
      issueId: null,
      agentId: seeded.agentId,
      heartbeatRunId: seeded.runId,
      persistedExecutionWorkspace: {
        id: seeded.executionWorkspaceId,
        mode: "shared_workspace",
      },
    });
    await runtimeWithPlugin.releaseRunLeases(
      seeded.runId,
      "released",
      undefined,
      "stop_and_retain",
    );

    const nextRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: nextRunId,
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      invocationSource: "manual",
      status: "running",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId: seeded.companyId,
      environment: seeded.environment,
      issueId: null,
      agentId: seeded.agentId,
      heartbeatRunId: nextRunId,
      persistedExecutionWorkspace: {
        id: seeded.executionWorkspaceId,
        mode: "shared_workspace",
      },
    });

    expect(first.lease.metadata?.sandboxLeaseAcquisition).toEqual({ outcome: "created" });
    expect(acquired.lease.providerLeaseId).toBe("sandbox-exact-resume");
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toEqual({ outcome: "resumed" });
    expect(workerManager.call.mock.calls.filter((call) => call[1] === "environmentAcquireLease"))
      .toHaveLength(1);
  });

  it("destroys a disposable paperclip_runner sandbox after the turn", async () => {
    const { pluginId, runId, reusableLease } = await seedReusablePluginSandboxLease();
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentDestroyLease") return undefined;
        throw new Error(`Unexpected plugin method while destroying lease: ${method}`);
      }),
      getWorker: vi.fn(() => ({
        supportedMethods: [
          "environmentResumeLease",
          "environmentReleaseLease",
          "environmentDestroyLease",
        ],
      })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const released = await runtimeWithPlugin.releaseRunLeases(
      runId,
      "released",
      undefined,
      "destroy",
    );

    expect(released[0]?.lease).toMatchObject({
      id: reusableLease.id,
      status: "expired",
    });
    expect(workerManager.call).toHaveBeenCalledWith(
      pluginId,
      "environmentDestroyLease",
      expect.objectContaining({ providerLeaseId: reusableLease.providerLeaseId }),
      expect.any(Number),
    );
  });

  it("does not destroy native sandbox state when its verified backup is missing", async () => {
    const { pluginId, runId, reusableLease } = await seedReusablePluginSandboxLease();
    await environmentService(db).updateLeaseMetadata(reusableLease.id, {
      ...(reusableLease.metadata ?? {}),
      sandboxLeaseAcquisition: { outcome: "created" },
    });
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        throw new Error(`Provider teardown must not run without a backup: ${method}`);
      }),
      getWorker: vi.fn(() => ({
        supportedMethods: [
          "environmentResumeLease",
          "environmentReleaseLease",
          "environmentDestroyLease",
        ],
      })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });
    const errors: unknown[] = [];

    const released = await runtimeWithPlugin.releaseRunLeases(
      runId,
      "released",
      (_leaseId, error) => errors.push(error),
      "destroy",
    );

    expect(released).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("runner_harness_backup_unavailable");
    expect(workerManager.call).not.toHaveBeenCalled();
    await expect(environmentService(db).getLeaseById(reusableLease.id)).resolves.toMatchObject({
      status: "active",
    });
  });

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
    const { companyId, agentId, environment, runId } = await seedEnvironment({
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
      });

      const released = await runtime.releaseRunLeases(runId);

      expect(released).toHaveLength(1);
      expect(released[0]?.environment.driver).toBe("ssh");
      expect(released[0]?.lease.status).toBe("released");
    } finally {
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
    expect(acquired.lease.providerLeaseId).toMatch(new RegExp(`^sandbox://fake/${runId}/[0-9a-f-]{36}$`));
    expect(acquired.lease.leasePolicy).toBe("ephemeral");
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

  it("releases the remote sandbox when the lease insert rejects a foreign-company binding", async () => {
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "sandbox",
      name: "Foreign-bound Fake Sandbox",
      config: {
        provider: "fake",
        image: "ubuntu:24.04",
        reuseLease: false,
      },
    });

    // A managed reconciliation binds the environment to another company after the
    // route guard read an empty binding list. The lease insert then rejects the
    // foreign-company binding with the 403 `environment_company_mismatch`.
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Co",
      issuePrefix: "OTA",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(builtInManagedResources).values({
      companyId: otherCompanyId,
      bundleKey: "managed-environment",
      resourceKind: "environment",
      resourceKey: "managed-sandbox",
      resourceId: environment.id,
      stockVersion: "1",
      stockHash: "hash",
    });

    const destroySpy = vi.spyOn(sandboxProviderRuntime, "destroySandboxProviderLease");
    try {
      await expect(
        runtime.acquireRunLease({
          companyId,
          environment,
          issueId: null,
          heartbeatRunId: runId,
          persistedExecutionWorkspace: null,
          assertCompanyBinding: true,
        }),
      ).rejects.toMatchObject({
        status: 403,
        details: { code: "environment_company_mismatch" },
      });

      // The acquire records the durable pending-cleanup row before the teardown,
      // so the row lands while the database is proven reachable. The successful
      // teardown then releases the row to the terminal `expired` state, so no
      // active or pending_cleanup row remains for the orphan.
      const leaseRows = await db
        .select()
        .from(environmentLeases)
        .where(eq(environmentLeases.environmentId, environment.id));
      expect(leaseRows).toHaveLength(1);
      expect(leaseRows[0]?.status).toBe("expired");
      expect(leaseRows[0]?.cleanupStatus).toBe("success");

      // The acquire already provisioned the remote sandbox, so it releases the
      // sandbox on the rejection. Without this teardown the rejected insert leaks
      // a live sandbox that no lease row tracks. The teardown carries the
      // provisioned provider lease id.
      expect(destroySpy).toHaveBeenCalledTimes(1);
      expect(destroySpy.mock.calls[0]?.[0]?.providerLeaseId).toMatch(
        new RegExp(`^sandbox://fake/${runId}/[0-9a-f-]{36}$`),
      );
    } finally {
      destroySpy.mockRestore();
    }
  });

  it("destroys the remote plugin sandbox when the lease insert rejects a foreign-company binding", async () => {
    // The Claude login runs on a plugin-backed sandbox provider (Daytona), so this
    // path is the one the login uses. It must also release the remote sandbox when
    // the conditional lease insert rejects a foreign-company binding.
    const pluginId = randomUUID();
    const { companyId, environment: baseEnvironment, runId } = await seedEnvironment();
    const pluginConfig = { provider: "fake-plugin", image: "fake:test", reuseLease: false };
    const environment = {
      ...baseEnvironment,
      name: "Foreign-bound Plugin Sandbox",
      driver: "sandbox",
      config: pluginConfig,
    };
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: pluginConfig,
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

    // A managed reconciliation binds the environment to another company after the
    // route guard read an empty binding list. The lease insert then rejects the
    // foreign-company binding with the 403 `environment_company_mismatch`.
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Co",
      issuePrefix: "OTB",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(builtInManagedResources).values({
      companyId: otherCompanyId,
      bundleKey: "managed-environment",
      resourceKind: "environment",
      resourceKey: "managed-sandbox",
      resourceId: environment.id,
      stockVersion: "1",
      stockHash: "hash",
    });

    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentDestroyLease"] })),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "plugin-lease-1",
            metadata: { provider: "fake-plugin", image: "fake:test", reuseLease: false },
          };
        }
        if (method === "environmentDestroyLease") {
          return undefined;
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    await expect(
      runtimeWithPlugin.acquireRunLease({
        companyId,
        environment,
        issueId: null,
        heartbeatRunId: runId,
        persistedExecutionWorkspace: null,
        assertCompanyBinding: true,
      }),
    ).rejects.toMatchObject({
      status: 403,
      details: { code: "environment_company_mismatch" },
    });

    // The acquire records the durable pending-cleanup row before the teardown,
    // so the row lands while the database is proven reachable. The successful
    // teardown then releases the row to the terminal `expired` state, so no
    // active or pending_cleanup row remains for the orphan.
    const leaseRows = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.environmentId, environment.id));
    expect(leaseRows).toHaveLength(1);
    expect(leaseRows[0]?.status).toBe("expired");
    expect(leaseRows[0]?.cleanupStatus).toBe("success");

    // The acquire provisioned the remote plugin sandbox, so it destroys the
    // sandbox on the rejection. Without this teardown the rejected insert leaks a
    // live sandbox that no lease row tracks.
    const destroyCalls = (workerManager.call as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      (callArgs) => callArgs[1] === "environmentDestroyLease",
    );
    expect(destroyCalls).toHaveLength(1);
    expect(destroyCalls[0]?.[2]).toMatchObject({ providerLeaseId: "plugin-lease-1" });

    await environmentService(db).update(environment.id, { driver: "local", config: {} });
  });

  it("records a durable pending-cleanup lease when the built-in teardown fails after a foreign-company rejection", async () => {
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "sandbox",
      name: "Foreign-bound Fake Sandbox Teardown Fail",
      config: { provider: "fake", image: "ubuntu:24.04", reuseLease: false },
    });
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Co Built-in",
      issuePrefix: "OTC",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(builtInManagedResources).values({
      companyId: otherCompanyId,
      bundleKey: "managed-environment",
      resourceKind: "environment",
      resourceKey: "managed-sandbox",
      resourceId: environment.id,
      stockVersion: "1",
      stockHash: "hash",
    });

    // The remote teardown fails, so the acquire cannot release the sandbox
    // directly. It must record a durable pending-cleanup row instead.
    const destroySpy = vi
      .spyOn(sandboxProviderRuntime, "destroySandboxProviderLease")
      .mockRejectedValue(new Error("teardown failed"));
    try {
      await expect(
        runtime.acquireRunLease({
          companyId,
          environment,
          issueId: null,
          heartbeatRunId: runId,
          persistedExecutionWorkspace: null,
          assertCompanyBinding: true,
        }),
      ).rejects.toMatchObject({ status: 403, details: { code: "environment_company_mismatch" } });

      expect(destroySpy).toHaveBeenCalledTimes(1);
      // The failed teardown left a durable pending-cleanup row that carries the
      // provider lease id for a later sweep.
      const rows = await db
        .select()
        .from(environmentLeases)
        .where(eq(environmentLeases.environmentId, environment.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("pending_cleanup");
      expect(rows[0]?.cleanupStatus).toBe("failed");
      expect(rows[0]?.providerLeaseId).toMatch(new RegExp(`^sandbox://fake/${runId}/[0-9a-f-]{36}$`));
    } finally {
      destroySpy.mockRestore();
    }
  });

  it("records the durable pending-cleanup row before it runs the inline teardown", async () => {
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "sandbox",
      name: "Foreign-bound Fake Sandbox Write First",
      config: { provider: "fake", image: "ubuntu:24.04", reuseLease: false },
    });
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Co Write First",
      issuePrefix: "OWF",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(builtInManagedResources).values({
      companyId: otherCompanyId,
      bundleKey: "managed-environment",
      resourceKind: "environment",
      resourceKey: "managed-sandbox",
      resourceId: environment.id,
      stockVersion: "1",
      stockHash: "hash",
    });

    // The teardown reads the lease table when it runs. A durable pending_cleanup
    // row must already exist, which proves the acquire records the row before the
    // teardown. This ordering closes the window the finding describes: the durable
    // write lands while the database is proven reachable, before the teardown RPC
    // that a database outage could otherwise interrupt.
    let pendingCleanupRowsAtTeardown = -1;
    const destroySpy = vi
      .spyOn(sandboxProviderRuntime, "destroySandboxProviderLease")
      .mockImplementation(async () => {
        const rows = await db
          .select()
          .from(environmentLeases)
          .where(eq(environmentLeases.environmentId, environment.id));
        pendingCleanupRowsAtTeardown = rows.filter((row) => row.status === "pending_cleanup").length;
      });
    try {
      await expect(
        runtime.acquireRunLease({
          companyId,
          environment,
          issueId: null,
          heartbeatRunId: runId,
          persistedExecutionWorkspace: null,
          assertCompanyBinding: true,
        }),
      ).rejects.toMatchObject({ status: 403, details: { code: "environment_company_mismatch" } });

      // The durable row already tracked the orphan when the teardown ran.
      expect(pendingCleanupRowsAtTeardown).toBe(1);
      expect(destroySpy).toHaveBeenCalledTimes(1);

      // The teardown succeeded, so the acquire released the row to the terminal
      // `expired` state and left no pending_cleanup row.
      const rows = await db
        .select()
        .from(environmentLeases)
        .where(eq(environmentLeases.environmentId, environment.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("expired");
      expect(rows[0]?.cleanupStatus).toBe("success");
    } finally {
      destroySpy.mockRestore();
    }
  });

  it("leaves no orphan and no error when the durable write fails but the teardown succeeds", async () => {
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "sandbox",
      name: "Foreign-bound Fake Sandbox Write Fail Teardown Ok",
      config: { provider: "fake", image: "ubuntu:24.04", reuseLease: false },
    });
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Co Write Fail",
      issuePrefix: "OWK",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(builtInManagedResources).values({
      companyId: otherCompanyId,
      bundleKey: "managed-environment",
      resourceKind: "environment",
      resourceKey: "managed-sandbox",
      resourceId: environment.id,
      stockVersion: "1",
      stockHash: "hash",
    });

    // Force every durable pending-cleanup write to fail, but let the teardown
    // succeed. A successful teardown removes the orphan, so the acquire needs no
    // durable row and raises no orphan-cleanup write error. The write-first order
    // never turns a clean teardown into a failure.
    const realEnvironmentService = environmentsModule.environmentService;
    const factorySpy = vi
      .spyOn(environmentsModule, "environmentService")
      .mockImplementation((database: Parameters<typeof realEnvironmentService>[0]) => {
        const real = realEnvironmentService(database);
        return {
          ...real,
          insertPendingCleanupLease: () =>
            Promise.reject(new Error("pending-cleanup write failed; database down")),
        };
      });
    const destroySpy = vi
      .spyOn(sandboxProviderRuntime, "destroySandboxProviderLease")
      .mockResolvedValue(undefined as never);
    try {
      // Set the retry backoff to zero, so the failed write retries never slow the
      // test.
      const runtime = environmentRuntimeService(db, { pendingCleanupWriteBackoffMs: 0 });
      const rejection = await runtime
        .acquireRunLease({
          companyId,
          environment,
          issueId: null,
          heartbeatRunId: runId,
          persistedExecutionWorkspace: null,
          assertCompanyBinding: true,
        })
        .then(
          () => {
            throw new Error("acquireRunLease resolved but must reject");
          },
          (error: unknown) => error,
        );

      // The rejection is the original company mismatch, not an orphan-cleanup
      // write error, because the teardown removed the orphan.
      expect(rejection).not.toBeInstanceOf(SandboxOrphanCleanupWriteError);
      expect(rejection).toMatchObject({ status: 403, details: { code: "environment_company_mismatch" } });
      expect(destroySpy).toHaveBeenCalledTimes(1);

      // No orphan remains and no durable row was needed, so the lease table is
      // empty for the environment.
      const rows = await db
        .select()
        .from(environmentLeases)
        .where(eq(environmentLeases.environmentId, environment.id));
      expect(rows).toHaveLength(0);

      // The buffer holds no orphan, so a flush recovers nothing.
      const flushed = await runtime.flushDeferredOrphanCleanups();
      expect(flushed).toEqual({ recovered: 0, pending: 0 });
    } finally {
      destroySpy.mockRestore();
      factorySpy.mockRestore();
    }
  });

  it("records a durable pending-cleanup lease when the plugin teardown fails after a foreign-company rejection", async () => {
    const pluginId = randomUUID();
    const { companyId, environment: baseEnvironment, runId } = await seedEnvironment();
    const pluginConfig = { provider: "fake-plugin", image: "fake:test", reuseLease: false };
    const environment = {
      ...baseEnvironment,
      name: "Foreign-bound Plugin Sandbox Teardown Fail",
      driver: "sandbox",
      config: pluginConfig,
    };
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: pluginConfig,
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
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Co Plugin",
      issuePrefix: "OTD",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(builtInManagedResources).values({
      companyId: otherCompanyId,
      bundleKey: "managed-environment",
      resourceKind: "environment",
      resourceKey: "managed-sandbox",
      resourceId: environment.id,
      stockVersion: "1",
      stockHash: "hash",
    });

    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentDestroyLease"] })),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "plugin-lease-2",
            metadata: { provider: "fake-plugin", image: "fake:test", reuseLease: false },
          };
        }
        if (method === "environmentDestroyLease") {
          throw new Error("destroy failed");
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    await expect(
      runtimeWithPlugin.acquireRunLease({
        companyId,
        environment,
        issueId: null,
        heartbeatRunId: runId,
        persistedExecutionWorkspace: null,
        assertCompanyBinding: true,
      }),
    ).rejects.toMatchObject({ status: 403, details: { code: "environment_company_mismatch" } });

    // The failed plugin teardown left a durable pending-cleanup row that carries
    // the provider lease id for a later sweep.
    const rows = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.environmentId, environment.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending_cleanup");
    expect(rows[0]?.cleanupStatus).toBe("failed");
    expect(rows[0]?.providerLeaseId).toBe("plugin-lease-2");

    await environmentService(db).update(environment.id, { driver: "local", config: {} });
  });

  it("throws a SandboxOrphanCleanupWriteError when the built-in durable pending-cleanup write also fails", async () => {
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "sandbox",
      name: "Foreign-bound Fake Sandbox Cleanup Write Fail",
      config: { provider: "fake", image: "ubuntu:24.04", reuseLease: false },
    });
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Co Cleanup Write",
      issuePrefix: "OCW",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(builtInManagedResources).values({
      companyId: otherCompanyId,
      bundleKey: "managed-environment",
      resourceKind: "environment",
      resourceKey: "managed-sandbox",
      resourceId: environment.id,
      stockVersion: "1",
      stockHash: "hash",
    });

    // The remote teardown fails, so the acquire tries to record a durable
    // pending-cleanup row instead.
    const destroySpy = vi
      .spyOn(sandboxProviderRuntime, "destroySandboxProviderLease")
      .mockRejectedValue(new Error("teardown failed"));
    // Force the durable pending-cleanup write to fail on every attempt. The
    // write retries a few times, so reject the insert each time and let the
    // primary company-bound acquire reject for real.
    const failingInsert = vi
      .fn<Parameters<ReturnType<typeof environmentService>["insertPendingCleanupLease"]>, Promise<never>>()
      .mockRejectedValue(new Error("pending-cleanup write failed"));
    const realEnvironmentService = environmentsModule.environmentService;
    const factorySpy = vi
      .spyOn(environmentsModule, "environmentService")
      .mockImplementation((database: Parameters<typeof realEnvironmentService>[0]) => {
        const real = realEnvironmentService(database);
        return {
          ...real,
          insertPendingCleanupLease: failingInsert,
        };
      });
    // The durable database write fails, so the only durable handle left is the
    // error log. Capture it to prove the leaked sandbox stays discoverable.
    const logSpy = vi.spyOn(logger, "error").mockImplementation(() => logger);
    try {
      // Set the retry backoff to zero, so the retries never slow the test.
      const runtimeWithFailingCleanup = environmentRuntimeService(db, {
        pendingCleanupWriteBackoffMs: 0,
      });
      const rejection = await runtimeWithFailingCleanup
        .acquireRunLease({
          companyId,
          environment,
          issueId: null,
          heartbeatRunId: runId,
          persistedExecutionWorkspace: null,
          assertCompanyBinding: true,
        })
        .then(
          () => {
            throw new Error("acquireRunLease resolved but must reject");
          },
          (error: unknown) => error,
        );

      // The failed durable write is not swallowed: the acquire throws a
      // SandboxOrphanCleanupWriteError that keeps the original 403 rejection as
      // its cause.
      expect(rejection).toBeInstanceOf(SandboxOrphanCleanupWriteError);
      expect(rejection).toMatchObject({ provider: "fake" });
      expect((rejection as SandboxOrphanCleanupWriteError).cause).toMatchObject({
        status: 403,
        details: { code: "environment_company_mismatch" },
      });
      expect(destroySpy).toHaveBeenCalledTimes(1);
      // The write retried the durable insert before it gave up, so more than one
      // attempt ran.
      expect(failingInsert.mock.calls.length).toBeGreaterThan(1);
      // The durable write failed before it created a row, so no lease row exists.
      const rows = await db
        .select()
        .from(environmentLeases)
        .where(eq(environmentLeases.environmentId, environment.id));
      expect(rows).toHaveLength(0);
      // The durable log preserves the provider identifiers, so an operator keeps
      // a handle to find and tear the leaked sandbox down by hand.
      const cleanupLog = logSpy.mock.calls.find(
        ([fields]) =>
          (fields as { errorKind?: string } | undefined)?.errorKind ===
          "sandbox_orphan_cleanup_write_failed",
      );
      expect(cleanupLog).toBeDefined();
      expect(cleanupLog?.[0]).toMatchObject({
        provider: "fake",
        companyId,
        environmentId: environment.id,
      });
      // The log never carries the caught exception, so no credential leaks.
      expect(cleanupLog?.[0]).not.toHaveProperty("cause");
      expect(cleanupLog?.[0]).not.toHaveProperty("cleanupWriteError");
    } finally {
      logSpy.mockRestore();
      factorySpy.mockRestore();
      destroySpy.mockRestore();
    }
  });

  it("recovers cleanup state when a retry of the durable pending-cleanup write succeeds", async () => {
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "sandbox",
      name: "Foreign-bound Fake Sandbox Cleanup Write Retry",
      config: { provider: "fake", image: "ubuntu:24.04", reuseLease: false },
    });
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Co Cleanup Retry",
      issuePrefix: "OCR",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(builtInManagedResources).values({
      companyId: otherCompanyId,
      bundleKey: "managed-environment",
      resourceKind: "environment",
      resourceKey: "managed-sandbox",
      resourceId: environment.id,
      stockVersion: "1",
      stockHash: "hash",
    });

    // The remote teardown fails, so the acquire tries to record a durable
    // pending-cleanup row instead.
    const destroySpy = vi
      .spyOn(sandboxProviderRuntime, "destroySandboxProviderLease")
      .mockRejectedValue(new Error("teardown failed"));
    // The first durable write attempt fails, so the acquire retries. The second
    // attempt delegates to the real insert, so a durable pending_cleanup row
    // lands and a later sweep can find the orphan.
    let insertAttempts = 0;
    const realEnvironmentService = environmentsModule.environmentService;
    const factorySpy = vi
      .spyOn(environmentsModule, "environmentService")
      .mockImplementation((database: Parameters<typeof realEnvironmentService>[0]) => {
        const real = realEnvironmentService(database);
        return {
          ...real,
          insertPendingCleanupLease: (
            input: Parameters<typeof real.insertPendingCleanupLease>[0],
          ) => {
            insertAttempts += 1;
            if (insertAttempts === 1) {
              return Promise.reject(new Error("pending-cleanup write failed once"));
            }
            return real.insertPendingCleanupLease(input);
          },
        };
      });
    try {
      // Set the retry backoff to zero, so the retry never slows the test.
      const runtimeWithRetry = environmentRuntimeService(db, {
        pendingCleanupWriteBackoffMs: 0,
      });
      const rejection = await runtimeWithRetry
        .acquireRunLease({
          companyId,
          environment,
          issueId: null,
          heartbeatRunId: runId,
          persistedExecutionWorkspace: null,
          assertCompanyBinding: true,
        })
        .then(
          () => {
            throw new Error("acquireRunLease resolved but must reject");
          },
          (error: unknown) => error,
        );

      // The retry landed the durable row, so the acquire rejects with the
      // original company-mismatch rejection, not a SandboxOrphanCleanupWriteError.
      expect(rejection).not.toBeInstanceOf(SandboxOrphanCleanupWriteError);
      expect(rejection).toMatchObject({
        status: 403,
        details: { code: "environment_company_mismatch" },
      });
      expect(destroySpy).toHaveBeenCalledTimes(1);
      // The first attempt failed and the second succeeded, so the write ran twice.
      expect(insertAttempts).toBe(2);
      // A durable pending_cleanup lease row now tracks the orphan, so a sweep can
      // find and release the leaked sandbox.
      const rows = await db
        .select()
        .from(environmentLeases)
        .where(eq(environmentLeases.environmentId, environment.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("pending_cleanup");
      expect(rows[0]?.cleanupStatus).toBe("failed");
      expect(rows[0]?.failureReason).toBe("acquire_rejected_teardown_failed");
    } finally {
      factorySpy.mockRestore();
      destroySpy.mockRestore();
    }
  });

  it("buffers the orphan in-process and a later sweep flush lands the durable row after the database recovers", async () => {
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "sandbox",
      name: "Foreign-bound Fake Sandbox Cleanup Buffer Flush",
      config: { provider: "fake", image: "ubuntu:24.04", reuseLease: false },
    });
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Co Cleanup Buffer",
      issuePrefix: "OCB",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(builtInManagedResources).values({
      companyId: otherCompanyId,
      bundleKey: "managed-environment",
      resourceKind: "environment",
      resourceKey: "managed-sandbox",
      resourceId: environment.id,
      stockVersion: "1",
      stockHash: "hash",
    });

    // The remote teardown fails, so the acquire tries to record a durable
    // pending-cleanup row instead.
    const destroySpy = vi
      .spyOn(sandboxProviderRuntime, "destroySandboxProviderLease")
      .mockRejectedValue(new Error("teardown failed"));
    // The database is down, so every synchronous pending-cleanup write rejects.
    // The flag flips to false when the database recovers, so a later flush lands
    // the durable row.
    let databaseDown = true;
    const realEnvironmentService = environmentsModule.environmentService;
    const factorySpy = vi
      .spyOn(environmentsModule, "environmentService")
      .mockImplementation((database: Parameters<typeof realEnvironmentService>[0]) => {
        const real = realEnvironmentService(database);
        return {
          ...real,
          insertPendingCleanupLease: (
            input: Parameters<typeof real.insertPendingCleanupLease>[0],
          ) => {
            if (databaseDown) {
              return Promise.reject(new Error("pending-cleanup write failed; database down"));
            }
            return real.insertPendingCleanupLease(input);
          },
        };
      });
    const logSpy = vi.spyOn(logger, "error").mockImplementation(() => logger);
    try {
      // Set the retry backoff to zero, so the retries never slow the test.
      const runtime = environmentRuntimeService(db, { pendingCleanupWriteBackoffMs: 0 });
      const rejection = await runtime
        .acquireRunLease({
          companyId,
          environment,
          issueId: null,
          heartbeatRunId: runId,
          persistedExecutionWorkspace: null,
          assertCompanyBinding: true,
        })
        .then(
          () => {
            throw new Error("acquireRunLease resolved but must reject");
          },
          (error: unknown) => error,
        );

      // The synchronous write failed on every attempt, so the acquire still
      // throws the orphan-cleanup write error that keeps the original rejection.
      expect(rejection).toBeInstanceOf(SandboxOrphanCleanupWriteError);
      // The database was down, so no durable row exists yet.
      let rows = await db
        .select()
        .from(environmentLeases)
        .where(eq(environmentLeases.environmentId, environment.id));
      expect(rows).toHaveLength(0);
      // The acquire buffered the orphan in-process, so the log records the buffer.
      const bufferedLog = logSpy.mock.calls.find(
        ([fields]) =>
          (fields as { errorKind?: string } | undefined)?.errorKind ===
          "sandbox_orphan_cleanup_write_failed",
      );
      expect(bufferedLog?.[0]).toMatchObject({ buffered: true });

      // The database recovers, so the next cleanup-sweep flush lands the row.
      databaseDown = false;
      const flushed = await runtime.flushDeferredOrphanCleanups();
      expect(flushed).toEqual({ recovered: 1, pending: 0 });

      // A durable pending_cleanup row now tracks the orphan, so a sweep finds and
      // releases the leaked sandbox.
      rows = await db
        .select()
        .from(environmentLeases)
        .where(eq(environmentLeases.environmentId, environment.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("pending_cleanup");
      expect(rows[0]?.cleanupStatus).toBe("failed");
      expect(rows[0]?.failureReason).toBe("acquire_rejected_teardown_failed");
      expect(rows[0]?.providerLeaseId).toBeTruthy();

      // The buffer is empty now, so a second flush inserts nothing.
      const second = await runtime.flushDeferredOrphanCleanups();
      expect(second).toEqual({ recovered: 0, pending: 0 });
      const rowsAfter = await db
        .select()
        .from(environmentLeases)
        .where(eq(environmentLeases.environmentId, environment.id));
      expect(rowsAfter).toHaveLength(1);
    } finally {
      logSpy.mockRestore();
      factorySpy.mockRestore();
      destroySpy.mockRestore();
    }
  });

  it("persists the orphan to the durable spool so a restart recovers and lands the durable row", async () => {
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "sandbox",
      name: "Foreign-bound Fake Sandbox Cleanup Spool Restart",
      config: { provider: "fake", image: "ubuntu:24.04", reuseLease: false },
    });
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Co Cleanup Spool Restart",
      issuePrefix: "OCS",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(builtInManagedResources).values({
      companyId: otherCompanyId,
      bundleKey: "managed-environment",
      resourceKind: "environment",
      resourceKey: "managed-sandbox",
      resourceId: environment.id,
      stockVersion: "1",
      stockHash: "hash",
    });

    // The remote teardown fails, so the acquire tries to record a durable
    // pending-cleanup row instead.
    const destroySpy = vi
      .spyOn(sandboxProviderRuntime, "destroySandboxProviderLease")
      .mockRejectedValue(new Error("teardown failed"));
    // The database is down, so every synchronous pending-cleanup write rejects.
    // The flag flips to false to simulate the database recovering after a
    // restart.
    let databaseDown = true;
    const realEnvironmentService = environmentsModule.environmentService;
    const factorySpy = vi
      .spyOn(environmentsModule, "environmentService")
      .mockImplementation((database: Parameters<typeof realEnvironmentService>[0]) => {
        const real = realEnvironmentService(database);
        return {
          ...real,
          insertPendingCleanupLease: (
            input: Parameters<typeof real.insertPendingCleanupLease>[0],
          ) => {
            if (databaseDown) {
              return Promise.reject(new Error("pending-cleanup write failed; database down"));
            }
            return real.insertPendingCleanupLease(input);
          },
        };
      });
    const logSpy = vi.spyOn(logger, "error").mockImplementation(() => logger);
    const spoolDir = process.env.SANDBOX_ORPHAN_CLEANUP_SPOOL_DIR!;
    try {
      // The first process acquires, fails every synchronous write, and persists
      // the orphan to the durable spool. The retry backoff is zero, so the test
      // never waits.
      const firstProcessRuntime = environmentRuntimeService(db, { pendingCleanupWriteBackoffMs: 0 });
      const rejection = await firstProcessRuntime
        .acquireRunLease({
          companyId,
          environment,
          issueId: null,
          heartbeatRunId: runId,
          persistedExecutionWorkspace: null,
          assertCompanyBinding: true,
        })
        .then(
          () => {
            throw new Error("acquireRunLease resolved but must reject");
          },
          (error: unknown) => error,
        );
      expect(rejection).toBeInstanceOf(SandboxOrphanCleanupWriteError);

      // The database was down, so no durable row exists yet.
      let rows = await db
        .select()
        .from(environmentLeases)
        .where(eq(environmentLeases.environmentId, environment.id));
      expect(rows).toHaveLength(0);

      // The acquire persisted the orphan to the durable spool, so a file waits on
      // the disk and the log records the durable persist.
      const spoolFiles = (await readdir(spoolDir)).filter((name) => name.endsWith(".json"));
      expect(spoolFiles).toHaveLength(1);
      const persistedLog = logSpy.mock.calls.find(
        ([fields]) =>
          (fields as { errorKind?: string } | undefined)?.errorKind ===
          "sandbox_orphan_cleanup_write_failed",
      );
      expect(persistedLog?.[0]).toMatchObject({ persisted: true });

      // The process restarts. A fresh runtime keeps no in-process buffer, so only
      // the durable spool carries the orphan. The database recovers, so the first
      // cleanup-sweep flush loads the spool and lands the durable row.
      databaseDown = false;
      const restartedRuntime = environmentRuntimeService(db, { pendingCleanupWriteBackoffMs: 0 });
      const flushed = await restartedRuntime.flushDeferredOrphanCleanups();
      expect(flushed).toEqual({ recovered: 1, pending: 0 });

      rows = await db
        .select()
        .from(environmentLeases)
        .where(eq(environmentLeases.environmentId, environment.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("pending_cleanup");
      expect(rows[0]?.failureReason).toBe("acquire_rejected_teardown_failed");
      expect(rows[0]?.providerLeaseId).toBeTruthy();

      // The flush removed the spooled copy after the row landed, so a second
      // restart never re-inserts a duplicate.
      const spoolFilesAfter = (await readdir(spoolDir)).filter((name) => name.endsWith(".json"));
      expect(spoolFilesAfter).toHaveLength(0);
      const secondRestartRuntime = environmentRuntimeService(db, { pendingCleanupWriteBackoffMs: 0 });
      const secondFlush = await secondRestartRuntime.flushDeferredOrphanCleanups();
      expect(secondFlush).toEqual({ recovered: 0, pending: 0 });
      const rowsAfter = await db
        .select()
        .from(environmentLeases)
        .where(eq(environmentLeases.environmentId, environment.id));
      expect(rowsAfter).toHaveLength(1);
    } finally {
      logSpy.mockRestore();
      factorySpy.mockRestore();
      destroySpy.mockRestore();
    }
  });

  it("buffers the orphan in-process when the durable spool write also fails", async () => {
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "sandbox",
      name: "Foreign-bound Fake Sandbox Cleanup Spool Unwritable",
      config: { provider: "fake", image: "ubuntu:24.04", reuseLease: false },
    });
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Co Cleanup Spool Unwritable",
      issuePrefix: "OCU",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(builtInManagedResources).values({
      companyId: otherCompanyId,
      bundleKey: "managed-environment",
      resourceKind: "environment",
      resourceKey: "managed-sandbox",
      resourceId: environment.id,
      stockVersion: "1",
      stockHash: "hash",
    });

    const destroySpy = vi
      .spyOn(sandboxProviderRuntime, "destroySandboxProviderLease")
      .mockRejectedValue(new Error("teardown failed"));
    let databaseDown = true;
    const realEnvironmentService = environmentsModule.environmentService;
    const factorySpy = vi
      .spyOn(environmentsModule, "environmentService")
      .mockImplementation((database: Parameters<typeof realEnvironmentService>[0]) => {
        const real = realEnvironmentService(database);
        return {
          ...real,
          insertPendingCleanupLease: (
            input: Parameters<typeof real.insertPendingCleanupLease>[0],
          ) => {
            if (databaseDown) {
              return Promise.reject(new Error("pending-cleanup write failed; database down"));
            }
            return real.insertPendingCleanupLease(input);
          },
        };
      });
    const logSpy = vi.spyOn(logger, "error").mockImplementation(() => logger);
    try {
      // Point the spool at an unwritable path, so the durable spool write fails
      // like a full or read-only disk. The acquire must fall back to the
      // in-process buffer and never lose the orphan silently.
      const unwritableSpool = {
        append: () => Promise.resolve(false),
        load: () => Promise.resolve([]),
        remove: () => Promise.resolve(),
      };
      const runtime = environmentRuntimeService(db, {
        pendingCleanupWriteBackoffMs: 0,
        orphanCleanupSpool: unwritableSpool,
      });
      await runtime
        .acquireRunLease({
          companyId,
          environment,
          issueId: null,
          heartbeatRunId: runId,
          persistedExecutionWorkspace: null,
          assertCompanyBinding: true,
        })
        .then(
          () => {
            throw new Error("acquireRunLease resolved but must reject");
          },
          () => undefined,
        );

      // The spool write failed, so the log records the in-process-only fallback.
      const fallbackLog = logSpy.mock.calls.find(
        ([fields]) =>
          (fields as { errorKind?: string } | undefined)?.errorKind ===
          "sandbox_orphan_cleanup_write_failed",
      );
      expect(fallbackLog?.[0]).toMatchObject({ persisted: false, buffered: true });

      // The same runtime still keeps the orphan in-process, so a flush after the
      // database recovers lands the durable row.
      databaseDown = false;
      const flushed = await runtime.flushDeferredOrphanCleanups();
      expect(flushed).toEqual({ recovered: 1, pending: 0 });
      const rows = await db
        .select()
        .from(environmentLeases)
        .where(eq(environmentLeases.environmentId, environment.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("pending_cleanup");
    } finally {
      logSpy.mockRestore();
      factorySpy.mockRestore();
      destroySpy.mockRestore();
    }
  });

  it("keeps the buffered orphan when the flush write still fails, then recovers on a later flush", async () => {
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "sandbox",
      name: "Foreign-bound Fake Sandbox Cleanup Buffer Requeue",
      config: { provider: "fake", image: "ubuntu:24.04", reuseLease: false },
    });
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Co Cleanup Requeue",
      issuePrefix: "OCQ",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(builtInManagedResources).values({
      companyId: otherCompanyId,
      bundleKey: "managed-environment",
      resourceKind: "environment",
      resourceKey: "managed-sandbox",
      resourceId: environment.id,
      stockVersion: "1",
      stockHash: "hash",
    });

    const destroySpy = vi
      .spyOn(sandboxProviderRuntime, "destroySandboxProviderLease")
      .mockRejectedValue(new Error("teardown failed"));
    let databaseDown = true;
    const realEnvironmentService = environmentsModule.environmentService;
    const factorySpy = vi
      .spyOn(environmentsModule, "environmentService")
      .mockImplementation((database: Parameters<typeof realEnvironmentService>[0]) => {
        const real = realEnvironmentService(database);
        return {
          ...real,
          insertPendingCleanupLease: (
            input: Parameters<typeof real.insertPendingCleanupLease>[0],
          ) => {
            if (databaseDown) {
              return Promise.reject(new Error("pending-cleanup write failed; database down"));
            }
            return real.insertPendingCleanupLease(input);
          },
        };
      });
    const errorLogSpy = vi.spyOn(logger, "error").mockImplementation(() => logger);
    const warnLogSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    try {
      const runtime = environmentRuntimeService(db, { pendingCleanupWriteBackoffMs: 0 });
      await runtime
        .acquireRunLease({
          companyId,
          environment,
          issueId: null,
          heartbeatRunId: runId,
          persistedExecutionWorkspace: null,
          assertCompanyBinding: true,
        })
        .then(
          () => {
            throw new Error("acquireRunLease resolved but must reject");
          },
          () => undefined,
        );

      // The database is still down, so the flush re-queues the orphan instead of
      // losing it. The buffer keeps the record for a later tick.
      const firstFlush = await runtime.flushDeferredOrphanCleanups();
      expect(firstFlush).toEqual({ recovered: 0, pending: 1 });
      const rowsWhileDown = await db
        .select()
        .from(environmentLeases)
        .where(eq(environmentLeases.environmentId, environment.id));
      expect(rowsWhileDown).toHaveLength(0);
      // The flush logs the re-queue and never carries the caught write exception.
      // The sync-retry path also warns with the same error kind, so match on the
      // `requeued` field that only the flush warn carries.
      const requeueLog = warnLogSpy.mock.calls.find(
        ([fields]) => (fields as { requeued?: boolean } | undefined)?.requeued === true,
      );
      expect(requeueLog).toBeDefined();
      expect(requeueLog?.[0]).toMatchObject({
        errorKind: "sandbox_orphan_cleanup_write_failed",
        requeued: true,
      });
      expect(requeueLog?.[0]).not.toHaveProperty("cause");
      expect(requeueLog?.[0]).not.toHaveProperty("cleanupWriteError");

      // The database recovers, so the next flush lands the durable row exactly
      // once from the still-buffered record.
      databaseDown = false;
      const secondFlush = await runtime.flushDeferredOrphanCleanups();
      expect(secondFlush).toEqual({ recovered: 1, pending: 0 });
      const rowsAfter = await db
        .select()
        .from(environmentLeases)
        .where(eq(environmentLeases.environmentId, environment.id));
      expect(rowsAfter).toHaveLength(1);
      expect(rowsAfter[0]?.status).toBe("pending_cleanup");
    } finally {
      warnLogSpy.mockRestore();
      errorLogSpy.mockRestore();
      factorySpy.mockRestore();
      destroySpy.mockRestore();
    }
  });

  it("throws a SandboxOrphanCleanupWriteError when the plugin durable pending-cleanup write also fails", async () => {
    const pluginId = randomUUID();
    const { companyId, environment: baseEnvironment, runId } = await seedEnvironment();
    const pluginConfig = { provider: "fake-plugin", image: "fake:test", reuseLease: false };
    const environment = {
      ...baseEnvironment,
      name: "Foreign-bound Plugin Sandbox Cleanup Write Fail",
      driver: "sandbox",
      config: pluginConfig,
    };
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: pluginConfig,
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
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Co Plugin Cleanup Write",
      issuePrefix: "OPW",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(builtInManagedResources).values({
      companyId: otherCompanyId,
      bundleKey: "managed-environment",
      resourceKind: "environment",
      resourceKey: "managed-sandbox",
      resourceId: environment.id,
      stockVersion: "1",
      stockHash: "hash",
    });

    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentDestroyLease"] })),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "plugin-lease-write-fail",
            metadata: { provider: "fake-plugin", image: "fake:test", reuseLease: false },
          };
        }
        if (method === "environmentDestroyLease") {
          throw new Error("destroy failed");
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;

    const realEnvironmentService = environmentsModule.environmentService;
    const factorySpy = vi
      .spyOn(environmentsModule, "environmentService")
      .mockImplementation((database: Parameters<typeof realEnvironmentService>[0]) => {
        const real = realEnvironmentService(database);
        return {
          ...real,
          insertPendingCleanupLease: () =>
            Promise.reject(new Error("pending-cleanup write failed")),
        };
      });
    try {
      const runtimeWithPlugin = environmentRuntimeService(db, {
        pluginWorkerManager: workerManager,
        pendingCleanupWriteBackoffMs: 0,
      });
      const rejection = await runtimeWithPlugin
        .acquireRunLease({
          companyId,
          environment,
          issueId: null,
          heartbeatRunId: runId,
          persistedExecutionWorkspace: null,
          assertCompanyBinding: true,
        })
        .then(
          () => {
            throw new Error("acquireRunLease resolved but must reject");
          },
          (error: unknown) => error,
        );

      expect(rejection).toBeInstanceOf(SandboxOrphanCleanupWriteError);
      expect(rejection).toMatchObject({ provider: "fake-plugin", providerLeaseId: "plugin-lease-write-fail" });
      expect((rejection as SandboxOrphanCleanupWriteError).cause).toMatchObject({
        status: 403,
        details: { code: "environment_company_mismatch" },
      });
      // The durable write failed before it created a row, so no lease row exists.
      const rows = await db
        .select()
        .from(environmentLeases)
        .where(eq(environmentLeases.environmentId, environment.id));
      expect(rows).toHaveLength(0);
    } finally {
      factorySpy.mockRestore();
    }

    await environmentService(db).update(environment.id, { driver: "local", config: {} });
  });

  it("records the orphan directly in the pending_cleanup state with one atomic insert", async () => {
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "sandbox",
      name: "Atomic Pending Cleanup Insert",
      config: { provider: "fake", image: "ubuntu:24.04", reuseLease: false },
    });

    const lease = await environmentService(db).insertPendingCleanupLease({
      companyId,
      environmentId: environment.id,
      executionWorkspaceId: null,
      issueId: null,
      heartbeatRunId: runId,
      provider: "fake",
      providerLeaseId: "sandbox://fake/atomic-orphan",
      metadata: { provider: "fake", reuseLease: false },
      failureReason: "acquire_rejected_teardown_failed",
    });

    // The returned lease is already in the terminal recovery state. It never
    // passes through the `active` state, so a crash cannot strand the orphan.
    expect(lease.status).toBe("pending_cleanup");
    expect(lease.cleanupStatus).toBe("failed");
    expect(lease.leasePolicy).toBe("ephemeral");
    expect(lease.failureReason).toBe("acquire_rejected_teardown_failed");
    expect(lease.providerLeaseId).toBe("sandbox://fake/atomic-orphan");
    expect(lease.releasedAt).not.toBeNull();

    // One insert created exactly one row, and the sweep reads that row directly.
    const rows = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.environmentId, environment.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending_cleanup");
    expect(rows[0]?.cleanupStatus).toBe("failed");
  });

  it("tears the recorded built-in provider lease down for a pending-cleanup orphan", async () => {
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "sandbox",
      name: "Cleanup Retry Built-in",
      config: { provider: "fake", image: "ubuntu:24.04", reuseLease: false },
    });
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Co Retry Built-in",
      issuePrefix: "OTE",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(builtInManagedResources).values({
      companyId: otherCompanyId,
      bundleKey: "managed-environment",
      resourceKind: "environment",
      resourceKey: "managed-sandbox",
      resourceId: environment.id,
      stockVersion: "1",
      stockHash: "hash",
    });

    // The first teardown fails, so the acquire records a pending-cleanup orphan.
    // The sweep then retries the teardown, which succeeds this time.
    const destroySpy = vi
      .spyOn(sandboxProviderRuntime, "destroySandboxProviderLease")
      .mockRejectedValueOnce(new Error("teardown failed"))
      .mockResolvedValue(undefined);
    try {
      await expect(
        runtime.acquireRunLease({
          companyId,
          environment,
          issueId: null,
          heartbeatRunId: runId,
          persistedExecutionWorkspace: null,
          assertCompanyBinding: true,
        }),
      ).rejects.toMatchObject({ status: 403, details: { code: "environment_company_mismatch" } });

      const orphan = await db
        .select()
        .from(environmentLeases)
        .where(eq(environmentLeases.environmentId, environment.id))
        .then((r) => r[0]!);
      expect(orphan.status).toBe("pending_cleanup");
      const providerLeaseId = orphan.providerLeaseId;

      // The teardown accepts a null environment and reads the recorded provider
      // lease, so a delete or a provider change never strands it.
      const lease = await environmentService(db).getLeaseById(orphan.id);
      await runtime.retryPendingSandboxTeardown({ environment: null, lease: lease! });
      // The retry called the provider teardown a second time with the orphan
      // provider lease id.
      expect(destroySpy).toHaveBeenCalledTimes(2);
      expect(destroySpy).toHaveBeenLastCalledWith(expect.objectContaining({ providerLeaseId }));
    } finally {
      destroySpy.mockRestore();
    }
  });

  it("throws and keeps the pending-cleanup orphan when the teardown retry fails", async () => {
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "sandbox",
      name: "Cleanup Retry Scope",
      config: { provider: "fake", image: "ubuntu:24.04", reuseLease: false },
    });
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Co Retry Scope",
      issuePrefix: "OTF",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(builtInManagedResources).values({
      companyId: otherCompanyId,
      bundleKey: "managed-environment",
      resourceKind: "environment",
      resourceKey: "managed-sandbox",
      resourceId: environment.id,
      stockVersion: "1",
      stockHash: "hash",
    });

    const destroySpy = vi
      .spyOn(sandboxProviderRuntime, "destroySandboxProviderLease")
      .mockRejectedValue(new Error("teardown failed"));
    try {
      await expect(
        runtime.acquireRunLease({
          companyId,
          environment,
          issueId: null,
          heartbeatRunId: runId,
          persistedExecutionWorkspace: null,
          assertCompanyBinding: true,
        }),
      ).rejects.toMatchObject({ status: 403, details: { code: "environment_company_mismatch" } });

      const orphan = await db
        .select()
        .from(environmentLeases)
        .where(eq(environmentLeases.environmentId, environment.id))
        .then((r) => r[0]!);
      expect(orphan.status).toBe("pending_cleanup");

      // The teardown retries, but the provider destroy still fails, so the
      // teardown throws. The caller keeps the orphan pending for a later sweep.
      const lease = await environmentService(db).getLeaseById(orphan.id);
      await expect(
        runtime.retryPendingSandboxTeardown({ environment: null, lease: lease! }),
      ).rejects.toThrow();

      const still = await db
        .select()
        .from(environmentLeases)
        .where(eq(environmentLeases.id, orphan.id))
        .then((r) => r[0]!);
      expect(still.status).toBe("pending_cleanup");
      expect(still.cleanupStatus).toBe("failed");
    } finally {
      destroySpy.mockRestore();
    }
  });

  it("tears the recorded provider down after the environment provider changes", async () => {
    // Ordering: an acquire provisions a sandbox with provider A, the lease
    // insert rejects a foreign-company binding, and the compensating teardown
    // fails, so the acquire records an orphan for provider A. A provider change
    // then re-points the environment before the sweep runs. The sweep must tear
    // the orphan down from the recorded provider metadata, not the current
    // environment provider, so the change cannot strand the teardown.
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "sandbox",
      name: "Provider Change Vs Orphan",
      config: { provider: "fake", image: "ubuntu:24.04", reuseLease: false },
    });
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Co Provider Change",
      issuePrefix: "OTP",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(builtInManagedResources).values({
      companyId: otherCompanyId,
      bundleKey: "managed-environment",
      resourceKind: "environment",
      resourceKey: "managed-sandbox",
      resourceId: environment.id,
      stockVersion: "1",
      stockHash: "hash",
    });

    const destroySpy = vi
      .spyOn(sandboxProviderRuntime, "destroySandboxProviderLease")
      .mockRejectedValueOnce(new Error("teardown failed"))
      .mockResolvedValue(undefined);
    try {
      await expect(
        runtime.acquireRunLease({
          companyId,
          environment,
          issueId: null,
          heartbeatRunId: runId,
          persistedExecutionWorkspace: null,
          assertCompanyBinding: true,
        }),
      ).rejects.toMatchObject({ status: 403, details: { code: "environment_company_mismatch" } });

      const orphan = await db
        .select()
        .from(environmentLeases)
        .where(eq(environmentLeases.environmentId, environment.id))
        .then((r) => r[0]!);
      expect(orphan.status).toBe("pending_cleanup");
      expect(orphan.provider).toBe("fake");
      const providerLeaseId = orphan.providerLeaseId;

      // The provider-target mutation re-points the environment to a different
      // driver. The orphan teardown must not depend on this current config.
      await environmentService(db).update(environment.id, { driver: "local", config: {} });

      // The teardown tears the recorded provider lease down, so it never reads
      // the re-pointed environment provider.
      const lease = await environmentService(db).getLeaseById(orphan.id);
      await runtime.retryPendingSandboxTeardown({ environment: null, lease: lease! });
      expect(destroySpy).toHaveBeenLastCalledWith(expect.objectContaining({ providerLeaseId }));
    } finally {
      destroySpy.mockRestore();
    }
  });

  it("reports the plugin cleanup worker not ready while its worker is down, then ready after it recovers", async () => {
    // A pending_cleanup orphan targets a plugin-backed provider. The sweep must
    // not consume a finite retry attempt while the plugin worker is briefly down.
    // So the readiness probe reports "not ready" for a down worker and "ready"
    // after the worker recovers. A built-in provider has no worker, so it is
    // always ready.
    const pluginId = randomUUID();
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "sandbox",
      name: "Cleanup Worker Readiness",
      config: { provider: "fake-plugin-ready", image: "fake:test", reuseLease: false },
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.fake-plugin-ready-sandbox-provider",
      packageName: "@paperclipai/plugin-fake-ready-sandbox",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "paperclip.fake-plugin-ready-sandbox-provider",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Fake Plugin Ready Sandbox Provider",
        description: "Test fake plugin provider readiness",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: "fake-plugin-ready",
            kind: "sandbox_provider",
            displayName: "Fake Plugin Ready",
            configSchema: { type: "object" },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);

    // The worker is down at first, then recovers on the second probe.
    let workerRunning = false;
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId && workerRunning),
      call: vi.fn(async () => {
        throw new Error("call must not run during a readiness probe");
      }),
    } as unknown as PluginWorkerManager;

    const orphan = await environmentService(db).insertPendingCleanupLease({
      companyId,
      environmentId: environment.id,
      executionWorkspaceId: null,
      issueId: null,
      heartbeatRunId: runId,
      provider: "fake-plugin-ready",
      providerLeaseId: "plugin-lease-readiness",
      metadata: { provider: "fake-plugin-ready", driver: "sandbox", reuseLease: false },
      failureReason: "acquire_rejected_teardown_failed",
    });
    const lease = (await environmentService(db).getLeaseById(orphan.id))!;

    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    // A down plugin worker is the transient restart window, so the probe reports
    // not ready. The sweep skips the lease without a claim, so no attempt burns.
    await expect(
      runtimeWithPlugin.isPendingCleanupWorkerReady({ environment, lease }),
    ).resolves.toBe(false);
    // The probe never calls the worker; it only checks the live worker state.
    expect((workerManager.call as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();

    // The worker recovers, so the probe now reports ready and the sweep proceeds.
    workerRunning = true;
    await expect(
      runtimeWithPlugin.isPendingCleanupWorkerReady({ environment, lease }),
    ).resolves.toBe(true);

    // A built-in provider has no plugin worker, so its orphan is always ready.
    const builtinOrphan = await environmentService(db).insertPendingCleanupLease({
      companyId,
      environmentId: environment.id,
      executionWorkspaceId: null,
      issueId: null,
      heartbeatRunId: runId,
      provider: "fake",
      providerLeaseId: "builtin-lease-readiness",
      metadata: { provider: "fake", driver: "sandbox", reuseLease: false },
      failureReason: "acquire_rejected_teardown_failed",
    });
    const builtinLease = (await environmentService(db).getLeaseById(builtinOrphan.id))!;
    await expect(
      runtimeWithPlugin.isPendingCleanupWorkerReady({ environment, lease: builtinLease }),
    ).resolves.toBe(true);
  });

  it("reports the plugin cleanup provider not ready while the plugin is not ready, then ready after it recovers", async () => {
    // A pending_cleanup orphan targets a plugin-backed provider. A plugin reload
    // or a plugin reinstall moves the plugin through a "not ready" status. The
    // sweep must not consume a finite retry attempt in that transient window. So
    // the readiness probe reports "not ready" while the plugin status is not
    // "ready", even when its worker runs, and "ready" after the plugin recovers.
    const pluginId = randomUUID();
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "sandbox",
      name: "Cleanup Plugin Readiness",
      config: { provider: "fake-plugin-reload", image: "fake:test", reuseLease: false },
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.fake-plugin-reload-sandbox-provider",
      packageName: "@paperclipai/plugin-fake-reload-sandbox",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "paperclip.fake-plugin-reload-sandbox-provider",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Fake Plugin Reload Sandbox Provider",
        description: "Test fake plugin provider reload readiness",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: "fake-plugin-reload",
            kind: "sandbox_provider",
            displayName: "Fake Plugin Reload",
            configSchema: { type: "object" },
          },
        ],
      },
      // The plugin starts in a not-ready status, as during a reload.
      status: "installing",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);

    // The worker runs the whole time, so the probe result depends on the plugin
    // status alone, not on a down worker.
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async () => {
        throw new Error("call must not run during a readiness probe");
      }),
    } as unknown as PluginWorkerManager;

    const orphan = await environmentService(db).insertPendingCleanupLease({
      companyId,
      environmentId: environment.id,
      executionWorkspaceId: null,
      issueId: null,
      heartbeatRunId: runId,
      provider: "fake-plugin-reload",
      providerLeaseId: "plugin-lease-reload",
      metadata: { provider: "fake-plugin-reload", driver: "sandbox", reuseLease: false },
      failureReason: "acquire_rejected_teardown_failed",
    });
    const lease = (await environmentService(db).getLeaseById(orphan.id))!;

    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    // A not-ready plugin is the transient reload window, so the probe reports
    // not ready. The sweep skips the lease without a claim, so no attempt burns.
    await expect(
      runtimeWithPlugin.isPendingCleanupWorkerReady({ environment, lease }),
    ).resolves.toBe(false);
    expect((workerManager.call as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();

    // The plugin becomes ready, so the probe now reports ready and the sweep
    // proceeds.
    await db.update(plugins).set({ status: "ready" }).where(eq(plugins.id, pluginId));
    await expect(
      runtimeWithPlugin.isPendingCleanupWorkerReady({ environment, lease }),
    ).resolves.toBe(true);
  });

  it("reports the plugin cleanup provider not ready while the plugin is missing, then ready after it returns", async () => {
    // A pending_cleanup orphan targets a plugin-backed provider whose plugin row
    // is gone. A plugin reinstall removes and re-adds the plugin row, so the row
    // is missing for a short window. The sweep must not consume a finite retry
    // attempt in that window. So the readiness probe reports "not ready" while no
    // plugin row resolves the provider, and "ready" after the plugin returns.
    const pluginId = randomUUID();
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "sandbox",
      name: "Cleanup Plugin Missing",
      config: { provider: "fake-plugin-missing", image: "fake:test", reuseLease: false },
    });

    // The worker manager reports the plugin worker as running, so the probe
    // result depends on the missing plugin row alone, not on a down worker.
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async () => {
        throw new Error("call must not run during a readiness probe");
      }),
    } as unknown as PluginWorkerManager;

    const orphan = await environmentService(db).insertPendingCleanupLease({
      companyId,
      environmentId: environment.id,
      executionWorkspaceId: null,
      issueId: null,
      heartbeatRunId: runId,
      provider: "fake-plugin-missing",
      providerLeaseId: "plugin-lease-missing",
      metadata: { provider: "fake-plugin-missing", driver: "sandbox", reuseLease: false },
      failureReason: "acquire_rejected_teardown_failed",
    });
    const lease = (await environmentService(db).getLeaseById(orphan.id))!;

    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    // No plugin row resolves the provider, so the probe reports not ready. The
    // sweep skips the lease without a claim, so no attempt burns while the plugin
    // reinstall is in flight.
    await expect(
      runtimeWithPlugin.isPendingCleanupWorkerReady({ environment, lease }),
    ).resolves.toBe(false);
    expect((workerManager.call as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();

    // The plugin reinstall completes, so a ready plugin row now resolves the
    // provider and the probe reports ready.
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.fake-plugin-missing-sandbox-provider",
      packageName: "@paperclipai/plugin-fake-missing-sandbox",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "paperclip.fake-plugin-missing-sandbox-provider",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Fake Plugin Missing Sandbox Provider",
        description: "Test fake plugin provider missing readiness",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: "fake-plugin-missing",
            kind: "sandbox_provider",
            displayName: "Fake Plugin Missing",
            configSchema: { type: "object" },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);
    await expect(
      runtimeWithPlugin.isPendingCleanupWorkerReady({ environment, lease }),
    ).resolves.toBe(true);
  });

  it("records an orphan with a null reference when a delete already removed the environment", async () => {
    // Ordering: a delete removes the environment before the acquire records the
    // orphan. The environment foreign key must not fail the insert. The record
    // persists with a null reference and its immutable provider metadata, so a
    // later sweep still tears the orphan down.
    const { companyId, environment } = await seedEnvironment({
      driver: "sandbox",
      name: "Delete Before Orphan Record",
      config: { provider: "fake", image: "ubuntu:24.04", reuseLease: false },
    });

    // Remove the environment row first, so the record happens after the delete.
    await environmentService(db).remove(environment.id);

    const orphan = await environmentService(db).insertPendingCleanupLease({
      companyId,
      environmentId: environment.id,
      provider: "fake",
      providerLeaseId: "sandbox://fake/delete-before-record",
      metadata: { provider: "fake", image: "ubuntu:24.04", driver: "sandbox" },
      failureReason: "acquire_rejected_teardown_failed",
    });
    // The insert kept no environment reference, so the delete did not fail it.
    expect(orphan.environmentId).toBeNull();
    expect(orphan.status).toBe("pending_cleanup");

    const destroySpy = vi
      .spyOn(sandboxProviderRuntime, "destroySandboxProviderLease")
      .mockResolvedValue(undefined);
    try {
      // The recorded metadata drives the teardown, so a null environment tears
      // the orphan down.
      const lease = await environmentService(db).getLeaseById(orphan.id);
      await runtime.retryPendingSandboxTeardown({ environment: null, lease: lease! });
      expect(destroySpy).toHaveBeenCalledWith(
        expect.objectContaining({ providerLeaseId: "sandbox://fake/delete-before-record" }),
      );
    } finally {
      destroySpy.mockRestore();
    }
  });

  it("keeps the orphan and tears it down after the environment is deleted", async () => {
    // Ordering: an orphan is recorded, then the environment is deleted. The
    // foreign key sets the reference null instead of cascading the row away, so
    // the orphan survives. The sweep tears it down from the recorded metadata.
    const { companyId, environment } = await seedEnvironment({
      driver: "sandbox",
      name: "Delete After Orphan Record",
      config: { provider: "fake", image: "ubuntu:24.04", reuseLease: false },
    });

    const orphan = await environmentService(db).insertPendingCleanupLease({
      companyId,
      environmentId: environment.id,
      provider: "fake",
      providerLeaseId: "sandbox://fake/delete-after-record",
      metadata: { provider: "fake", image: "ubuntu:24.04", driver: "sandbox" },
      failureReason: "acquire_rejected_teardown_failed",
    });
    expect(orphan.environmentId).toBe(environment.id);

    // Delete the environment row directly. The foreign key sets the lease
    // reference null, so the orphan survives instead of being cascaded away.
    await environmentService(db).remove(environment.id);
    const survived = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.id, orphan.id))
      .then((r) => r[0]!);
    expect(survived.environmentId).toBeNull();
    expect(survived.status).toBe("pending_cleanup");

    const destroySpy = vi
      .spyOn(sandboxProviderRuntime, "destroySandboxProviderLease")
      .mockResolvedValue(undefined);
    try {
      // The recorded metadata drives the teardown, so a null environment tears
      // the orphan down after the delete set the reference null.
      const lease = await environmentService(db).getLeaseById(orphan.id);
      await runtime.retryPendingSandboxTeardown({ environment: null, lease: lease! });
      expect(destroySpy).toHaveBeenCalledWith(
        expect.objectContaining({ providerLeaseId: "sandbox://fake/delete-after-record" }),
      );
    } finally {
      destroySpy.mockRestore();
    }
  });

  // A plugin provider whose config declares an `apiKey` secret-ref field. The
  // orphan teardown must resolve that recorded ref even when the environment
  // binding is gone, so these tests register a provider with a real secret-ref
  // field, unlike the plain `fake-plugin` tests above.
  const SECRET_REF_PLUGIN_KEY = "paperclip.secret-plugin-sandbox-provider";
  const SECRET_REF_PROVIDER = "secret-plugin";

  async function registerSecretRefPluginProvider(): Promise<string> {
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: SECRET_REF_PLUGIN_KEY,
      packageName: "@paperclipai/plugin-secret-sandbox",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: SECRET_REF_PLUGIN_KEY,
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Secret Plugin Sandbox Provider",
        description: "Test plugin provider with a secret-ref config field",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: SECRET_REF_PROVIDER,
            kind: "sandbox_provider",
            displayName: "Secret Plugin",
            configSchema: {
              type: "object",
              properties: {
                apiKey: { type: "string", format: "secret-ref" },
              },
            },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);
    return pluginId;
  }

  // A worker manager mock that records the config of each destroy call, so a
  // test can assert the resolved API key reached the provider teardown.
  function createDestroyRecordingWorkerManager(pluginId: string): {
    workerManager: PluginWorkerManager;
    destroyConfigs: Array<Record<string, unknown> | undefined>;
  } {
    const destroyConfigs: Array<Record<string, unknown> | undefined> = [];
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string, args: any) => {
        if (method === "environmentDestroyLease") {
          destroyConfigs.push(args?.config as Record<string, unknown> | undefined);
          return {};
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    return { workerManager, destroyConfigs };
  }

  async function createApiKeySecret(companyId: string, value: string): Promise<string> {
    const secret = await secretService(db).create(companyId, {
      name: `sandbox-cleanup-api-key-${randomUUID()}`,
      provider: "local_encrypted",
      value,
    });
    return secret.id;
  }

  it("tears down a secret-backed plugin orphan when a delete already removed the environment", async () => {
    // Ordering: a delete removed the environment (and its secret binding) before
    // the acquire recorded the orphan. The recorded config keeps the API-key
    // secret ref, so the teardown must resolve it without the environment
    // binding and send the resolved value to the provider destroy call.
    const pluginId = await registerSecretRefPluginProvider();
    const { companyId, environment } = await seedEnvironment({
      driver: "sandbox",
      name: "Secret Plugin Delete Before Record",
      config: { provider: SECRET_REF_PROVIDER, reuseLease: false },
    });
    const secretId = await createApiKeySecret(companyId, "old-provider-api-key");
    await secretService(db).createBinding({
      companyId,
      secretId,
      targetType: "environment",
      targetId: environment.id,
      configPath: "apiKey",
    });

    // Remove the environment first, so the record happens after the delete.
    await environmentService(db).remove(environment.id);

    const orphan = await environmentService(db).insertPendingCleanupLease({
      companyId,
      environmentId: environment.id,
      provider: SECRET_REF_PROVIDER,
      providerLeaseId: "secret-plugin-lease-delete-before",
      metadata: {
        provider: SECRET_REF_PROVIDER,
        driver: "sandbox",
        sandboxProviderPlugin: true,
        pluginId,
        pluginKey: SECRET_REF_PLUGIN_KEY,
        apiKey: secretId,
        reuseLease: false,
      },
      failureReason: "acquire_rejected_teardown_failed",
    });
    expect(orphan.environmentId).toBeNull();
    expect(orphan.status).toBe("pending_cleanup");

    const { workerManager, destroyConfigs } = createDestroyRecordingWorkerManager(pluginId);
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const lease = await environmentService(db).getLeaseById(orphan.id);
    await runtimeWithPlugin.retryPendingSandboxTeardown({ environment: null, lease: lease! });
    expect(destroyConfigs).toHaveLength(1);
    // The recorded secret ref resolved to the old credential, and the resolved
    // value reached the provider teardown instead of the secret ref.
    expect(destroyConfigs[0]).toMatchObject({ apiKey: "old-provider-api-key" });
    expect(destroyConfigs[0]?.apiKey).not.toBe(secretId);
  });

  it("tears down a secret-backed plugin orphan after the environment is deleted", async () => {
    // Ordering: the orphan is recorded, then a delete removes the environment.
    // The foreign key sets the lease reference null, so the orphan survives. The
    // teardown resolves the recorded API-key ref without the environment.
    const pluginId = await registerSecretRefPluginProvider();
    const { companyId, environment } = await seedEnvironment({
      driver: "sandbox",
      name: "Secret Plugin Delete After Record",
      config: { provider: SECRET_REF_PROVIDER, reuseLease: false },
    });
    const secretId = await createApiKeySecret(companyId, "old-provider-api-key");
    await secretService(db).createBinding({
      companyId,
      secretId,
      targetType: "environment",
      targetId: environment.id,
      configPath: "apiKey",
    });

    const orphan = await environmentService(db).insertPendingCleanupLease({
      companyId,
      environmentId: environment.id,
      provider: SECRET_REF_PROVIDER,
      providerLeaseId: "secret-plugin-lease-delete-after",
      metadata: {
        provider: SECRET_REF_PROVIDER,
        driver: "sandbox",
        sandboxProviderPlugin: true,
        pluginId,
        pluginKey: SECRET_REF_PLUGIN_KEY,
        apiKey: secretId,
        reuseLease: false,
      },
      failureReason: "acquire_rejected_teardown_failed",
    });
    expect(orphan.environmentId).toBe(environment.id);

    // Delete the environment. The foreign key sets the lease reference null, so
    // the orphan survives and the current binding is gone.
    await environmentService(db).remove(environment.id);
    const survived = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.id, orphan.id))
      .then((r) => r[0]!);
    expect(survived.environmentId).toBeNull();

    const { workerManager, destroyConfigs } = createDestroyRecordingWorkerManager(pluginId);
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const lease = await environmentService(db).getLeaseById(orphan.id);
    await runtimeWithPlugin.retryPendingSandboxTeardown({ environment: null, lease: lease! });
    expect(destroyConfigs).toHaveLength(1);
    expect(destroyConfigs[0]).toMatchObject({ apiKey: "old-provider-api-key" });
  });

  it("tears down a secret-backed plugin orphan with the recorded credential after the provider is reconfigured", async () => {
    // Ordering: the orphan is recorded for the old credential, then the
    // environment is reconfigured to a new credential. The environment binding
    // now points to a different secret at the same path. The teardown must
    // resolve the OLD recorded ref, not the new binding, so it destroys the
    // sandbox the old credential provisioned.
    const pluginId = await registerSecretRefPluginProvider();
    const { companyId, environment } = await seedEnvironment({
      driver: "sandbox",
      name: "Secret Plugin Reconfigured",
      config: { provider: SECRET_REF_PROVIDER, reuseLease: false },
    });
    const oldSecretId = await createApiKeySecret(companyId, "old-provider-api-key");

    const orphan = await environmentService(db).insertPendingCleanupLease({
      companyId,
      environmentId: environment.id,
      provider: SECRET_REF_PROVIDER,
      providerLeaseId: "secret-plugin-lease-reconfigured",
      metadata: {
        provider: SECRET_REF_PROVIDER,
        driver: "sandbox",
        sandboxProviderPlugin: true,
        pluginId,
        pluginKey: SECRET_REF_PLUGIN_KEY,
        apiKey: oldSecretId,
        reuseLease: false,
      },
      failureReason: "acquire_rejected_teardown_failed",
    });
    expect(orphan.environmentId).toBe(environment.id);

    // Reconfigure the environment: a new secret replaces the binding at the same
    // path. The old recorded ref is no longer bound to the environment.
    const newSecretId = await createApiKeySecret(companyId, "new-provider-api-key");
    await secretService(db).createBinding({
      companyId,
      secretId: newSecretId,
      targetType: "environment",
      targetId: environment.id,
      configPath: "apiKey",
    });
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      config: { provider: SECRET_REF_PROVIDER, apiKey: newSecretId, reuseLease: false },
    });

    const { workerManager, destroyConfigs } = createDestroyRecordingWorkerManager(pluginId);
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const lease = await environmentService(db).getLeaseById(orphan.id);
    await runtimeWithPlugin.retryPendingSandboxTeardown({ environment: null, lease: lease! });
    expect(destroyConfigs).toHaveLength(1);
    // The teardown resolved the OLD recorded credential, not the new binding.
    expect(destroyConfigs[0]).toMatchObject({ apiKey: "old-provider-api-key" });
    expect(destroyConfigs[0]?.apiKey).not.toBe("new-provider-api-key");

    await environmentService(db).update(environment.id, { driver: "local", config: {} });
  });

  it("tears the recorded plugin provider lease down for a pending-cleanup orphan", async () => {
    const pluginId = randomUUID();
    const { companyId, environment: baseEnvironment, runId } = await seedEnvironment();
    const pluginConfig = { provider: "fake-plugin", image: "fake:test", reuseLease: false };
    const environment = {
      ...baseEnvironment,
      name: "Cleanup Retry Plugin",
      driver: "sandbox",
      config: pluginConfig,
    };
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: pluginConfig,
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
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Co Retry Plugin",
      issuePrefix: "OTG",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(builtInManagedResources).values({
      companyId: otherCompanyId,
      bundleKey: "managed-environment",
      resourceKind: "environment",
      resourceKey: "managed-sandbox",
      resourceId: environment.id,
      stockVersion: "1",
      stockHash: "hash",
    });

    // The first destroy fails, so the acquire records a pending-cleanup orphan.
    // The sweep retries the destroy, which succeeds this time.
    let destroyAttempts = 0;
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentDestroyLease"] })),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "plugin-lease-3",
            metadata: { provider: "fake-plugin", image: "fake:test", reuseLease: false },
          };
        }
        if (method === "environmentDestroyLease") {
          destroyAttempts += 1;
          if (destroyAttempts === 1) {
            throw new Error("destroy failed");
          }
          return {};
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    await expect(
      runtimeWithPlugin.acquireRunLease({
        companyId,
        environment,
        issueId: null,
        heartbeatRunId: runId,
        persistedExecutionWorkspace: null,
        assertCompanyBinding: true,
      }),
    ).rejects.toMatchObject({ status: 403, details: { code: "environment_company_mismatch" } });

    const orphan = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.environmentId, environment.id))
      .then((r) => r[0]!);
    expect(orphan.status).toBe("pending_cleanup");
    expect(orphan.providerLeaseId).toBe("plugin-lease-3");

    const lease = await environmentService(db).getLeaseById(orphan.id);
    await runtimeWithPlugin.retryPendingSandboxTeardown({ environment: null, lease: lease! });
    expect(destroyAttempts).toBe(2);
    const destroyCall = (workerManager.call as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter((callArgs) => callArgs[1] === "environmentDestroyLease")
      .at(-1);
    expect(destroyCall?.[2]).toMatchObject({ providerLeaseId: "plugin-lease-3" });

    await environmentService(db).update(environment.id, { driver: "local", config: {} });
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
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
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
    // The execute call carries the optional log sink as the fifth argument; it
    // is undefined when the caller passes no sink.
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentExecute", expect.anything(), 31000, undefined);
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentReleaseLease", expect.anything(), 31234);
  });

  // Build the fake plugin fixture for the run-parent release tests below. A
  // plugin sandbox provider can open a persistent session on the first command
  // and delete it on lease release; the delete emits a provider
  // `session.close` span. The host mints that span's parent from the active
  // step context at the release RPC. So the release must run under the run
  // parent, or the span loses its traceparent and the backend drops it.
  async function seedFakePluginSandbox() {
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
    return { companyId, environment, runId, pluginId };
  }

  it("runs a plugin-backed lease release under the run-time exec parent, so the teardown span keeps a valid traceparent", async () => {
    const { companyId, environment, runId, pluginId } = await seedFakePluginSandbox();

    // The active step context observed at the moment the host issues the release
    // RPC. The real worker manager mints the provider-span traceparent from
    // exactly this value, so a non-null context with a valid parent proves the
    // teardown span keeps a host-minted parent.
    let releaseStepContext: ReturnType<typeof getActiveStepContext> = null;
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
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
          return { exitCode: 0, signal: null, timedOut: false, stdout: "ok\n", stderr: "" };
        }
        if (method === "environmentReleaseLease") {
          releaseStepContext = getActiveStepContext();
          return undefined;
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    // Build a real host run-parent context and run the first command under it,
    // exactly as the run drives an exec. The driver records this context for the
    // lease and replays it around the later release RPC.
    const runParent: StartupSpanContext = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: 1,
      isRemote: false,
    });
    await runWithRuntimeParent(runParent, () =>
      runtimeWithPlugin.execute({
        environment,
        lease: acquired.lease,
        command: "printf",
        args: ["ok"],
        cwd: "/workspace",
        env: {},
        timeoutMs: 1000,
      }),
    );

    await environmentService(db).update(environment.id, { driver: "local", config: {} });
    const released = await runtimeWithPlugin.releaseRunLeases(runId);

    expect(released).toHaveLength(1);
    // The release RPC ran under the recorded run parent, so the host mints a
    // valid W3C traceparent from it. A dropped span would show a null context.
    expect(releaseStepContext).not.toBeNull();
    expect(releaseStepContext?.parentContext).toBe(runParent);
    expect(traceparentFromContextToken(releaseStepContext?.parentContext)).toBe(
      "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    );
  });

  it("releases a plugin-backed lease with no active step context when the run drove no exec", async () => {
    const { companyId, environment, runId, pluginId } = await seedFakePluginSandbox();

    let releaseStepContext: ReturnType<typeof getActiveStepContext> = null;
    let releaseCalled = false;
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
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
        if (method === "environmentReleaseLease") {
          releaseCalled = true;
          releaseStepContext = getActiveStepContext();
          return undefined;
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });
    await environmentService(db).update(environment.id, { driver: "local", config: {} });
    const released = await runtimeWithPlugin.releaseRunLeases(runId);

    expect(released).toHaveLength(1);
    // No command ran, so no session opened and no teardown span is emitted. The
    // release must not invent a parent from an unrelated ambient context; it
    // runs unwrapped, exactly as before the fix.
    expect(releaseCalled).toBe(true);
    expect(releaseStepContext).toBeNull();
  });

  it("forwards the bypassSession flag to the plugin execute RPC so a pre-run command skips the session", async () => {
    const { companyId, environment, runId, pluginId } = await seedFakePluginSandbox();

    // Capture the params of each environmentExecute RPC, so the test can assert
    // the host forwards `bypassSession` to the provider unchanged.
    const executeParams: Array<Record<string, unknown>> = [];
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string, params: Record<string, unknown>) => {
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
          executeParams.push(params);
          return { exitCode: 0, signal: null, timedOut: false, stdout: "ok\n", stderr: "" };
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    // A pre-run command (the provision command) sets bypassSession explicitly.
    await runtimeWithPlugin.execute({
      environment,
      lease: acquired.lease,
      command: "bash",
      args: ["-lc", "true"],
      cwd: "/workspace",
      env: {},
      timeoutMs: 1000,
      bypassSession: true,
    });
    // An in-run command runs under the run-parent context, so the host does not
    // bypass the session and the provider opens/uses the session.
    const runParent: StartupSpanContext = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: 1,
      isRemote: false,
    });
    await runWithRuntimeParent(runParent, () =>
      runtimeWithPlugin.execute({
        environment,
        lease: acquired.lease,
        command: "printf",
        args: ["ok"],
        cwd: "/workspace",
        env: {},
        timeoutMs: 1000,
      }),
    );

    expect(executeParams).toHaveLength(2);
    expect(executeParams[0]?.bypassSession).toBe(true);
    // An in-run command carries a run parent, so it does not bypass the session.
    expect(executeParams[1]?.bypassSession).toBe(false);
  });

  it("bypasses the session for a context-less command so the setup span keeps a run parent", async () => {
    const { companyId, environment, runId, pluginId } = await seedFakePluginSandbox();

    // Capture the params of each environmentExecute RPC, so the test can assert
    // the host derives `bypassSession` from the active run-parent context.
    const executeParams: Array<Record<string, unknown>> = [];
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string, params: Record<string, unknown>) => {
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
          executeParams.push(params);
          return { exitCode: 0, signal: null, timedOut: false, stdout: "ok\n", stderr: "" };
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    // A command with no active run-parent context (a pre-run install/probe or
    // the agent process launch) runs before the run trace is active. The host
    // mints no plugin RPC traceparent for it, so a session opened here would drop
    // its setup span. The host bypasses the session for such a command.
    await runtimeWithPlugin.execute({
      environment,
      lease: acquired.lease,
      command: "sh",
      args: ["-c", "command -v claude"],
      cwd: "/workspace",
      env: {},
      timeoutMs: 1000,
    });

    expect(executeParams).toHaveLength(1);
    expect(executeParams[0]?.bypassSession).toBe(true);
  });

  it("builds the workspace-realization record with referenced sources for a plugin-backed sandbox realize", async () => {
    // A provider plugin realize handler returns only its realized cwd and provider metadata; it does
    // not build the workspace-realization record. The server must build that record from the run
    // request, so the referenced (mentioned) project sources reach the adapter through
    // `realization.additional`. Without the record the sandbox agent never receives the mentioned
    // projects. This test drives the plugin-backed sandbox realize path and asserts the referenced
    // source survives into the returned record.
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
      name: "Fake Plugin Sandbox Realize",
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
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "sandbox-realize-1",
            metadata: {
              provider: "fake-plugin",
              image: "fake:test",
              timeoutMs: 1234,
              reuseLease: false,
              remoteCwd: "/workspace",
            },
          };
        }
        if (method === "environmentRealizeWorkspace") {
          // Mimic a real provider (for example Daytona): return only the realized cwd and provider
          // metadata, never a `workspaceRealization` record.
          return {
            cwd: "/workspace/project",
            metadata: {
              provider: "fake-plugin",
              remoteCwd: "/workspace/project",
            },
          };
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });
    const workspaceRealizationRequest = {
      version: 1,
      adapterType: "codex_local",
      companyId,
      environmentId: environment.id,
      executionWorkspaceId: null,
      issueId: null,
      heartbeatRunId: runId,
      requestedMode: "ephemeral",
      source: {
        kind: "project_primary",
        localPath: "/tmp/anchor",
        projectId: "anchor-project",
        projectWorkspaceId: "anchor-workspace",
        repoUrl: null,
        repoRef: null,
        strategy: "project_primary",
        branchName: null,
        worktreePath: null,
      },
      additionalSources: [
        {
          localPath: "/tmp/referenced-project",
          projectId: "referenced-project-1",
          projectWorkspaceId: "referenced-workspace-1",
          repoUrl: null,
          repoRef: null,
        },
      ],
    };
    const realized = await runtimeWithPlugin.realizeWorkspace({
      environment,
      lease: acquired.lease,
      workspace: {
        localPath: "/tmp/anchor",
        mode: "ephemeral",
        metadata: { workspaceRealizationRequest },
      },
    });

    // The provider realized cwd and provider metadata survive.
    expect(realized.cwd).toBe("/workspace/project");
    expect(realized.metadata?.provider).toBe("fake-plugin");
    // The server-built record carries the referenced source through `additional`, so the adapter can
    // stage the mentioned project into the sandbox.
    const realization = realized.metadata?.workspaceRealization as Record<string, unknown> | undefined;
    expect(realization).toBeDefined();
    expect(realization?.additional).toEqual([
      expect.objectContaining({
        path: "/tmp/referenced-project",
        projectId: "referenced-project-1",
      }),
    ]);
  });

  it("builds the workspace-realization record with referenced sources for a built-in sandbox realize", async () => {
    // The sandbox driver `realizeWorkspace` has two exits: a plugin-backed provider and a
    // built-in provider. Both must build the same workspace-realization record, so the
    // referenced (mentioned) project sources reach the adapter through `realization.additional`.
    // The test above covers the plugin exit. This test covers the built-in exit (no provider
    // plugin), so a regression on either exit fails a test.
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "sandbox",
      name: "Fake Sandbox Realize",
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

    const workspaceRealizationRequest = {
      version: 1,
      adapterType: "codex_local",
      companyId,
      environmentId: environment.id,
      executionWorkspaceId: null,
      issueId: null,
      heartbeatRunId: runId,
      requestedMode: "ephemeral",
      source: {
        kind: "project_primary",
        localPath: "/tmp/anchor",
        projectId: "anchor-project",
        projectWorkspaceId: "anchor-workspace",
        repoUrl: null,
        repoRef: null,
        strategy: "project_primary",
        branchName: null,
        worktreePath: null,
      },
      additionalSources: [
        {
          localPath: "/tmp/referenced-project",
          projectId: "referenced-project-1",
          projectWorkspaceId: "referenced-workspace-1",
          repoUrl: null,
          repoRef: null,
        },
      ],
    };
    const realized = await runtime.realizeWorkspace({
      environment,
      lease: acquired.lease,
      workspace: {
        localPath: "/tmp/anchor",
        mode: "ephemeral",
        metadata: { workspaceRealizationRequest },
      },
    });

    // The built-in exit builds the record and carries the referenced source through `additional`,
    // so the adapter can stage the mentioned project into the sandbox.
    const realization = realized.metadata?.workspaceRealization as Record<string, unknown> | undefined;
    expect(realization).toBeDefined();
    expect(realization?.additional).toEqual([
      expect.objectContaining({
        path: "/tmp/referenced-project",
        projectId: "referenced-project-1",
      }),
    ]);
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
    await secretService(db).createBinding({
      companyId,
      secretId: apiSecret.id,
      targetType: "environment",
      targetId: environment.id,
      configPath: "apiKey",
    });
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
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
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
    });

    await environmentService(db).update(environment.id, {
      driver: "local",
      config: {},
    });
    const released = await runtimeWithPlugin.releaseRunLeases(runId);

    expect(executed.stdout).toBe("ok\n");
    expect(released).toHaveLength(1);
    expect(released[0]?.lease.status).toBe("released");
    // The execute call carries the optional log sink as the fifth argument; it
    // is undefined when the caller passes no sink.
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentExecute", expect.objectContaining({
      config: expect.objectContaining({
        apiKey: "resolved-provider-key",
      }),
    }), 31234, undefined);
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentReleaseLease", expect.objectContaining({
      config: expect.objectContaining({
        apiKey: "resolved-provider-key",
      }),
    }), 31234);
  });

  it("resolves persisted secret_ref binding objects in sandbox provider config at runtime", async () => {
    const pluginId = randomUUID();
    const { companyId, environment: baseEnvironment } = await seedEnvironment();
    const apiSecret = await secretService(db).create(companyId, {
      name: `secure-plugin-api-key-${randomUUID()}`,
      provider: "local_encrypted",
      value: "resolved-provider-key",
    });
    const providerConfig = {
      provider: "secure-plugin",
      template: "base",
      apiKey: { type: "secret_ref", secretId: apiSecret.id, version: "latest" },
      timeoutMs: 1234,
      reuseLease: false,
    };
    const environment = {
      ...baseEnvironment,
      name: "Secure Plugin Sandbox",
      driver: "sandbox",
      config: providerConfig,
    };
    await secretService(db).createBinding({
      companyId,
      secretId: apiSecret.id,
      targetType: "environment",
      targetId: environment.id,
      configPath: "apiKey",
    });
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

    const resolved = await resolveEnvironmentDriverConfigForRuntime(db, companyId, environment);

    expect(resolved.driver).toBe("sandbox");
    expect(resolved.config).toMatchObject({
      provider: "secure-plugin",
      template: "base",
      apiKey: "resolved-provider-key",
    });
  });

  it("waits briefly for a ready sandbox provider plugin worker to come online", async () => {
    const pluginId = randomUUID();
    const { companyId, environment: baseEnvironment, runId } = await seedEnvironment();
    const providerConfig = {
      provider: "fake-plugin",
      image: "fake:test",
      timeoutMs: 1234,
      reuseLease: false,
    };
    const environment = {
      ...baseEnvironment,
      name: "Eventually Running Plugin Sandbox",
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
      pluginKey: "acme.eventually-running-sandbox-provider",
      packageName: "@acme/eventually-running-sandbox-provider",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.eventually-running-sandbox-provider",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Eventually Running Sandbox Provider",
        description: "Test plugin worker startup grace period",
        author: "Acme",
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

    let runningChecks = 0;
    const workerManager = {
      isRunning: vi.fn((id: string) => {
        if (id !== pluginId) return false;
        runningChecks += 1;
        return runningChecks >= 3;
      }),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "sandbox-1",
            metadata: {
              provider: "fake-plugin",
              image: "fake:test",
              timeoutMs: 1234,
              reuseLease: false,
            },
          };
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, {
      pluginWorkerManager: workerManager,
      pluginWorkerReadyTimeoutMs: 25,
      pluginWorkerReadyPollMs: 1,
    });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    expect(acquired.lease.providerLeaseId).toBe("sandbox-1");
    expect(workerManager.isRunning).toHaveBeenCalledTimes(3);
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentAcquireLease", expect.anything(), 31234);
  });

  it("throws a worker-not-running error once the readiness deadline is exhausted", async () => {
    const pluginId = randomUUID();
    const { companyId, environment: baseEnvironment, runId } = await seedEnvironment();
    const providerConfig = {
      provider: "fake-plugin",
      image: "fake:test",
      timeoutMs: 1234,
      reuseLease: false,
    };
    const environment = {
      ...baseEnvironment,
      name: "Never Running Plugin Sandbox",
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
      pluginKey: "acme.never-running-sandbox-provider",
      packageName: "@acme/never-running-sandbox-provider",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.never-running-sandbox-provider",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Never Running Sandbox Provider",
        description: "Test plugin worker that never comes online before the readiness deadline",
        author: "Acme",
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
      isRunning: vi.fn(() => false),
      call: vi.fn(async (_pluginId: string, method: string) => {
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, {
      pluginWorkerManager: workerManager,
      pluginWorkerReadyTimeoutMs: 25,
      pluginWorkerReadyPollMs: 1,
    });

    await expect(
      runtimeWithPlugin.acquireRunLease({
        companyId,
        environment,
        issueId: null,
        heartbeatRunId: runId,
        persistedExecutionWorkspace: null,
      }),
    ).rejects.toThrow(/worker is not running/);
    // Confirms the loop actually polled repeatedly across the deadline window
    // instead of giving up after a single check.
    expect(workerManager.isRunning.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps polling across a longer worker restart window and succeeds once the handle registers late", async () => {
    const pluginId = randomUUID();
    const { companyId, environment: baseEnvironment, runId } = await seedEnvironment();
    const providerConfig = {
      provider: "fake-plugin",
      image: "fake:test",
      timeoutMs: 1234,
      reuseLease: false,
    };
    const environment = {
      ...baseEnvironment,
      name: "Registered Late Plugin Sandbox",
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
      pluginKey: "acme.registered-late-sandbox-provider",
      packageName: "@acme/registered-late-sandbox-provider",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.registered-late-sandbox-provider",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Registered Late Sandbox Provider",
        description: "Test plugin worker handle that stays unregistered/starting for most of the readiness window",
        author: "Acme",
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

    // Simulates a worker process restart: the handle is absent (or "starting")
    // for most of the readiness window and only reports running with several
    // checks left before the deadline. A larger attempt count than the
    // existing "waits briefly" sanity test, to prove the loop is bound by the
    // deadline rather than by a small fixed number of attempts.
    const readyAfterChecks = 8;
    let checks = 0;
    const workerManager = {
      isRunning: vi.fn((id: string) => {
        if (id !== pluginId) return false;
        checks += 1;
        return checks >= readyAfterChecks;
      }),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "sandbox-registered-late",
            metadata: {
              provider: "fake-plugin",
              image: "fake:test",
              timeoutMs: 1234,
              reuseLease: false,
            },
          };
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, {
      pluginWorkerManager: workerManager,
      pluginWorkerReadyTimeoutMs: 200,
      pluginWorkerReadyPollMs: 1,
    });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    expect(acquired.lease.providerLeaseId).toBe("sandbox-registered-late");
    expect(checks).toBe(readyAfterChecks);
  });

  it("extends plugin-backed sandbox lease RPC timeouts from provider config", async () => {
    const pluginId = randomUUID();
    const { companyId, environment: baseEnvironment, runId } = await seedEnvironment();
    const providerConfig = {
      provider: "fake-plugin",
      image: "fake:test",
      timeoutMs: 1_234,
      bridgeRequestTimeoutMs: 40_000,
      reuseLease: false,
    };
    const environment = {
      ...baseEnvironment,
      name: "Long Lease Plugin Sandbox",
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
      pluginKey: "acme.long-lease-sandbox-provider",
      packageName: "@acme/long-lease-sandbox-provider",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.long-lease-sandbox-provider",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Long Lease Sandbox Provider",
        description: "Test plugin worker acquire timeout",
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
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "sandbox-1",
            metadata: {
              provider: "fake-plugin",
              image: "fake:test",
              timeoutMs: 1_234,
              bridgeRequestTimeoutMs: 40_000,
              reuseLease: false,
            },
          };
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    expect(acquired.lease.providerLeaseId).toBe("sandbox-1");
    expect(workerManager.call).toHaveBeenCalledWith(
      pluginId,
      "environmentAcquireLease",
      expect.objectContaining({
        driverKey: "fake-plugin",
        config: {
          image: "fake:test",
          timeoutMs: 1_234,
          bridgeRequestTimeoutMs: 40_000,
          reuseLease: false,
        },
      }),
      70_000,
    );
  });

  it("preserves the exact lease when plugin-backed sandbox resume throws", async () => {
    const pluginId = randomUUID();
    const { companyId, agentId, environment: baseEnvironment, runId } = await seedEnvironment();
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
            supportsReusableLeases: true,
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
    const executionWorkspaceId = randomUUID();
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: `Workspace ${projectId.slice(0, 8)}`,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Reusable workspace",
      status: "active",
      providerType: "local_fs",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const staleLease = await environmentService(db).acquireLease({
      companyId,
      environmentId: environment.id,
      executionWorkspaceId,
      heartbeatRunId: runId,
      leasePolicy: "reuse_by_environment",
      provider: "fake-plugin",
      providerLeaseId: "stale-plugin-lease",
      metadata: {
        agentId,
        driver: "sandbox",
        pluginId,
        pluginKey: "acme.fake-sandbox-provider",
        sandboxProviderPlugin: true,
        provider: "fake-plugin",
        image: "fake:test",
        timeoutMs: 1234,
        reuseLease: true,
        reusableSandboxLease: {
          version: 1,
          companyId,
          environmentId: environment.id,
          executionWorkspaceId,
          agentId,
          adapterType: null,
          provider: "fake-plugin",
          runtimeFingerprint: reusableRuntimeFingerprint({
            provider: "fake-plugin",
            adapterType: null,
            config: providerConfig,
          }),
        },
      },
    });

    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentResumeLease") {
          throw new Error("stale sandbox");
        }
        if (method === "environmentDestroyLease") {
          return undefined;
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
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    await expect(runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: {
        id: executionWorkspaceId,
        mode: "shared_workspace",
      },
    })).rejects.toThrow("the lease was preserved and no replacement was created");

    expect(workerManager.call).toHaveBeenNthCalledWith(1, pluginId, "environmentResumeLease", expect.objectContaining({
      driverKey: "fake-plugin",
      providerLeaseId: "stale-plugin-lease",
    }), 31234);
    expect(workerManager.call).not.toHaveBeenCalledWith(
      pluginId,
      "environmentDestroyLease",
      expect.anything(),
      expect.anything(),
    );
    expect(workerManager.call).not.toHaveBeenCalledWith(
      pluginId,
      "environmentAcquireLease",
      expect.anything(),
      expect.anything(),
    );
    await expect(environmentService(db).getLeaseById(staleLease.id)).resolves.toMatchObject({
      status: "active",
    });
  });

  it("does not allocate a native-runner replacement without a verified backup", async () => {
    const seeded = await seedReusablePluginSandboxLease("paperclip_runner");
    const workerManager = {
      isRunning: vi.fn((id: string) => id === seeded.pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentResumeLease") {
          return { providerLeaseId: null, metadata: { expired: true } };
        }
        if (method === "environmentDestroyLease") return undefined;
        if (method === "environmentAcquireLease") {
          throw new Error("replacement must not be allocated");
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({
        supportedMethods: [
          "environmentResumeLease",
          "environmentReleaseLease",
          "environmentDestroyLease",
        ],
      })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    await expect(runtimeWithPlugin.acquireRunLease({
      companyId: seeded.companyId,
      environment: seeded.environment,
      issueId: null,
      agentId: seeded.agentId,
      adapterType: "paperclip_runner",
      heartbeatRunId: seeded.runId,
      persistedExecutionWorkspace: {
        id: seeded.executionWorkspaceId,
        mode: "shared_workspace",
      },
    })).rejects.toThrow("runner_harness_backup_unavailable");

    expect(workerManager.call).not.toHaveBeenCalledWith(
      seeded.pluginId,
      "environmentAcquireLease",
      expect.anything(),
      expect.anything(),
    );
  });

  it("permits native-runner replacement only after verifying the stamped backup", async () => {
    const seeded = await seedReusablePluginSandboxLease("paperclip_runner");
    const backupBase = await mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-replacement-"));
    const previousStateDirectory = process.env.PAPERCLIP_RUNNER_STATE_DIR;
    process.env.PAPERCLIP_RUNNER_STATE_DIR = backupBase;
    try {
      const normalizedSessionId = "native-replacement-session";
      const runnerInstanceId = "native-replacement-runner";
      const sessionRoot = path.join(
        backupBase,
        createHash("sha256").update(normalizedSessionId).digest("hex"),
      );
      const current = path.join(sessionRoot, "failover-backups", "current");
      await mkdir(path.join(current, "runner"), { recursive: true });
      await mkdir(path.join(current, "codex-home", "sessions"), { recursive: true });
      await writeFile(path.join(current, "runner", "runner-state.json"), "runner-state");
      await writeFile(path.join(current, "codex-home", "sessions", "thread.jsonl"), "thread-state");
      const execution = {
        provider: { kind: "codex", model: null, approvalPolicy: "never" },
        binding: {
          companyId: seeded.companyId,
          runId: seeded.runId,
          issueId: "issue",
          agentId: seeded.agentId,
          executionWorkspaceId: seeded.executionWorkspaceId,
        },
        workspace: { cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
        session: {
          normalizedSessionId,
          driverKind: "codex_app_server",
          protocolVersion: 1,
          lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
        },
      } as never;
      const manifest = buildNativeHarnessBackupManifest({
        backupRoot: current,
        execution,
        runnerInstanceId,
        providerSessionIdentity: {
          providerSessionId: "thread-1",
          providerBackendSessionId: "session-1",
          providerSessionIdentity: null,
        },
        sourceProviderLeaseId: seeded.reusableLease.providerLeaseId!,
      });
      const manifestPath = path.join(current, "manifest.json");
      await writeFile(manifestPath, JSON.stringify(manifest));
      const stamp = createNativeHarnessBackupStamp({
        manifestPath,
        normalizedSessionId,
        runnerInstanceId,
        completedAt: manifest.completedAt,
      });
      await environmentService(db).updateLeaseMetadata(seeded.reusableLease.id, {
        ...(seeded.reusableLease.metadata ?? {}),
        nativeHarnessBackup: stamp,
      });

      const workerManager = {
        isRunning: vi.fn((id: string) => id === seeded.pluginId),
        call: vi.fn(async (_pluginId: string, method: string) => {
          if (method === "environmentResumeLease") {
            return { providerLeaseId: null, metadata: { expired: true } };
          }
          if (method === "environmentDestroyLease") return undefined;
          if (method === "environmentAcquireLease") {
            return {
              providerLeaseId: "replacement-plugin-lease",
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
        getWorker: vi.fn(() => ({
          supportedMethods: [
            "environmentResumeLease",
            "environmentReleaseLease",
            "environmentDestroyLease",
          ],
        })),
      } as unknown as PluginWorkerManager;
      const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });
      const acquired = await runtimeWithPlugin.acquireRunLease({
        companyId: seeded.companyId,
        environment: seeded.environment,
        issueId: null,
        agentId: seeded.agentId,
        adapterType: "paperclip_runner",
        heartbeatRunId: seeded.runId,
        persistedExecutionWorkspace: {
          id: seeded.executionWorkspaceId,
          mode: "shared_workspace",
        },
      });

      expect(acquired.lease.providerLeaseId).toBe("replacement-plugin-lease");
      expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toEqual({
        outcome: "replacement",
        reason: "not_found",
      });
    } finally {
      if (previousStateDirectory === undefined) {
        delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
      } else {
        process.env.PAPERCLIP_RUNNER_STATE_DIR = previousStateDirectory;
      }
      await rm(backupBase, { recursive: true, force: true });
    }
  });

  it("fails closed and does not resume when a worker restart drops the resume method after the capability snapshot", async () => {
    const pluginId = randomUUID();
    const { companyId, agentId, environment: baseEnvironment, runId } = await seedEnvironment();
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
            supportsReusableLeases: true,
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
    const executionWorkspaceId = randomUUID();
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: `Workspace ${projectId.slice(0, 8)}`,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Reusable workspace",
      status: "active",
      providerType: "local_fs",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const staleLease = await environmentService(db).acquireLease({
      companyId,
      environmentId: environment.id,
      executionWorkspaceId,
      heartbeatRunId: runId,
      leasePolicy: "reuse_by_environment",
      provider: "fake-plugin",
      providerLeaseId: "stale-plugin-lease",
      metadata: {
        agentId,
        driver: "sandbox",
        pluginId,
        pluginKey: "acme.fake-sandbox-provider",
        sandboxProviderPlugin: true,
        provider: "fake-plugin",
        image: "fake:test",
        timeoutMs: 1234,
        reuseLease: true,
        reusableSandboxLease: {
          version: 1,
          companyId,
          environmentId: environment.id,
          executionWorkspaceId,
          agentId,
          adapterType: null,
          provider: "fake-plugin",
          runtimeFingerprint: reusableRuntimeFingerprint({
            provider: "fake-plugin",
            adapterType: null,
            config: providerConfig,
          }),
        },
      },
    });

    // The runtime reads the worker methods once to decide reuse, then does
    // asynchronous database work before the resume dispatch. A worker restart
    // in that window drops `environmentResumeLease`. The first read returns the
    // reuse verbs, so the runtime treats the lease as resumable. Every later
    // read returns the restarted worker's methods, which no longer include
    // `environmentResumeLease`.
    let getWorkerReads = 0;
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentResumeLease") {
          // A regression that reads the stale snapshot dispatches the resume
          // RPC and fails here. The live worker cannot serve the method.
          throw new Error("worker no longer advertises environmentResumeLease");
        }
        if (method === "environmentDestroyLease") {
          return undefined;
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
      getWorker: vi.fn(() => {
        getWorkerReads += 1;
        return {
          supportedMethods:
            getWorkerReads === 1
              ? ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"]
              : ["environmentReleaseLease", "environmentDestroyLease"],
        };
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    await expect(runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: {
        id: executionWorkspaceId,
        mode: "shared_workspace",
      },
    })).rejects.toThrow("the lease was preserved and no replacement was created");

    // The runtime re-checks the live worker before the resume dispatch. The
    // restarted worker no longer advertises `environmentResumeLease`, so the
    // runtime must not dispatch the resume RPC.
    expect(workerManager.call).not.toHaveBeenCalledWith(
      pluginId,
      "environmentResumeLease",
      expect.anything(),
      expect.anything(),
    );
    // It preserves the stale reusable lease and does not allocate a replacement.
    expect(workerManager.call).not.toHaveBeenCalledWith(
      pluginId,
      "environmentDestroyLease",
      expect.anything(),
      expect.anything(),
    );
    expect(workerManager.call).not.toHaveBeenCalledWith(
      pluginId,
      "environmentAcquireLease",
      expect.anything(),
      expect.anything(),
    );
    await expect(environmentService(db).getLeaseById(staleLease.id)).resolves.toMatchObject({
      status: "active",
    });
  });

  // Seed a reusable plugin sandbox lease that a worker created under an earlier
  // capability set. The worker restarts and no longer advertises the lifecycle
  // methods. The lease lifecycle paths must verify the live worker before they
  // dispatch a lifecycle RPC, so the runtime fails closed instead of a doomed
  // dispatch.
  async function seedStaleLifecycleReusableLease(
    leasePolicy: "reuse_by_environment" | "retain_on_failure" = "reuse_by_environment",
  ) {
    const pluginId = randomUUID();
    const { companyId, agentId, environment: baseEnvironment, runId } = await seedEnvironment();
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
            supportsReusableLeases: true,
            configSchema: { type: "object" },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);
    const executionWorkspaceId = randomUUID();
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: `Workspace ${projectId.slice(0, 8)}`,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Reusable workspace",
      status: "active",
      providerType: "local_fs",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const lease = await environmentService(db).acquireLease({
      companyId,
      environmentId: environment.id,
      executionWorkspaceId,
      heartbeatRunId: runId,
      leasePolicy,
      provider: "fake-plugin",
      providerLeaseId: "stale-lifecycle-lease",
      metadata: {
        agentId,
        driver: "sandbox",
        pluginId,
        pluginKey: "acme.fake-sandbox-provider",
        sandboxProviderPlugin: true,
        provider: "fake-plugin",
        image: "fake:test",
        timeoutMs: 1234,
        reuseLease: true,
      },
    });

    // The worker is running, but its discovery list dropped the reusable-lease
    // lifecycle methods. `call` throws on any lifecycle RPC so a regression that
    // dispatches one fails the test through the `not.toHaveBeenCalledWith` check.
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentAcquireLease", "environmentExecute"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    return { pluginId, environment, runId, lease, workerManager, runtimeWithPlugin };
  }

  it("routes release to pending_cleanup when the worker no longer advertises the release lifecycle method", async () => {
    const { pluginId, lease, workerManager, runtimeWithPlugin } = await seedStaleLifecycleReusableLease();

    const released = await runtimeWithPlugin.releaseRunLeases(lease.heartbeatRunId!);

    expect(released).toHaveLength(1);
    expect(workerManager.call).not.toHaveBeenCalledWith(
      pluginId,
      "environmentReleaseLease",
      expect.anything(),
      expect.anything(),
    );
    // The failed release verification must enter the pending-cleanup retry flow.
    // The reaper sweeps only `pending_cleanup` leases, so a `released` status
    // here would strand the still-active provider resource.
    await expect(environmentService(db).getLeaseById(lease.id)).resolves.toMatchObject({
      status: "pending_cleanup",
      cleanupStatus: "failed",
      failureReason: "release_cleanup_failed",
    });
  });

  it("retains a retain_on_failure lease on failed release instead of routing to pending_cleanup", async () => {
    const { lease, runtimeWithPlugin } = await seedStaleLifecycleReusableLease("retain_on_failure");

    const released = await runtimeWithPlugin.releaseRunLeases(lease.heartbeatRunId!, "failed");

    expect(released).toHaveLength(1);
    // A retain_on_failure lease keeps the provider resource for reuse. The
    // reaper destroys `pending_cleanup` leases, so the retained lease must not
    // enter that flow even when the release verification fails.
    await expect(environmentService(db).getLeaseById(lease.id)).resolves.toMatchObject({
      status: "retained",
      cleanupStatus: "failed",
    });
  });

  it("fails closed on expiry destruction when the worker no longer advertises the destroy lifecycle method", async () => {
    const { pluginId, lease, workerManager, runtimeWithPlugin } = await seedStaleLifecycleReusableLease();

    await runtimeWithPlugin.releaseRunLeases(lease.heartbeatRunId!, "expired");

    expect(workerManager.call).not.toHaveBeenCalledWith(
      pluginId,
      "environmentDestroyLease",
      expect.anything(),
      expect.anything(),
    );
    await expect(environmentService(db).getLeaseById(lease.id)).resolves.toMatchObject({
      status: "pending_cleanup",
      cleanupStatus: "failed",
    });
  });

  it("does not resume released reusable plugin sandbox leases after provider config drift", async () => {
    const pluginId = randomUUID();
    const { companyId, agentId, environment: baseEnvironment, runId } = await seedEnvironment();
    const providerConfig = {
      provider: "fake-plugin",
      image: "template-a",
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
            supportsReusableLeases: true,
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
    const executionWorkspaceId = randomUUID();
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: `Workspace ${projectId.slice(0, 8)}`,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Reusable workspace",
      status: "active",
      providerType: "local_fs",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string, params: any) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: `lease-${params.config.image}`,
            metadata: {
              provider: "fake-plugin",
              image: params.config.image,
              timeoutMs: params.config.timeoutMs,
              reuseLease: true,
              remoteCwd: "/workspace",
            },
          };
        }
        if (method === "environmentReleaseLease" || method === "environmentDestroyLease") {
          return undefined;
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const first = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: {
        id: executionWorkspaceId,
        mode: "shared_workspace",
      },
    });
    expect(first.lease.metadata?.reusableSandboxLease).toMatchObject({
      provider: "fake-plugin",
      leaseFingerprint: expect.objectContaining({
        category: "lease",
        fingerprint: expect.stringMatching(/^v1:sha256:[a-f0-9]{64}$/),
      }),
    });
    await runtimeWithPlugin.releaseRunLeases(runId);

    const nextRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: nextRunId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: "running",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const updatedEnvironment = {
      ...environment,
      config: {
        ...providerConfig,
        image: "template-b",
      },
    };
    await environmentService(db).update(environment.id, {
      config: updatedEnvironment.config,
    });

    const second = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment: updatedEnvironment,
      issueId: null,
      agentId,
      heartbeatRunId: nextRunId,
      persistedExecutionWorkspace: {
        id: executionWorkspaceId,
        mode: "shared_workspace",
      },
    });

    expect(second.lease.providerLeaseId).toBe("lease-template-b");
    expect(workerManager.call).not.toHaveBeenCalledWith(
      pluginId,
      "environmentResumeLease",
      expect.anything(),
      expect.anything(),
    );
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentDestroyLease", expect.objectContaining({
      providerLeaseId: "lease-template-a",
    }), 31234);
    await expect(environmentService(db).getLeaseById(first.lease.id)).resolves.toMatchObject({
      status: "expired",
      cleanupStatus: "success",
      failureReason: "lease_fingerprint_mismatch",
    });
  });

  it("does not resume released reusable plugin sandbox leases after secret version drift", async () => {
    const pluginId = randomUUID();
    const { companyId, agentId, environment: baseEnvironment, runId } = await seedEnvironment();
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
      reuseLease: true,
    };
    const environment = {
      ...baseEnvironment,
      name: "Secure Plugin Sandbox",
      driver: "sandbox",
      config: providerConfig,
    };
    await secretService(db).createBinding({
      companyId,
      secretId: apiSecret.id,
      targetType: "environment",
      targetId: environment.id,
      configPath: "apiKey",
    });
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
            supportsReusableLeases: true,
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
    const executionWorkspaceId = randomUUID();
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: `Workspace ${projectId.slice(0, 8)}`,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Reusable workspace",
      status: "active",
      providerType: "local_fs",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string, params: any) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: `lease-${params.config.apiKey}`,
            metadata: {
              provider: "secure-plugin",
              template: params.config.template,
              apiKey: params.config.apiKey,
              timeoutMs: params.config.timeoutMs,
              reuseLease: true,
              remoteCwd: "/workspace",
            },
          };
        }
        if (method === "environmentReleaseLease" || method === "environmentDestroyLease") {
          return undefined;
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const first = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: {
        id: executionWorkspaceId,
        mode: "shared_workspace",
      },
    });
    await runtimeWithPlugin.releaseRunLeases(runId);
    await secretService(db).rotate(apiSecret.id, { value: "rotated-provider-key" });

    const nextRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: nextRunId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: "running",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const second = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId,
      heartbeatRunId: nextRunId,
      persistedExecutionWorkspace: {
        id: executionWorkspaceId,
        mode: "shared_workspace",
      },
    });

    expect(second.lease.providerLeaseId).toBe("lease-rotated-provider-key");
    expect(workerManager.call).not.toHaveBeenCalledWith(
      pluginId,
      "environmentResumeLease",
      expect.anything(),
      expect.anything(),
    );
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentDestroyLease", expect.objectContaining({
      providerLeaseId: "lease-resolved-provider-key",
    }), 31234);
    await expect(environmentService(db).getLeaseById(first.lease.id)).resolves.toMatchObject({
      status: "expired",
      cleanupStatus: "success",
      failureReason: "lease_fingerprint_mismatch",
    });
    const firstMetadata = JSON.stringify(first.lease.metadata);
    expect(firstMetadata).not.toContain("resolved-provider-key");
    expect(firstMetadata).not.toContain("rotated-provider-key");
  });

  it("preserves active reusable sandbox leases held by another running run", async () => {
    const { pluginId, companyId, agentId, environment, executionWorkspaceId, reusableLease } =
      await seedReusablePluginSandboxLease();
    const nextRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: nextRunId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: "running",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
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
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId,
      heartbeatRunId: nextRunId,
      persistedExecutionWorkspace: {
        id: executionWorkspaceId,
        mode: "shared_workspace",
      },
    });

    expect(acquired.lease.providerLeaseId).toBe("fresh-plugin-lease");
    expect(workerManager.call).toHaveBeenCalledOnce();
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentAcquireLease", expect.objectContaining({
      agentId,
      executionWorkspaceId,
      runId: nextRunId,
    }), 31234);
    await expect(environmentService(db).getLeaseById(reusableLease.id)).resolves.toMatchObject({
      status: "active",
      cleanupStatus: null,
    });
  });

  it("does not retain or resume plugin-backed sandbox leases unless the provider opts in", async () => {
    const pluginId = randomUUID();
    const { companyId, agentId, environment: baseEnvironment, runId } = await seedEnvironment();
    const providerConfig = {
      provider: "fake-plugin",
      image: "fake:test",
      timeoutMs: 1234,
      reuseLease: true,
    };
    const environment = {
      ...baseEnvironment,
      name: "Non-reusable Plugin Sandbox",
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
      pluginKey: "acme.non-reusable-sandbox-provider",
      packageName: "@acme/non-reusable-sandbox-provider",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.non-reusable-sandbox-provider",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Non-reusable Sandbox Provider",
        description: "Test provider without reusable lease support",
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
    const executionWorkspaceId = randomUUID();
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: `Workspace ${projectId.slice(0, 8)}`,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Non-reusable workspace",
      status: "active",
      providerType: "local_fs",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await environmentService(db).acquireLease({
      companyId,
      environmentId: environment.id,
      executionWorkspaceId,
      heartbeatRunId: runId,
      leasePolicy: "reuse_by_environment",
      provider: "fake-plugin",
      providerLeaseId: "old-plugin-lease",
      metadata: {
        agentId,
        provider: "fake-plugin",
        image: "fake:test",
        timeoutMs: 1234,
        reuseLease: true,
        reusableSandboxLease: {
          version: 1,
          companyId,
          environmentId: environment.id,
          executionWorkspaceId,
          agentId,
          adapterType: null,
          provider: "fake-plugin",
          runtimeFingerprint: reusableRuntimeFingerprint({
            provider: "fake-plugin",
            adapterType: null,
            config: providerConfig,
          }),
        },
      },
    });

    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
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
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: {
        id: executionWorkspaceId,
        mode: "shared_workspace",
      },
    });

    expect(acquired.lease.providerLeaseId).toBe("fresh-plugin-lease");
    expect(acquired.lease.leasePolicy).toBe("ephemeral");
    expect(workerManager.call).toHaveBeenCalledTimes(1);
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentAcquireLease", expect.anything(), 31234);
  });

  it("does not resume a lease when the nested capability disables reusable leases", async () => {
    // The provider declares the legacy `supportsReusableLeases: true` flag but
    // the nested `sandboxCapabilities.reusableLeases: false`. The nested value
    // wins through the capability contract, so acquisition must acquire a fresh
    // lease and must never resume the existing reusable lease.
    const pluginId = randomUUID();
    const { companyId, agentId, environment: baseEnvironment, runId } = await seedEnvironment();
    const providerConfig = {
      provider: "fake-plugin",
      image: "fake:test",
      timeoutMs: 1234,
      reuseLease: true,
    };
    const environment = {
      ...baseEnvironment,
      name: "Nested-disabled Plugin Sandbox",
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
      pluginKey: "acme.nested-disabled-sandbox-provider",
      packageName: "@acme/nested-disabled-sandbox-provider",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.nested-disabled-sandbox-provider",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Nested-disabled Sandbox Provider",
        description: "Test provider with a legacy flag and a disabled nested capability",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: "fake-plugin",
            kind: "sandbox_provider",
            displayName: "Fake Plugin",
            supportsReusableLeases: true,
            sandboxCapabilities: { reusableLeases: false },
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
    const executionWorkspaceId = randomUUID();
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: `Workspace ${projectId.slice(0, 8)}`,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Nested-disabled workspace",
      status: "active",
      providerType: "local_fs",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await environmentService(db).acquireLease({
      companyId,
      environmentId: environment.id,
      executionWorkspaceId,
      heartbeatRunId: runId,
      leasePolicy: "reuse_by_environment",
      provider: "fake-plugin",
      providerLeaseId: "old-plugin-lease",
      metadata: {
        agentId,
        provider: "fake-plugin",
        image: "fake:test",
        timeoutMs: 1234,
        reuseLease: true,
        reusableSandboxLease: {
          version: 1,
          companyId,
          environmentId: environment.id,
          executionWorkspaceId,
          agentId,
          adapterType: null,
          provider: "fake-plugin",
          runtimeFingerprint: reusableRuntimeFingerprint({
            provider: "fake-plugin",
            adapterType: null,
            config: providerConfig,
          }),
        },
      },
    });

    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
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
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: {
        id: executionWorkspaceId,
        mode: "shared_workspace",
      },
    });

    expect(acquired.lease.providerLeaseId).toBe("fresh-plugin-lease");
    expect(acquired.lease.leasePolicy).toBe("ephemeral");
    expect(workerManager.call).toHaveBeenCalledTimes(1);
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentAcquireLease", expect.anything(), 31234);
    expect(workerManager.call).not.toHaveBeenCalledWith(
      pluginId,
      "environmentResumeLease",
      expect.anything(),
      expect.anything(),
    );
  });

  it("fails closed and does not resume when the worker does not verify the reuse methods", async () => {
    // The provider declares `reusableLeases: true`, but its worker advertises
    // neither `environmentResumeLease` nor `environmentReleaseLease`. The runtime
    // must not resume or reuse the lease, because it cannot dispatch a resume or
    // a release the worker does not serve. It acquires a fresh ephemeral lease
    // and leaves the old reusable lease untouched.
    const pluginId = randomUUID();
    const { companyId, agentId, environment: baseEnvironment, runId } = await seedEnvironment();
    const providerConfig = {
      provider: "fake-plugin",
      image: "fake:test",
      timeoutMs: 1234,
      reuseLease: true,
    };
    const environment = {
      ...baseEnvironment,
      name: "Unverified-worker Plugin Sandbox",
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
      pluginKey: "acme.unverified-worker-sandbox-provider",
      packageName: "@acme/unverified-worker-sandbox-provider",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.unverified-worker-sandbox-provider",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Unverified-worker Sandbox Provider",
        description: "Test provider that declares reusable leases but whose worker lacks the reuse methods",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: "fake-plugin",
            kind: "sandbox_provider",
            displayName: "Fake Plugin",
            sandboxCapabilities: { reusableLeases: true },
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
    const executionWorkspaceId = randomUUID();
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: `Workspace ${projectId.slice(0, 8)}`,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Unverified-worker workspace",
      status: "active",
      providerType: "local_fs",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const existingLease = await environmentService(db).acquireLease({
      companyId,
      environmentId: environment.id,
      executionWorkspaceId,
      heartbeatRunId: runId,
      leasePolicy: "reuse_by_environment",
      provider: "fake-plugin",
      providerLeaseId: "old-plugin-lease",
      metadata: {
        agentId,
        provider: "fake-plugin",
        image: "fake:test",
        timeoutMs: 1234,
        reuseLease: true,
        reusableSandboxLease: {
          version: 1,
          companyId,
          environmentId: environment.id,
          executionWorkspaceId,
          agentId,
          adapterType: null,
          provider: "fake-plugin",
          runtimeFingerprint: reusableRuntimeFingerprint({
            provider: "fake-plugin",
            adapterType: null,
            config: providerConfig,
          }),
        },
      },
    });

    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
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
      // The worker verifies only `environmentExecute`. It advertises neither
      // reuse verb, so the reusable-lease capability fails closed.
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentExecute"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: {
        id: executionWorkspaceId,
        mode: "shared_workspace",
      },
    });

    expect(acquired.lease.providerLeaseId).toBe("fresh-plugin-lease");
    expect(acquired.lease.leasePolicy).toBe("ephemeral");
    expect(workerManager.call).toHaveBeenCalledTimes(1);
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentAcquireLease", expect.anything(), 31234);
    expect(workerManager.call).not.toHaveBeenCalledWith(
      pluginId,
      "environmentResumeLease",
      expect.anything(),
      expect.anything(),
    );
    // The runtime leaves the old reusable lease untouched: it neither resumes
    // nor destroys a lease it cannot serve.
    await expect(environmentService(db).getLeaseById(existingLease.id)).resolves.toMatchObject({
      status: "active",
      leasePolicy: "reuse_by_environment",
    });
  });

  it("destroys scoped reusable plugin-backed sandbox leases", async () => {
    const { pluginId, companyId, executionWorkspaceId, reusableLease } =
      await seedReusablePluginSandboxLease();

    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentDestroyLease") {
          return undefined;
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const destroyed = await runtimeWithPlugin.destroyReusableSandboxLeases({
      companyId,
      executionWorkspaceId,
      failureReason: "execution_workspace_closed",
    });

    expect(destroyed).toHaveLength(1);
    expect(destroyed[0]?.lease.id).toBe(reusableLease.id);
    expect(destroyed[0]?.lease.status).toBe("expired");
    expect(workerManager.call).toHaveBeenCalledWith(
      pluginId,
      "environmentDestroyLease",
      expect.objectContaining({
        driverKey: "fake-plugin",
        providerLeaseId: "reusable-plugin-lease",
      }),
      31234,
    );
    await expect(environmentService(db).getLeaseById(reusableLease.id)).resolves.toMatchObject({
      status: "expired",
      failureReason: "execution_workspace_closed",
      cleanupStatus: "success",
    });
  });

  it("destroys reusable plugin-backed sandbox leases scoped to an environment", async () => {
    const { pluginId, runId, reusableLease } = await seedReusablePluginSandboxLease();
    // The holding run is finished, so the reservation is stale and destroyable.
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));

    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentDestroyLease") {
          return undefined;
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const result = await runtimeWithPlugin.destroyReusableSandboxLeasesForEnvironment({
      environmentId: reusableLease.environmentId!,
      failureReason: "environment_deleted",
    });

    expect(result).toEqual({ destroyed: 1, failed: 0, skippedLiveRun: 0 });
    expect(workerManager.call).toHaveBeenCalledWith(
      pluginId,
      "environmentDestroyLease",
      expect.objectContaining({
        driverKey: "fake-plugin",
        providerLeaseId: "reusable-plugin-lease",
      }),
      31234,
    );
    await expect(environmentService(db).getLeaseById(reusableLease.id)).resolves.toMatchObject({
      status: "expired",
      failureReason: "environment_deleted",
      cleanupStatus: "success",
    });
  });

  it("keeps a reusable lease held by an in-flight run out of the environment-scoped destroy", async () => {
    const { pluginId, reusableLease } = await seedReusablePluginSandboxLease();
    // seedEnvironment leaves the holding run in `running` status.

    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async () => undefined),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const result = await runtimeWithPlugin.destroyReusableSandboxLeasesForEnvironment({
      environmentId: reusableLease.environmentId!,
      failureReason: "environment_deleted",
    });

    expect(result).toEqual({ destroyed: 0, failed: 0, skippedLiveRun: 1 });
    expect(workerManager.call).not.toHaveBeenCalled();
    // The lease keeps its reusable status, so the delete guard still blocks.
    await expect(environmentService(db).getLeaseById(reusableLease.id)).resolves.toMatchObject({
      status: "active",
      leasePolicy: "reuse_by_environment",
    });
  });

  it("sweeps reusable cleanup with the configuration recorded on the lease", async () => {
    const { pluginId, environment, reusableLease } = await seedReusablePluginSandboxLease();
    const environmentsSvc = environmentService(db);
    await environmentsSvc.releaseLease(reusableLease.id, "pending_cleanup", {
      failureReason: "release_cleanup_failed",
      cleanupStatus: "failed",
    });

    // Re-point the environment after the reusable sandbox was provisioned.
    // The pending-cleanup sweep still enters destroyRunLease because the
    // environment exists, but destroy must target the provider and config
    // captured on the lease rather than this current configuration.
    await environmentsSvc.update(environment.id, {
      config: {
        provider: "replacement-provider",
        image: "replacement:test",
        timeoutMs: 9999,
        reuseLease: true,
      },
    });

    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentDestroyLease") return undefined;
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({
        supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"],
      })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });
    const heartbeat = heartbeatService(db, { environmentRuntime: runtimeWithPlugin });

    const result = await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });

    expect(result).toEqual({ swept: 1, destroyed: 1, capped: 0 });
    expect(workerManager.call).toHaveBeenCalledWith(
      pluginId,
      "environmentDestroyLease",
      expect.objectContaining({
        driverKey: "fake-plugin",
        environmentId: environment.id,
        providerLeaseId: "reusable-plugin-lease",
        config: expect.objectContaining({
          image: "fake:test",
          timeoutMs: 1234,
          reuseLease: true,
        }),
      }),
      31234,
    );
    const destroyInput = vi.mocked(workerManager.call).mock.calls[0]?.[2] as {
      config?: Record<string, unknown>;
    };
    expect(destroyInput.config).not.toMatchObject({
      image: "replacement:test",
      timeoutMs: 9999,
    });
    await expect(environmentsSvc.getLeaseById(reusableLease.id)).resolves.toMatchObject({
      status: "expired",
      cleanupStatus: "success",
    });
  });

  it("retries reusable plugin-backed sandbox destroy when the worker is unavailable", async () => {
    const { pluginId, companyId, executionWorkspaceId, reusableLease } =
      await seedReusablePluginSandboxLease();

    const offlineWorkerManager = {
      isRunning: vi.fn(() => false),
      call: vi.fn(),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithOfflinePlugin = environmentRuntimeService(db, {
      pluginWorkerManager: offlineWorkerManager,
    });

    const pending = await runtimeWithOfflinePlugin.destroyReusableSandboxLeases({
      companyId,
      executionWorkspaceId,
      failureReason: "execution_workspace_closed",
    });

    expect(pending).toHaveLength(1);
    expect(pending[0]?.lease.id).toBe(reusableLease.id);
    expect(pending[0]?.lease.status).toBe("pending_cleanup");
    expect(offlineWorkerManager.call).not.toHaveBeenCalled();
    await expect(environmentService(db).getLeaseById(reusableLease.id)).resolves.toMatchObject({
      status: "pending_cleanup",
      failureReason: "execution_workspace_closed",
      cleanupStatus: "failed",
    });

    const recoveredWorkerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentDestroyLease") {
          return undefined;
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithRecoveredPlugin = environmentRuntimeService(db, {
      pluginWorkerManager: recoveredWorkerManager,
    });

    const retried = await runtimeWithRecoveredPlugin.destroyReusableSandboxLeases({
      companyId,
      executionWorkspaceId,
      failureReason: "cleanup_retry",
    });

    expect(retried).toHaveLength(1);
    expect(retried[0]?.lease.id).toBe(reusableLease.id);
    expect(retried[0]?.lease.status).toBe("expired");
    expect(recoveredWorkerManager.call).toHaveBeenCalledWith(
      pluginId,
      "environmentDestroyLease",
      expect.objectContaining({
        driverKey: "fake-plugin",
        providerLeaseId: "reusable-plugin-lease",
      }),
      31234,
    );
    await expect(environmentService(db).getLeaseById(reusableLease.id)).resolves.toMatchObject({
      status: "expired",
      failureReason: "cleanup_retry",
      cleanupStatus: "success",
    });
  });

  it("resolves effective capabilities from the lease's exact plugin, not an earlier plugin that shares the driver key", async () => {
    // The helper seeds the plugin that owns the lease. Pin it to `pluginId`
    // through the lease metadata and give it a lower-priority sibling.
    const { pluginId, environment, reusableLease } = await seedReusablePluginSandboxLease();

    // Rewrite the owner plugin so it DENIES reusable leases through the nested
    // capability declaration.
    await db
      .update(plugins)
      .set({
        manifestJson: {
          id: "acme.reusable-sandbox-provider",
          apiVersion: 1,
          version: "1.0.0",
          displayName: "Reusable Sandbox Provider",
          description: "Owner plugin that denies reusable leases",
          author: "Paperclip",
          categories: ["automation"],
          capabilities: ["environment.drivers.register"],
          entrypoints: { worker: "dist/worker.js" },
          environmentDrivers: [
            {
              driverKey: "fake-plugin",
              kind: "sandbox_provider",
              displayName: "Fake Plugin",
              sandboxCapabilities: { reusableLeases: false },
              configSchema: { type: "object", properties: {} },
            },
          ],
        },
        updatedAt: new Date(),
      } as any)
      .where(eq(plugins.id, pluginId));

    // Install an EARLIER plugin that shares the driver key and grants reusable
    // leases. It is not ready and never acquired this lease. A resolver keyed by
    // driver key alone would read this declaration and grant a capability the
    // owner plugin denied.
    const collidingPluginId = randomUUID();
    await db.insert(plugins).values({
      id: collidingPluginId,
      pluginKey: "acme.colliding-sandbox-provider",
      packageName: "@acme/colliding-sandbox-provider",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.colliding-sandbox-provider",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Colliding Sandbox Provider",
        description: "Earlier plugin that shares the driver key",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: "fake-plugin",
            kind: "sandbox_provider",
            displayName: "Fake Plugin",
            supportsReusableLeases: true,
            configSchema: { type: "object", properties: {} },
          },
        ],
      },
      status: "installed",
      installOrder: 0,
      updatedAt: new Date(),
    } as any);

    // The owner worker verifies the reuse verbs and the sync verbs, so every
    // capability is verified. Only the owner's declaration can narrow one.
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(),
      getWorker: vi.fn((id: string) =>
        id === pluginId
          ? {
              supportedMethods: [
                "environmentResumeLease",
                "environmentReleaseLease",
                "environmentSyncIn",
                "environmentSyncOut",
              ],
            }
          : undefined,
      ),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    expect(reusableLease.metadata?.pluginId).toBe(pluginId);

    const effective = await runtimeWithPlugin.resolveCapabilities({
      environment,
      lease: reusableLease,
    });

    // The runtime read the owner plugin's declaration, so it denies reusable
    // leases even though the earlier plugin grants them.
    expect(effective?.reusableLeases).toBe(false);
    // The owner plugin does not restrict native sync, and its worker verifies
    // the sync verbs, so those stay granted. This proves the resolver read the
    // owner declaration and did not fail every capability closed.
    expect(effective?.nativeSyncIn).toBe(true);
    expect(effective?.nativeSyncOut).toBe(true);
  });

  it("fails every effective capability closed when the pinned plugin id is absent from the registry", async () => {
    // The lease pins a plugin id, but that plugin record is gone. A stale worker
    // entry still advertises every method. The runtime must not read the stale
    // methods; it must fail closed because the exact-plugin identity is gone.
    const { pluginId, environment, reusableLease } = await seedReusablePluginSandboxLease();
    await db.delete(plugins).where(eq(plugins.id, pluginId));

    const workerManager = {
      isRunning: vi.fn(() => true),
      call: vi.fn(),
      getWorker: vi.fn(() => ({
        supportedMethods: [
          "environmentResumeLease",
          "environmentReleaseLease",
          "environmentExecute",
          "environmentSyncIn",
          "environmentSyncOut",
        ],
      })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const effective = await runtimeWithPlugin.resolveCapabilities({
      environment,
      lease: reusableLease,
    });

    for (const key of SANDBOX_CAPABILITY_KEYS) {
      expect(effective?.[key]).toBe(false);
    }
  });

  it("fails every effective capability closed when the pinned plugin no longer declares this provider key", async () => {
    // The pinned plugin still exists, but it no longer declares a
    // `sandbox_provider` driver with this key (here it changed the driver kind).
    // A running worker still advertises every method. The runtime must fail
    // closed because the exact-plugin declaration is gone.
    const { pluginId, environment, reusableLease } = await seedReusablePluginSandboxLease();
    await db
      .update(plugins)
      .set({
        manifestJson: {
          id: "acme.reusable-sandbox-provider",
          apiVersion: 1,
          version: "1.0.0",
          displayName: "Reusable Sandbox Provider",
          description: "Owner plugin that no longer declares the provider key",
          author: "Paperclip",
          categories: ["automation"],
          capabilities: ["environment.drivers.register"],
          entrypoints: { worker: "dist/worker.js" },
          environmentDrivers: [
            {
              driverKey: "fake-plugin",
              // The key exists, but the kind is now a plain environment driver,
              // not a sandbox provider. The by-id resolver fails closed.
              kind: "environment_driver",
              displayName: "Fake Plugin",
              configSchema: { type: "object", properties: {} },
            },
          ],
        },
        updatedAt: new Date(),
      } as any)
      .where(eq(plugins.id, pluginId));

    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(),
      getWorker: vi.fn(() => ({
        supportedMethods: [
          "environmentResumeLease",
          "environmentReleaseLease",
          "environmentExecute",
          "environmentSyncIn",
          "environmentSyncOut",
        ],
      })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const effective = await runtimeWithPlugin.resolveCapabilities({
      environment,
      lease: reusableLease,
    });

    for (const key of SANDBOX_CAPABILITY_KEYS) {
      expect(effective?.[key]).toBe(false);
    }
  });

  it("defers to verified worker discovery for a valid pinned plugin that omits sandboxCapabilities", async () => {
    // A valid, identified plugin whose manifest declares no `sandboxCapabilities`
    // and no legacy reuse flag. Its worker verifies the sync verbs. An omitted
    // declaration is NOT an identity failure: the runtime defers to the verified
    // baseline, so native sync stays granted while unverified capabilities stay
    // false.
    const { pluginId, environment, reusableLease } = await seedReusablePluginSandboxLease();
    await db
      .update(plugins)
      .set({
        manifestJson: {
          id: "acme.reusable-sandbox-provider",
          apiVersion: 1,
          version: "1.0.0",
          displayName: "Reusable Sandbox Provider",
          description: "Owner plugin that omits the capability declaration",
          author: "Paperclip",
          categories: ["automation"],
          capabilities: ["environment.drivers.register"],
          entrypoints: { worker: "dist/worker.js" },
          environmentDrivers: [
            {
              driverKey: "fake-plugin",
              kind: "sandbox_provider",
              displayName: "Fake Plugin",
              configSchema: { type: "object", properties: {} },
            },
          ],
        },
        updatedAt: new Date(),
      } as any)
      .where(eq(plugins.id, pluginId));

    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(),
      getWorker: vi.fn((id: string) =>
        id === pluginId
          ? { supportedMethods: ["environmentSyncIn", "environmentSyncOut"] }
          : undefined,
      ),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const effective = await runtimeWithPlugin.resolveCapabilities({
      environment,
      lease: reusableLease,
    });

    // The worker verified the sync verbs and the omitted declaration adds no
    // restriction, so native sync stays granted.
    expect(effective?.nativeSyncIn).toBe(true);
    expect(effective?.nativeSyncOut).toBe(true);
    // The worker did not verify the reuse verbs, so reusable leases stay false.
    expect(effective?.reusableLeases).toBe(false);
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

  it("does not reuse a sandbox lease owned by a different agent for the same execution workspace", async () => {
    const { companyId, agentId, environment, runId } = await seedEnvironment({
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
    const otherAgentId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const pluginId = randomUUID();
    const projectId = randomUUID();

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: `Workspace ${projectId.slice(0, 8)}`,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Existing workspace",
      status: "active",
      providerType: "local_fs",
      createdAt: new Date(),
      updatedAt: new Date(),
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

    await environmentService(db).acquireLease({
      companyId,
      environmentId: environment.id,
      executionWorkspaceId,
      heartbeatRunId: runId,
      leasePolicy: "reuse_by_environment",
      provider: "fake-plugin",
      providerLeaseId: "other-agent-lease",
      metadata: {
        agentId,
        provider: "fake-plugin",
        template: "base",
        reuseLease: true,
      },
    });

    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "fresh-agent-lease",
            metadata: {
              provider: "fake-plugin",
              template: "base",
              reuseLease: true,
            },
          };
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId: otherAgentId,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: {
        id: executionWorkspaceId,
        mode: "shared_workspace",
      },
    });

    expect(acquired.lease.providerLeaseId).toBe("fresh-agent-lease");
    expect(workerManager.call).toHaveBeenCalledTimes(1);
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentAcquireLease", expect.objectContaining({
      agentId: otherAgentId,
      executionWorkspaceId,
    }));
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
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
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
      executionWorkspaceId: undefined,
      executionWorkspaceSettings: null,
      issueId: null,
      config: { template: "base" },
      agentId: undefined,
      adapterType: undefined,
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
      issueId: null,
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

  async function seedPluginDriverEnvironment(pluginId: string) {
    const seeded = await seedEnvironment({
      driver: "plugin",
      name: "Plugin Fake plugin",
      config: {
        pluginKey: "acme.environments",
        driverKey: "fake-plugin",
        driverConfig: { template: "base" },
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
          { driverKey: "fake-plugin", displayName: "Fake plugin", configSchema: { type: "object" } },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);
    return seeded;
  }

  it("forwards a requested expiry to the acquire RPC and records only a provider-attested expiry", async () => {
    const pluginId = randomUUID();
    let receivedRequestedExpiresAt: unknown;
    const workerManager = {
      isRunning: vi.fn(() => true),
      call: vi.fn(async (_pluginId: string, method: string, params: Record<string, unknown>) => {
        if (method === "environmentAcquireLease") {
          receivedRequestedExpiresAt = params.requestedExpiresAt;
          // The provider grants no expiry.
          return { providerLeaseId: "plugin-lease-no-expiry", metadata: { remoteCwd: "/workspace" } };
        }
        return undefined;
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });
    const { companyId, environment, runId } = await seedPluginDriverEnvironment(pluginId);

    const requestedExpiresAt = new Date(Date.now() + 60_000);
    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
      requestedExpiresAt,
    });

    // The acquire RPC receives the requested expiry as an ISO 8601 string.
    expect(receivedRequestedExpiresAt).toBe(requestedExpiresAt.toISOString());
    // The provider gave no expiry, so the lease row records no expiry. The runtime
    // never synthesizes the requested deadline as evidence of provider enforcement.
    expect(acquired.lease.expiresAt ?? null).toBeNull();
  });

  it("records the real provider expiry when the provider grants one later than the requested deadline", async () => {
    const pluginId = randomUUID();
    const providerExpiresAt = new Date(Date.now() + 120_000).toISOString();
    const workerManager = {
      isRunning: vi.fn(() => true),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "plugin-lease-later",
            expiresAt: providerExpiresAt,
            metadata: { remoteCwd: "/workspace" },
          };
        }
        return undefined;
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });
    const { companyId, environment, runId } = await seedPluginDriverEnvironment(pluginId);

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
      requestedExpiresAt: new Date(Date.now() + 60_000),
    });

    // The lease row records the real provider expiry, not the requested deadline.
    // The caller then verifies the expiry bounds its deadline and fails closed.
    expect(acquired.lease.expiresAt?.toISOString()).toBe(providerExpiresAt);
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
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
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
      issueId: null,
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
    }), 31000);
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentDestroyLease", {
      driverKey: "fake-plugin",
      companyId,
      environmentId: environment.id,
      issueId: null,
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

  it("test_release_run_leases_continues_after_first_release_fails", async () => {
    const { companyId, environment, runId } = await seedEnvironment();
    const environmentsSvc = environmentService(db);

    // Seed two active leases for one run. The first driver release throws; the
    // second must still release.
    const failingLease = await environmentsSvc.acquireLease({
      companyId,
      environmentId: environment.id,
      heartbeatRunId: runId,
      provider: "local",
      providerLeaseId: "fail-release",
      metadata: { driver: "local" },
    });
    const healthyLease = await environmentsSvc.acquireLease({
      companyId,
      environmentId: environment.id,
      heartbeatRunId: runId,
      provider: "local",
      providerLeaseId: "healthy-release",
      metadata: { driver: "local" },
    });

    const runtimeWithFailingDriver = environmentRuntimeService(db, {
      drivers: [
        {
          driver: "local",
          acquireRunLease: async () => {
            throw new Error("acquire should not be called");
          },
          releaseRunLease: async ({ lease, status }) => {
            if (lease.providerLeaseId === "fail-release") {
              throw new Error("driver release failed");
            }
            return await environmentsSvc.releaseLease(lease.id, status);
          },
        },
      ],
    });

    const errors: Array<{ leaseId: string; error: unknown }> = [];
    const released = await runtimeWithFailingDriver.releaseRunLeases(
      runId,
      "released",
      (leaseId, error) => errors.push({ leaseId, error }),
    );

    // The healthy lease released even though the first release failed.
    expect(released).toHaveLength(1);
    expect(released[0]?.lease.id).toBe(healthyLease.id);
    expect(released[0]?.lease.status).toBe("released");

    // The failed release reported one lease-specific error.
    expect(errors).toHaveLength(1);
    expect(errors[0]?.leaseId).toBe(failingLease.id);
    expect((errors[0]?.error as Error).message).toBe("driver release failed");

    // The database confirms the isolation. The healthy lease released; the
    // failing lease stayed active.
    const rows = await db.select().from(environmentLeases);
    expect(rows.find((row) => row.id === healthyLease.id)?.status).toBe("released");
    expect(rows.find((row) => row.id === failingLease.id)?.status).toBe("active");
  });
});
