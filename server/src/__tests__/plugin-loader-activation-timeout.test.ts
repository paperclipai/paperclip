import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { applyPendingMigrations, closeRegisteredClients, createDb, plugins } from "@paperclipai/db";
import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import { PLUGIN_ACTIVATION_TIMEOUT_ERROR_PREFIX, pluginLoader, type PluginRuntimeServices } from "../services/plugin-loader.js";
import { createPluginWorkerManager } from "../services/plugin-worker-manager.js";
import { pluginRegistryService } from "../services/plugin-registry.js";
import { bundledImageFixture } from "./helpers/bundled-image-fixture.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const externalDatabaseUrl = process.env.PAPERCLIP_BUNDLED_PLUGIN_TEST_DATABASE_URL?.trim();
const support = externalDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

const initializeTimeout = (pluginId: string) => new Error(`Worker initialize failed for "${pluginId}": RPC call "initialize" timed out after 15000ms`,
  { cause: new JsonRpcCallError({ code: PLUGIN_RPC_ERROR_CODES.TIMEOUT, message: 'RPC call "initialize" timed out after 15000ms' }) });

describePostgres("plugin activation after a worker initialize timeout", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const roots: string[] = [];
  beforeAll(async () => {
    if (externalDatabaseUrl) {
      await applyPendingMigrations(externalDatabaseUrl);
      database = { connectionString: externalDatabaseUrl, cleanup: () => closeRegisteredClients(externalDatabaseUrl) };
    } else {
      database = await startEmbeddedPostgresTestDatabase("plugin-activation-timeout-");
    }
    db = createDb(database.connectionString);
  }, 90_000);
  afterEach(async () => {
    await db.delete(plugins);
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  afterAll(async () => { await database?.cleanup(); });

  async function setup(startOutcomes: Array<"timeout" | "crash" | "ok">, beforeRecoveredStart?: (pluginId: string) => Promise<void>) {
    const image = bundledImageFixture();
    roots.push(image.root);
    const options = {
      localPluginDir: path.join(image.root, "home"), prebuiltOnly: true,
      resolvePackageRoot: image.resolver.resolve, assertPackageActivation: image.resolver.assertActivation,
      enableLocalFilesystem: false, enableNpmDiscovery: false,
      activationTimeoutRetryDelaysMs: [20, 20], activationTimeoutOnDemandIntervalMs: 0,
    };
    await pluginLoader(db, options).installPlugin({ localPath: image.packageRoot });
    const registry = pluginRegistryService(db);
    const row = (await registry.getByKey(image.manifest.id))!;
    await registry.updateStatus(row.id, { status: "ready" });
    let running = false;
    let handle: { status: "crashed" | "running" } | undefined;
    const startWorker = vi.fn(async (pluginId: string) => {
      if (handle) throw new Error(`Worker already registered for plugin ${pluginId}`);
      const outcome = startOutcomes.shift() ?? "ok";
      if (outcome !== "ok") {
        handle = { status: "crashed" };
        if (outcome === "timeout") throw initializeTimeout(pluginId);
        throw new Error(`Worker initialize failed for "${pluginId}": worker exited with code 1`);
      }
      if (startWorker.mock.calls.length > 1) await beforeRecoveredStart?.(pluginId);
      handle = { status: "running" };
      running = true;
    });
    const markError = vi.fn(async (pluginId: string, error: string) => registry.updateStatus(pluginId, { status: "error", lastError: error }));
    const services = {
      workerManager: {
        startWorker, call: vi.fn(async () => ({})), isRunning: vi.fn(() => running),
        stopWorker: vi.fn(async () => { running = false; handle = undefined; }), stopAll: vi.fn(async () => { running = false; handle = undefined; }),
        getWorker: vi.fn(() => handle),
      },
      lifecycleManager: { markError },
      jobStore: { syncJobDeclarations: vi.fn() }, jobScheduler: { registerPlugin: vi.fn(), unregisterPlugin: vi.fn(), stop: vi.fn() },
      toolDispatcher: { unregisterPluginTools: vi.fn() },
      eventBus: { forPlugin: vi.fn(), subscriptionCount: vi.fn(() => 0), clearPlugin: vi.fn() },
      buildHostHandlers: vi.fn(() => ({})), instanceInfo: { instanceId: "fixture", hostVersion: "1.0.0" },
    } as unknown as PluginRuntimeServices;
    const loader = pluginLoader(db, options, services);
    return { loader, registry, row, startWorker, markError, isRunning: () => running };
  }

  it("retries an activation whose worker initialize timed out and ends ready with a running worker", async () => {
    const { loader, registry, row, startWorker, markError, isRunning } = await setup(["timeout", "ok"]);
    const result = await loader.loadAll();
    expect(result.failed).toBe(1);
    expect((await registry.getById(row.id))!).toMatchObject({ status: "ready",
      lastError: expect.stringContaining(PLUGIN_ACTIVATION_TIMEOUT_ERROR_PREFIX) });
    await vi.waitFor(() => expect(isRunning()).toBe(true), { timeout: 5_000 });
    expect(startWorker).toHaveBeenCalledTimes(2);
    expect(markError).not.toHaveBeenCalled();
    await vi.waitFor(async () => expect((await registry.getById(row.id))!).toMatchObject({ status: "ready", lastError: null }));
    await loader.shutdownAll();
  });

  it("does not bring back a plugin an operator disabled while its activation was timing out", async () => {
    const { loader, registry, row, startWorker } = await setup(["timeout", "ok"]);
    await loader.loadAll();
    await registry.updateStatus(row.id, { status: "disabled" });
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(startWorker).toHaveBeenCalledOnce();
    expect((await registry.getById(row.id))!.status).toBe("disabled");
    expect(loader.requestActivationTimeoutRecovery({ id: row.id, status: "error", lastError: `${PLUGIN_ACTIVATION_TIMEOUT_ERROR_PREFIX} after 2 retries` })).toBe(true);
    await loader.stopActivationTimeoutRecovery();
    expect(startWorker).toHaveBeenCalledOnce();
    expect((await registry.getById(row.id))!.status).toBe("disabled");
  });

  it("stops a recovered worker when an operator disabled the plugin during its activation", async () => {
    let disable: ((pluginId: string) => Promise<void>) | undefined;
    const { loader, registry, row, startWorker, isRunning } = await setup(["timeout", "ok"], async pluginId => { await disable?.(pluginId); });
    disable = async pluginId => { await registry.updateStatus(pluginId, { status: "disabled" }); };
    await loader.loadAll();
    await vi.waitFor(() => expect(startWorker).toHaveBeenCalledTimes(2), { timeout: 5_000 });
    await vi.waitFor(() => expect(isRunning()).toBe(false), { timeout: 5_000 });
    await loader.stopActivationTimeoutRecovery();
    expect(isRunning()).toBe(false);
    expect((await registry.getById(row.id))!.status).toBe("disabled");
  });

  it("cancels a pending retry on shutdown", async () => {
    const { loader, startWorker } = await setup(["timeout", "ok"]);
    await loader.loadAll();
    await loader.stopActivationTimeoutRecovery();
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(startWorker).toHaveBeenCalledOnce();
  });

  it("marks a plugin error once its activation keeps timing out past the bound", async () => {
    const { loader, registry, row, startWorker, markError, isRunning } = await setup(["timeout", "timeout", "timeout"]);
    await loader.loadAll();
    await vi.waitFor(() => expect(markError).toHaveBeenCalledOnce(), { timeout: 5_000 });
    expect(startWorker).toHaveBeenCalledTimes(3);
    expect(markError).toHaveBeenCalledWith(row.id, expect.stringMatching(new RegExp(`^${PLUGIN_ACTIVATION_TIMEOUT_ERROR_PREFIX} after 2 retries`)));
    expect(isRunning()).toBe(false);
    const errored = (await registry.getById(row.id))!;
    expect(errored.status).toBe("error");

    expect(loader.requestActivationTimeoutRecovery(errored)).toBe(true);
    await vi.waitFor(() => expect(isRunning()).toBe(true), { timeout: 5_000 });
    expect(startWorker).toHaveBeenCalledTimes(4);
    expect((await registry.getById(row.id))!.status).toBe("ready");
    await loader.shutdownAll();
  });

  it("recovers a real worker whose first initialize stalled past the host timeout", async () => {
    const markerRoot = mkdtempSync(path.join(os.tmpdir(), "plugin-stall-marker-"));
    roots.push(markerRoot);
    const marker = path.join(markerRoot, "stalled");
    const image = bundledImageFixture({}, { workerPrelude: `import { existsSync as stalledBefore, writeFileSync as markStalled } from "node:fs";
if (!process.argv.includes("--source") && !stalledBefore(${JSON.stringify(marker)})) { markStalled(${JSON.stringify(marker)}, "stalled"); setInterval(() => {}, 60_000); await new Promise(() => {}); }` });
    roots.push(image.root);
    const options = {
      localPluginDir: path.join(image.root, "home"), prebuiltOnly: true,
      resolvePackageRoot: image.resolver.resolve, assertPackageActivation: image.resolver.assertActivation,
      enableLocalFilesystem: false, enableNpmDiscovery: false, activationTimeoutRetryDelaysMs: [50],
    };
    await pluginLoader(db, options).installPlugin({ localPath: image.packageRoot });
    const registry = pluginRegistryService(db);
    const row = (await registry.getByKey(image.manifest.id))!;
    await registry.updateStatus(row.id, { status: "ready" });
    const manager = createPluginWorkerManager();
    const markError = vi.fn(async (pluginId: string, error: string) => registry.updateStatus(pluginId, { status: "error", lastError: error }));
    const services = {
      workerManager: manager, lifecycleManager: { markError },
      jobStore: { syncJobDeclarations: vi.fn() }, jobScheduler: { registerPlugin: vi.fn(), unregisterPlugin: vi.fn(), stop: vi.fn() },
      toolDispatcher: { unregisterPluginTools: vi.fn() },
      eventBus: { forPlugin: vi.fn(), subscriptionCount: vi.fn(() => 0), clearPlugin: vi.fn() },
      buildHostHandlers: vi.fn(() => ({})), instanceInfo: { instanceId: "fixture", hostVersion: "1.0.0" },
    } as unknown as PluginRuntimeServices;
    const loader = pluginLoader(db, options, services);
    try {
      const result = await loader.loadAll();
      expect(result.failed).toBe(1);
      expect(existsSync(marker)).toBe(true);
      await vi.waitFor(() => expect(manager.isRunning(row.id)).toBe(true), { timeout: 10_000 });
      expect(await manager.call(row.id, "health", {})).toMatchObject({ status: "ok" });
      expect(markError).not.toHaveBeenCalled();
      await vi.waitFor(async () => expect((await registry.getById(row.id))!).toMatchObject({ status: "ready", lastError: null }));
    } finally {
      await loader.shutdownAll();
    }
  }, 60_000);

  it("keeps a deterministic activation failure a permanent error without retrying it", async () => {
    const { loader, registry, row, startWorker, markError } = await setup(["crash", "ok"]);
    await loader.loadAll();
    expect(markError).toHaveBeenCalledWith(row.id, expect.stringMatching(/^Activation failed: /));
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(startWorker).toHaveBeenCalledOnce();
    const errored = (await registry.getById(row.id))!;
    expect(errored.status).toBe("error");
    expect(loader.requestActivationTimeoutRecovery(errored)).toBe(false);
    await loader.shutdownAll();
  });
});
