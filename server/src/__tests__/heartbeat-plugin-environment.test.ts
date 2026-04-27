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
  plugins,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
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
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const tempRoots: string[] = [];

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("heartbeat-plugin-environment");
    stopDb = started.stop;
    db = createDb(started.connectionString);
  }, 20_000);

  afterEach(async () => {
    adapterExecute.mockClear();
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  afterAll(async () => {
    await stopDb?.();
  });

  it("acquires plugin environment leases through the heartbeat execution path", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    const environmentId = randomUUID();
    const pluginId = randomUUID();
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
        pluginKey: "acme.environments",
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

    const heartbeat = heartbeatService(db, { pluginWorkerManager: workerManager });
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

    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentAcquireLease", {
      driverKey: "sandbox",
      companyId,
      environmentId,
      config: { template: "base" },
      runId: run!.id,
      workspaceMode: "shared_workspace",
    });
    await vi.waitFor(() => {
      expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentReleaseLease", {
        driverKey: "sandbox",
        companyId,
        environmentId,
        config: { template: "base" },
        providerLeaseId: "plugin-heartbeat-lease",
        leaseMetadata: expect.objectContaining({
          driver: "plugin",
          pluginId,
          pluginKey: "acme.environments",
          driverKey: "sandbox",
        }),
      });
    }, { timeout: 5_000 });
    expect(adapterExecute).toHaveBeenCalledTimes(1);
  });
});
