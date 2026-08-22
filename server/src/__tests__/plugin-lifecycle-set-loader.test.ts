/**
 * Regression test for the plugin-lifecycle singleton fix (AMA-10).
 *
 * The dynamic plugin-tool dispatcher subscribes to lifecycle events on the
 * lifecycle-manager instance it is handed at startup. Previously the HTTP
 * plugin routes constructed a *separate* lifecycle-manager instance, so the
 * events they emitted (plugin.enabled/disabled/unloaded) fired on a different
 * EventEmitter and never reached the dispatcher — dynamically enabled plugins
 * did not register their tools until a server restart.
 *
 * The fix shares one lifecycle-manager instance between the routes and the
 * dispatcher. To do that the composition root must construct the manager
 * before the loader exists (the loader depends on the manager) and backfill
 * the loader afterwards via `setLoader`. These tests pin the `setLoader`
 * contract that makes that wiring possible.
 */
import { describe, expect, it, vi } from "vitest";
import type { PluginLoader } from "../services/plugin-loader.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

const disabledPlugin = {
  id: "plugin-1",
  pluginKey: "example.plugin",
  status: "disabled",
  manifestJson: { id: "example.plugin", capabilities: [] },
  packageName: "@example/plugin",
  version: "1.0.0",
  packagePath: "/tmp/example-plugin",
};

const readyPlugin = { ...disabledPlugin, status: "ready" };

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  update: vi.fn(),
  updateStatus: vi.fn(),
  upsertConfig: vi.fn(),
  getConfig: vi.fn(),
  list: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";

function makeWorkerManagerStub() {
  return {
    getWorker: vi.fn().mockReturnValue(undefined),
    isRunning: vi.fn().mockReturnValue(false),
    startWorker: vi.fn().mockResolvedValue(undefined),
    stopWorker: vi.fn().mockResolvedValue(undefined),
    restartWorker: vi.fn().mockResolvedValue(undefined),
  } as unknown as PluginWorkerManager;
}

function makeRuntimeLoaderStub(): Partial<PluginLoader> {
  return {
    hasRuntimeServices: vi.fn().mockReturnValue(true) as PluginLoader["hasRuntimeServices"],
    loadSingle: vi.fn().mockResolvedValue({
      success: true,
      plugin: readyPlugin,
      registered: { worker: true, eventSubscriptions: 0, jobs: 0, webhooks: 0, tools: 0 },
    }) as PluginLoader["loadSingle"],
    unloadSingle: vi.fn().mockResolvedValue(undefined) as PluginLoader["unloadSingle"],
  };
}

describe("pluginLifecycleManager.setLoader", () => {
  it("routes runtime activation through the backfilled loader, not the construction-time one", async () => {
    mockRegistry.getById.mockResolvedValue(disabledPlugin);
    mockRegistry.updateStatus.mockResolvedValue(readyPlugin);

    // Mirrors the startup wiring: the manager is constructed with a
    // non-runtime loader so bundled-plugin `load()` calls at boot only record
    // status and never spawn a worker.
    const bootLoader = makeRuntimeLoaderStub();
    (bootLoader.hasRuntimeServices as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const lifecycle = pluginLifecycleManager(
      {} as never,
      { loader: bootLoader as PluginLoader, workerManager: makeWorkerManagerStub() },
    );

    // Backfill the real runtime-capable loader after construction.
    const runtimeLoader = makeRuntimeLoaderStub();
    lifecycle.setLoader(runtimeLoader as PluginLoader);

    await lifecycle.enable("plugin-1");

    // Activation must go through the backfilled loader...
    expect(runtimeLoader.loadSingle).toHaveBeenCalledWith("plugin-1");
    // ...and never touch the loader the manager was constructed with.
    expect(bootLoader.loadSingle).not.toHaveBeenCalled();
  });

  it("emits plugin.enabled on the shared emitter so a co-located dispatcher listener fires", async () => {
    mockRegistry.getById.mockResolvedValue(disabledPlugin);
    mockRegistry.updateStatus.mockResolvedValue(readyPlugin);

    const lifecycle = pluginLifecycleManager(
      {} as never,
      { workerManager: makeWorkerManagerStub() },
    );
    lifecycle.setLoader(makeRuntimeLoaderStub() as PluginLoader);

    // A listener registered like the tool dispatcher registers its own.
    const dispatcherListener = vi.fn();
    lifecycle.on("plugin.enabled", dispatcherListener);

    await lifecycle.enable("plugin-1");

    expect(dispatcherListener).toHaveBeenCalledTimes(1);
    expect(dispatcherListener).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: "plugin-1", pluginKey: "example.plugin" }),
    );
  });
});
