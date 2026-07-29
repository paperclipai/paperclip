import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createManagedBundledPluginWorkerRecovery } from "../app.js";
import { listReadyPluginEnvironmentDrivers } from "../services/plugin-environment-driver.js";
import type { PluginLoader } from "../services/plugin-loader.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

const mockRegistry = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

const PLUGIN_ID = "plugin-daytona";
const PLUGIN_KEY = "paperclip.daytona-sandbox-provider";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_KEY,
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Daytona Sandbox Provider",
  description: "Provides Daytona-backed sandboxes.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: { worker: "dist/worker.js" },
  environmentDrivers: [
    {
      driverKey: "daytona",
      kind: "sandbox_provider",
      displayName: "Daytona",
      description: "Daytona sandbox provider",
      configSchema: { type: "object", properties: {} },
    },
  ],
};

function createPlugin(status: string, options: { id?: string; pluginKey?: string } = {}) {
  return {
    id: options.id ?? PLUGIN_ID,
    pluginKey: options.pluginKey ?? PLUGIN_KEY,
    status,
    manifestJson: manifest,
  };
}

function createWorkerManager(options: {
  running?: boolean;
  hasHandle?: boolean;
} = {}) {
  let running = options.running ?? false;
  const workerManager = {
    isRunning: vi.fn(() => running),
    getWorker: vi.fn(() => (options.hasHandle ? { status: "backoff" } : undefined)),
  } as unknown as PluginWorkerManager;
  return {
    workerManager,
    markRunning: () => {
      running = true;
    },
  };
}

function createDeferred<T = void>() {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("listReadyPluginEnvironmentDrivers worker recovery", () => {
  beforeEach(() => {
    mockRegistry.list.mockReset();
  });

  it("recovers a managed bundled provider that was installed by a sibling process after this process skipped it", async () => {
    const plugin = createPlugin("installed");
    mockRegistry.list.mockImplementation(async () => [plugin]);
    const worker = createWorkerManager();
    const startWorker = vi.fn(async () => {
      worker.markRunning();
      return true;
    });

    await expect(
      listReadyPluginEnvironmentDrivers({
        db: {} as never,
        workerManager: worker.workerManager,
        recoverMissingWorker: {
          pluginKeys: [PLUGIN_KEY],
          startWorker,
        },
      }),
    ).resolves.toEqual([]);
    expect(startWorker).not.toHaveBeenCalled();

    plugin.status = "ready";
    const drivers = await listReadyPluginEnvironmentDrivers({
      db: {} as never,
      workerManager: worker.workerManager,
      recoverMissingWorker: {
        pluginKeys: [PLUGIN_KEY],
        startWorker,
      },
    });

    expect(startWorker).toHaveBeenCalledWith({
      id: PLUGIN_ID,
      pluginKey: PLUGIN_KEY,
    });
    expect(drivers).toEqual([
      expect.objectContaining({
        pluginId: PLUGIN_ID,
        pluginKey: PLUGIN_KEY,
        driverKey: "daytona",
        displayName: "Daytona",
      }),
    ]);
  });

  it("does not lazy-start ready plugins outside the managed bundled allowlist", async () => {
    const plugin = createPlugin("ready");
    mockRegistry.list.mockResolvedValue([plugin]);
    const worker = createWorkerManager();
    const startWorker = vi.fn(async () => {
      worker.markRunning();
      return true;
    });

    const drivers = await listReadyPluginEnvironmentDrivers({
      db: {} as never,
      workerManager: worker.workerManager,
      recoverMissingWorker: {
        pluginKeys: ["paperclip.kubernetes-sandbox-provider"],
        startWorker,
      },
    });

    expect(startWorker).not.toHaveBeenCalled();
    expect(drivers).toEqual([]);
  });

  it("leaves existing worker-manager recovery handles alone", async () => {
    const plugin = createPlugin("ready");
    mockRegistry.list.mockResolvedValue([plugin]);
    const worker = createWorkerManager({ hasHandle: true });
    const startWorker = vi.fn(async () => true);

    const drivers = await listReadyPluginEnvironmentDrivers({
      db: {} as never,
      workerManager: worker.workerManager,
      recoverMissingWorker: {
        pluginKeys: [PLUGIN_KEY],
        startWorker,
      },
    });

    expect(startWorker).not.toHaveBeenCalled();
    expect(drivers).toEqual([]);
  });

  it("single-flights concurrent managed bundled recovery starts", async () => {
    const plugin = createPlugin("ready");
    mockRegistry.list.mockResolvedValue([plugin]);
    const worker = createWorkerManager();
    const loadStarted = createDeferred();
    const releaseLoad = createDeferred();
    const loadSingle = vi.fn(async () => {
      loadStarted.resolve();
      await releaseLoad.promise;
      worker.markRunning();
      return { success: true };
    });
    const startWorker = createManagedBundledPluginWorkerRecovery({
      managedBundledPluginKeys: [PLUGIN_KEY],
      workerManager: worker.workerManager,
      getLoader: () => ({ loadSingle }) as Pick<PluginLoader, "loadSingle">,
    });

    const first = listReadyPluginEnvironmentDrivers({
      db: {} as never,
      workerManager: worker.workerManager,
      recoverMissingWorker: {
        pluginKeys: [PLUGIN_KEY],
        startWorker,
      },
    });
    await loadStarted.promise;
    const second = listReadyPluginEnvironmentDrivers({
      db: {} as never,
      workerManager: worker.workerManager,
      recoverMissingWorker: {
        pluginKeys: [PLUGIN_KEY],
        startWorker,
      },
    });

    releaseLoad.resolve();
    const [firstDrivers, secondDrivers] = await Promise.all([first, second]);

    expect(loadSingle).toHaveBeenCalledTimes(1);
    expect(loadSingle).toHaveBeenCalledWith(PLUGIN_ID, {
      markErrorOnFailure: false,
    });
    expect(firstDrivers).toEqual([
      expect.objectContaining({
        pluginId: PLUGIN_ID,
        driverKey: "daytona",
      }),
    ]);
    expect(secondDrivers).toEqual(firstDrivers);
  });

  it("keeps request-time recovery failures process-local instead of marking shared plugin state errored", async () => {
    const plugin = createPlugin("ready");
    mockRegistry.list.mockResolvedValue([plugin]);
    const worker = createWorkerManager();
    const loadSingle = vi.fn(async () => ({
      plugin,
      success: false,
      registered: { worker: false, eventSubscriptions: 0, jobs: 0, webhooks: 0, tools: 0 },
      error: "local worker spawn failed",
    }));
    const startWorker = createManagedBundledPluginWorkerRecovery({
      managedBundledPluginKeys: [PLUGIN_KEY],
      workerManager: worker.workerManager,
      getLoader: () => ({ loadSingle }) as Pick<PluginLoader, "loadSingle">,
    });

    const drivers = await listReadyPluginEnvironmentDrivers({
      db: {} as never,
      workerManager: worker.workerManager,
      recoverMissingWorker: {
        pluginKeys: [PLUGIN_KEY],
        startWorker,
      },
    });

    expect(loadSingle).toHaveBeenCalledWith(PLUGIN_ID, {
      markErrorOnFailure: false,
    });
    expect(drivers).toEqual([]);
  });

  it("bounds slow managed bundled recovery attempts without serial waits", async () => {
    vi.useFakeTimers();
    try {
      const plugins = [
        createPlugin("ready"),
        createPlugin("ready", {
          id: "plugin-modal",
          pluginKey: "paperclip.modal-sandbox-provider",
        }),
      ];
      mockRegistry.list.mockResolvedValue(plugins);
      const worker = createWorkerManager();
      const startWorker = vi.fn(() => new Promise<boolean>(() => {}));

      const driversPromise = listReadyPluginEnvironmentDrivers({
        db: {} as never,
        workerManager: worker.workerManager,
        recoverMissingWorker: {
          pluginKeys: [PLUGIN_KEY, "paperclip.modal-sandbox-provider"],
          startWorker,
          timeoutMs: 25,
        },
      });
      await Promise.resolve();

      expect(startWorker).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(25);

      await expect(driversPromise).resolves.toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
