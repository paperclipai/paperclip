/**
 * Regression test for PAP-9585.
 *
 * `restartWorker` is called by the dev file-watcher whenever a local-path
 * plugin's source files change. Before PAP-9585 it only bounced the worker
 * subprocess, which left newly added `migrations/*.sql` files unapplied — the
 * plugin schema would silently drift out of sync with worker code.
 *
 * The fix is for `restartWorker` to do a full deactivate + reactivate cycle
 * via the plugin loader, which re-reads the manifest from disk and runs
 * `applyMigrations` (idempotently) before starting the new worker.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const pluginRecord = {
  id: "plugin-1",
  pluginKey: "example.plugin",
  status: "ready",
  manifestJson: { id: "example.plugin", capabilities: [] },
  packageName: "@example/plugin",
  version: "1.0.0",
  packagePath: "/tmp/example-plugin",
};

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  update: vi.fn(),
  updateStatus: vi.fn(),
  upsertConfig: vi.fn(),
  getConfig: vi.fn(),
  list: vi.fn(),
  delete: vi.fn(),
  uninstall: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";
import type { PluginLoader } from "../services/plugin-loader.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

function makeWorkerManagerStub() {
  const handle = {
    restart: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  return {
    handle,
    workerManager: {
      getWorker: vi.fn().mockReturnValue(handle),
      isRunning: vi.fn().mockReturnValue(true),
      startWorker: vi.fn().mockResolvedValue(undefined),
      stopWorker: vi.fn().mockResolvedValue(undefined),
      restartWorker: vi.fn().mockResolvedValue(undefined),
    } as unknown as PluginWorkerManager,
  };
}

describe("pluginLifecycleManager.restartWorker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("does a full deactivate+reactivate cycle when the loader has runtime services", async () => {
    mockRegistry.getById.mockResolvedValue(pluginRecord);
    mockRegistry.updateStatus.mockResolvedValue(pluginRecord);

    const { handle, workerManager } = makeWorkerManagerStub();

    const loader: Partial<PluginLoader> = {
      hasRuntimeServices: vi.fn().mockReturnValue(true) as PluginLoader["hasRuntimeServices"],
      loadSingle: vi.fn().mockResolvedValue({
        success: true,
        plugin: pluginRecord,
        registered: { worker: true, eventSubscriptions: 0, jobs: 0, webhooks: 0, tools: 0 },
      }) as PluginLoader["loadSingle"],
      unloadSingle: vi.fn().mockResolvedValue(undefined) as PluginLoader["unloadSingle"],
    };

    const lifecycle = pluginLifecycleManager(
      {} as never,
      { loader: loader as PluginLoader, workerManager },
    );
    const stopped = vi.fn();
    const started = vi.fn();
    lifecycle.on("plugin.worker_stopped", stopped);
    lifecycle.on("plugin.worker_started", started);

    await lifecycle.restartWorker("plugin-1");

    expect(loader.unloadSingle).toHaveBeenCalledWith("plugin-1", "example.plugin");
    expect(loader.loadSingle).toHaveBeenCalledWith("plugin-1");
    // The bare worker handle should NOT be bounced — the loader handles
    // worker (re)start as part of activate.
    expect(handle.restart).not.toHaveBeenCalled();
    expect(stopped).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
  });

  it("falls back to bouncing the worker handle when the loader has no runtime services", async () => {
    mockRegistry.getById.mockResolvedValue(pluginRecord);
    mockRegistry.updateStatus.mockResolvedValue(pluginRecord);

    const { handle, workerManager } = makeWorkerManagerStub();

    const loader: Partial<PluginLoader> = {
      hasRuntimeServices: vi.fn().mockReturnValue(false) as PluginLoader["hasRuntimeServices"],
      loadSingle: vi.fn() as PluginLoader["loadSingle"],
      unloadSingle: vi.fn() as PluginLoader["unloadSingle"],
    };

    const lifecycle = pluginLifecycleManager(
      {} as never,
      { loader: loader as PluginLoader, workerManager },
    );
    const stopped = vi.fn();
    const started = vi.fn();
    lifecycle.on("plugin.worker_stopped", stopped);
    lifecycle.on("plugin.worker_started", started);

    await lifecycle.restartWorker("plugin-1");

    expect(loader.unloadSingle).not.toHaveBeenCalled();
    expect(loader.loadSingle).not.toHaveBeenCalled();
    expect(handle.restart).toHaveBeenCalledTimes(1);
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(stopped).toHaveBeenCalledWith({ pluginId: "plugin-1", pluginKey: "example.plugin" });
    expect(started).toHaveBeenCalledTimes(1);
    expect(started).toHaveBeenCalledWith({ pluginId: "plugin-1", pluginKey: "example.plugin" });
  });
});

describe("pluginLifecycleManager.unload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeUnloadLoader(): PluginLoader {
    return {
      hasRuntimeServices: vi.fn().mockReturnValue(false),
      cleanupInstallArtifacts: vi.fn().mockResolvedValue(undefined),
    } as unknown as PluginLoader;
  }

  it("purges plugin-owned data before hard-deleting the registry row", async () => {
    const disabledPlugin = { ...pluginRecord, status: "disabled" };
    mockRegistry.getById.mockResolvedValue(disabledPlugin);
    mockRegistry.uninstall.mockResolvedValue(null);
    const purgePluginData = vi.fn().mockResolvedValue(undefined);
    const lifecycle = pluginLifecycleManager({} as never, {
      loader: makeUnloadLoader(),
      purgePluginData,
    });

    await lifecycle.unload(pluginRecord.id, true);

    expect(purgePluginData).toHaveBeenCalledWith(disabledPlugin);
    expect(mockRegistry.uninstall).toHaveBeenCalledWith(pluginRecord.id, true);
    expect(purgePluginData.mock.invocationCallOrder[0]).toBeLessThan(
      mockRegistry.uninstall.mock.invocationCallOrder[0]!,
    );
  });

  it("fails closed before registry deletion when namespace purge fails", async () => {
    const disabledPlugin = { ...pluginRecord, status: "disabled" };
    mockRegistry.getById.mockResolvedValue(disabledPlugin);
    const lifecycle = pluginLifecycleManager({} as never, {
      loader: makeUnloadLoader(),
      purgePluginData: vi.fn().mockRejectedValue(new Error("drop failed")),
    });

    await expect(lifecycle.unload(pluginRecord.id, true)).rejects.toThrow("drop failed");
    expect(mockRegistry.uninstall).not.toHaveBeenCalled();
  });

  it("treats repeated hard uninstall as an idempotent no-op", async () => {
    mockRegistry.getById.mockResolvedValue(null);
    const lifecycle = pluginLifecycleManager({} as never, {
      loader: makeUnloadLoader(),
      purgePluginData: vi.fn(),
    });

    await expect(lifecycle.unload(pluginRecord.id, true)).resolves.toBeNull();
    expect(mockRegistry.uninstall).not.toHaveBeenCalled();
  });
});
