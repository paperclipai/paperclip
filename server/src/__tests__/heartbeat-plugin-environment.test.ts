import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  environments,
  executionWorkspaces,
  issues,
  plugins,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  closeDbClient,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.ts";

const adapterExecute = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  sessionParams: { sessionId: "session-1" },
  sessionDisplayId: "session-1",
  provider: "test",
  model: "test-model",
})));

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({
    type: "codex_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  listAdapterModelProfiles: async () => [],
  runningProcesses: new Map(),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat plugin environment tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat plugin environments", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  const tempRoots: string[] = [];
  // Heartbeat instances created per test, so their detached executeRun chains
  // can be drained before the next test / before the DB client is closed.
  const heartbeats: Array<ReturnType<typeof heartbeatService>> = [];

  function makeHeartbeat(options?: Parameters<typeof heartbeatService>[1]) {
    const heartbeat = heartbeatService(db, options);
    heartbeats.push(heartbeat);
    return heartbeat;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-plugin-environment");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    while (heartbeats.length > 0) {
      await heartbeats.pop()?.drain();
    }
    adapterExecute.mockClear();
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  afterAll(async () => {
    await closeDbClient(db);
    await tempDb?.cleanup();
  });

  it("acquires plugin environment leases through the heartbeat execution path", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    const environmentId = randomUUID();
    const pluginId = randomUUID();
    const pluginKey = `acme.environments.${pluginId}`;
    const agentId = randomUUID();
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-env-heartbeat-"));
    tempRoots.push(workspaceRoot);
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "plugin-heartbeat-lease",
            metadata: {
              remoteCwd: "/workspace/project",
            },
          };
        }
        if (method === "environmentReleaseLease") {
          return undefined;
        }
        throw new Error(`Unexpected plugin environment method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;

    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Plugin Environment Heartbeat",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(projectWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      name: "Primary",
      cwd: workspaceRoot,
      isPrimary: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey,
      packageName: "@acme/paperclip-environments",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: pluginKey,
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
            driverKey: "sandbox",
            displayName: "Sandbox",
            configSchema: { type: "object" },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);
    await db.insert(environments).values({
      id: environmentId,
      companyId,
      name: "Plugin Sandbox",
      driver: "plugin",
      status: "active",
        config: {
        pluginKey,
        driverKey: "sandbox",
        driverConfig: {
          template: "base",
        },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      defaultEnvironmentId: environmentId,
      permissions: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const heartbeat = makeHeartbeat({ pluginWorkerManager: workerManager });
    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: { projectId },
    });

    expect(run).not.toBeNull();
    await vi.waitFor(async () => {
      const latest = await heartbeat.getRun(run!.id);
      expect(latest?.status).toBe("succeeded");
    }, { timeout: 5_000 });

    expect(workerManager.call).toHaveBeenNthCalledWith(1, pluginId, "environmentAcquireLease", {
      driverKey: "sandbox",
      companyId,
      environmentId,
      executionWorkspaceId: expect.any(String),
      issueId: null,
      config: { template: "base" },
      agentId,
      runId: run!.id,
      workspaceMode: "shared_workspace",
      // Pins the HEARTBEAT-path lease call forwarding the AGENT's adapter type
      // (per-run adapter / mixed-harness envs). environment-runtime.ts has two
      // drivers calling environmentAcquireLease; regressions here previously
      // shipped by editing only the non-heartbeat one.
      adapterType: "codex_local",
    });
    await vi.waitFor(() => {
      expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentReleaseLease", {
        driverKey: "sandbox",
        companyId,
        environmentId,
        issueId: null,
        config: { template: "base" },
        providerLeaseId: "plugin-heartbeat-lease",
        leaseMetadata: expect.objectContaining({
          driver: "plugin",
          pluginId,
          pluginKey,
          driverKey: "sandbox",
        }),
      });
    }, { timeout: 5_000 });
    expect(adapterExecute).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("inherits the instance default environment across companies while preserving explicit agent overrides", async () => {
    const sharedEnvironmentId = randomUUID();
    const overrideEnvironmentId = randomUUID();
    const pluginId = randomUUID();
    const pluginKey = `acme.environments.${pluginId}`;
    const companyAId = randomUUID();
    const companyBId = randomUUID();
    const projectAId = randomUUID();
    const projectBId = randomUUID();
    const workspaceAId = randomUUID();
    const workspaceBId = randomUUID();
    const agentAId = randomUUID();
    const agentBId = randomUUID();
    const workspaceRootA = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-env-company-a-"));
    const workspaceRootB = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-env-company-b-"));
    tempRoots.push(workspaceRootA, workspaceRootB);
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string, payload: Record<string, unknown>) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: `plugin-heartbeat-lease-${String(payload.environmentId)}`,
            metadata: {
              remoteCwd: `/workspace/${String(payload.environmentId)}`,
            },
          };
        }
        if (method === "environmentReleaseLease") {
          return undefined;
        }
        throw new Error(`Unexpected plugin environment method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;

    await db.insert(plugins).values({
      id: pluginId,
      pluginKey,
      packageName: "@acme/paperclip-environments",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: pluginKey,
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
            driverKey: "sandbox",
            displayName: "Sandbox",
            configSchema: { type: "object" },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);
    await db.insert(environments).values([
      {
        id: sharedEnvironmentId,
        name: "Shared Plugin Sandbox",
        driver: "plugin",
        status: "active",
        config: {
          pluginKey,
          driverKey: "sandbox",
          driverConfig: {
            template: "shared",
          },
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: overrideEnvironmentId,
        name: "Override Plugin Sandbox",
        driver: "plugin",
        status: "active",
        config: {
          pluginKey,
          driverKey: "sandbox",
          driverConfig: {
            template: "override",
          },
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    await instanceSettingsService(db).update({ defaultEnvironmentId: sharedEnvironmentId });

    await db.insert(companies).values([
      {
        id: companyAId,
        name: "Acme A",
        issuePrefix: `T${companyAId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: companyBId,
        name: "Acme B",
        issuePrefix: `T${companyBId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    await db.insert(projects).values([
      {
        id: projectAId,
        companyId: companyAId,
        name: "Company A Project",
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: projectBId,
        companyId: companyBId,
        name: "Company B Project",
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    await db.insert(projectWorkspaces).values([
      {
        id: workspaceAId,
        companyId: companyAId,
        projectId: projectAId,
        name: "Primary",
        cwd: workspaceRootA,
        isPrimary: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: workspaceBId,
        companyId: companyBId,
        projectId: projectBId,
        name: "Primary",
        cwd: workspaceRootB,
        isPrimary: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    await db.insert(agents).values([
      {
        id: agentAId,
        companyId: companyAId,
        name: "SharedEnvAgent",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        defaultEnvironmentId: null,
        permissions: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: agentBId,
        companyId: companyBId,
        name: "OverrideEnvAgent",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        defaultEnvironmentId: overrideEnvironmentId,
        permissions: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const heartbeat = heartbeatService(db, { pluginWorkerManager: workerManager });
    const sharedRun = await heartbeat.wakeup(agentAId, {
      source: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: { projectId: projectAId },
    });
    const overrideRun = await heartbeat.wakeup(agentBId, {
      source: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: { projectId: projectBId },
    });

    expect(sharedRun).not.toBeNull();
    expect(overrideRun).not.toBeNull();
    await vi.waitFor(async () => {
      const [latestShared, latestOverride] = await Promise.all([
        heartbeat.getRun(sharedRun!.id),
        heartbeat.getRun(overrideRun!.id),
      ]);
      expect(latestShared?.status).toBe("succeeded");
      expect(latestOverride?.status).toBe("succeeded");
    }, { timeout: 5_000 });

    const acquireCalls = workerManager.call.mock.calls
      .filter(([, method]) => method === "environmentAcquireLease");

    expect(acquireCalls).toHaveLength(2);
    expect(acquireCalls[0]?.[2]).toMatchObject({
      companyId: companyAId,
      environmentId: sharedEnvironmentId,
      config: { template: "shared" },
      agentId: agentAId,
      runId: sharedRun!.id,
      adapterType: "codex_local",
    });
    expect(acquireCalls[1]?.[2]).toMatchObject({
      companyId: companyBId,
      environmentId: overrideEnvironmentId,
      config: { template: "override" },
      agentId: agentBId,
      runId: overrideRun!.id,
      adapterType: "codex_local",
    });
  }, 15_000);

  it("ignores stale non-reused workspace environment config in favor of the assignee selection", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    const oldEnvironmentId = randomUUID();
    const newEnvironmentId = randomUUID();
    const pluginId = randomUUID();
    const pluginKey = `acme.environments.${pluginId}`;
    const agentId = randomUUID();
    const issueId = randomUUID();
    const staleExecutionWorkspaceId = randomUUID();
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-env-issue-"));
    tempRoots.push(workspaceRoot);
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string, payload: Record<string, unknown>) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: `plugin-heartbeat-lease-${String(payload.environmentId)}`,
            metadata: {
              remoteCwd: `/workspace/${String(payload.environmentId)}`,
            },
          };
        }
        if (method === "environmentReleaseLease") {
          return undefined;
        }
        throw new Error(`Unexpected plugin environment method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;

    await instanceSettingsService(db).updateExperimental({
      enableEnvironments: true,
      enableIsolatedWorkspaces: true,
    });
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Plugin Environment Issue",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(projectWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      name: "Primary",
      cwd: workspaceRoot,
      isPrimary: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey,
      packageName: "@acme/paperclip-environments",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: pluginKey,
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
            driverKey: "sandbox",
            displayName: "Sandbox",
            configSchema: { type: "object" },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);
    await db.insert(environments).values([
      {
        id: oldEnvironmentId,
        companyId,
        name: "QA SSH",
        driver: "plugin",
        status: "active",
        config: {
          pluginKey,
          driverKey: "sandbox",
          driverConfig: {
            template: "old",
          },
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: newEnvironmentId,
        companyId,
        name: "QA E2B",
        driver: "plugin",
        status: "active",
        config: {
          pluginKey,
          driverKey: "sandbox",
          driverConfig: {
            template: "new",
          },
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      defaultEnvironmentId: newEnvironmentId,
      permissions: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(executionWorkspaces).values({
      id: staleExecutionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId: workspaceId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Stale workspace",
      status: "active",
      cwd: workspaceRoot,
      providerType: "local_fs",
      providerRef: workspaceRoot,
      metadata: {
        config: {
          environmentId: oldEnvironmentId,
        },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId: workspaceId,
      title: "Environment matrix: e2b / codex_local",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionWorkspaceId: staleExecutionWorkspaceId,
      executionWorkspaceSettings: {
        mode: "shared_workspace",
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const heartbeat = makeHeartbeat({ pluginWorkerManager: workerManager });
    const run = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "manual",
      contextSnapshot: { issueId },
    });

    expect(run).not.toBeNull();
    await vi.waitFor(async () => {
      const latest = await heartbeat.getRun(run!.id);
      expect(latest?.status).toBe("succeeded");
    }, { timeout: 5_000 });

    expect(workerManager.call).toHaveBeenNthCalledWith(1, pluginId, "environmentAcquireLease", {
      driverKey: "sandbox",
      companyId,
      environmentId: newEnvironmentId,
      executionWorkspaceId: expect.any(String),
      issueId,
      config: { template: "new" },
      agentId,
      runId: run!.id,
      workspaceMode: "shared_workspace",
      adapterType: "codex_local",
    });
  }, 15_000);
});
