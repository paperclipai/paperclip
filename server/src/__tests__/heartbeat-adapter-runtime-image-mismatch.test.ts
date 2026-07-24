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
import { AdapterRuntimeImageMismatchError } from "@paperclipai/adapter-utils/execution-target";

// Isolated from heartbeat-plugin-environment.test.ts on purpose: these tests
// swap the mocked adapter's execute() implementation per-test (one-shot
// throws via mockImplementationOnce), and that module-level mock is shared
// for the lifetime of the test file process. Co-locating with the other
// plugin-environment heartbeat tests caused order-dependent flakiness (a
// prior test's still-in-flight background continuation work occasionally
// consumed a queued implementation meant for these tests). A dedicated file
// keeps the queue deterministic.
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
  findActiveServerAdapter: () => ({
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
    `Skipping embedded Postgres heartbeat adapter-runtime-image-mismatch tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat AdapterRuntimeImageMismatchError self-heal", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const tempRoots: string[] = [];

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("heartbeat-adapter-runtime-image-mismatch");
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
    await db.$client.end();
    await stopDb?.();
  });

  async function seedPluginSandboxRun(input: { environmentName: string; projectName: string }) {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    const environmentId = randomUUID();
    const pluginId = randomUUID();
    const pluginKey = `acme.environments.${pluginId}`;
    const agentId = randomUUID();
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-heartbeat-image-mismatch-"));
    tempRoots.push(workspaceRoot);

    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
      defaultResponsibleUserId: "responsible-user",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: input.projectName,
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
      name: input.environmentName,
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

    return { companyId, projectId, environmentId, pluginId, agentId };
  }

  function makeWorkerManager(pluginId: string) {
    let acquireCount = 0;
    const call = vi.fn(async (_pluginId: string, method: string) => {
      if (method === "environmentAcquireLease") {
        acquireCount += 1;
        return {
          providerLeaseId: `plugin-heartbeat-lease-${acquireCount}`,
          metadata: {
            remoteCwd: "/workspace/project",
          },
        };
      }
      if (method === "environmentDestroyLease") {
        return undefined;
      }
      if (method === "environmentReleaseLease") {
        return undefined;
      }
      throw new Error(`Unexpected plugin environment method: ${method}`);
    });
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call,
    } as unknown as PluginWorkerManager;
    return workerManager;
  }

  it("self-heals a single AdapterRuntimeImageMismatchError by destroying the lease and re-acquiring once", async () => {
    // Gap-2: the run lands on a pod whose runtime image is missing the
    // harness CLI (adapter.execute throws AdapterRuntimeImageMismatchError).
    // heartbeat.ts must destroy that lease, re-acquire + re-realize the
    // environment, and retry the adapter exactly once before the run can
    // succeed.
    const { companyId: _companyId, projectId, pluginId, agentId } = await seedPluginSandboxRun({
      environmentName: "Plugin Sandbox Self-heal",
      projectName: "Plugin Environment Self-heal",
    });
    const workerManager = makeWorkerManager(pluginId);

    adapterExecute.mockImplementationOnce(async () => {
      throw new AdapterRuntimeImageMismatchError(
        "codex",
        "sandbox pod plugin-heartbeat-lease-1",
        "detect probe exited 127",
      );
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

    expect(adapterExecute).toHaveBeenCalledTimes(2);
    const call = workerManager.call as unknown as ReturnType<typeof vi.fn>;
    const acquireCalls = call.mock.calls.filter(([, method]: [unknown, string]) => method === "environmentAcquireLease");
    const destroyCalls = call.mock.calls.filter(([, method]: [unknown, string]) => method === "environmentDestroyLease");
    expect(acquireCalls).toHaveLength(2);
    expect(destroyCalls).toHaveLength(1);
    // The destroy of the mismatched lease happens strictly between the two
    // acquires, not before the first or after the second.
    const methodSequence = call.mock.calls.map(([, method]: [unknown, string]) => method);
    expect(methodSequence.indexOf("environmentDestroyLease")).toBeGreaterThan(
      methodSequence.indexOf("environmentAcquireLease"),
    );
    expect(methodSequence.lastIndexOf("environmentAcquireLease")).toBeGreaterThan(
      methodSequence.indexOf("environmentDestroyLease"),
    );
  }, 15_000);

  it("surfaces adapter_runtime_image_mismatch as a terminal failure after one failed recovery attempt", async () => {
    // Second consecutive mismatch: the one-shot self-heal already destroyed
    // and re-acquired once, so the retried adapter.execute failing the same
    // way must surface the original typed error terminally instead of
    // looping.
    const { companyId: _companyId, projectId, pluginId, agentId } = await seedPluginSandboxRun({
      environmentName: "Plugin Sandbox Self-heal Terminal",
      projectName: "Plugin Environment Self-heal Terminal",
    });
    const workerManager = makeWorkerManager(pluginId);

    // Two queued one-shot throws (not a persistent mockRejectedValue): the
    // guard bounds heartbeat to exactly two adapter.execute attempts, and a
    // permanent override would otherwise leak into later tests since
    // afterEach only mockClear()s call history, not implementations.
    const mismatchOnce = async () => {
      throw new AdapterRuntimeImageMismatchError(
        "codex",
        "sandbox pod",
        "detect probe exited 127",
      );
    };
    adapterExecute.mockImplementationOnce(mismatchOnce).mockImplementationOnce(mismatchOnce);

    const heartbeat = heartbeatService(db, { pluginWorkerManager: workerManager });
    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: { projectId },
    });

    expect(run).not.toBeNull();
    await vi.waitFor(async () => {
      const latest = await heartbeat.getRun(run!.id);
      expect(latest?.status).toBe("failed");
    }, { timeout: 5_000 });

    const finalRun = await heartbeat.getRun(run!.id);
    expect(finalRun?.errorCode).toBe("adapter_runtime_image_mismatch");
    // Exactly one recovery attempt: two adapter.execute calls, one destroy,
    // two acquires. A third attempt would mean the guard flag failed to
    // bound the retry.
    expect(adapterExecute).toHaveBeenCalledTimes(2);
    const call = workerManager.call as unknown as ReturnType<typeof vi.fn>;
    const acquireCalls = call.mock.calls.filter(([, method]: [unknown, string]) => method === "environmentAcquireLease");
    const destroyCalls = call.mock.calls.filter(([, method]: [unknown, string]) => method === "environmentDestroyLease");
    expect(acquireCalls).toHaveLength(2);
    expect(destroyCalls).toHaveLength(1);
  }, 15_000);
});
