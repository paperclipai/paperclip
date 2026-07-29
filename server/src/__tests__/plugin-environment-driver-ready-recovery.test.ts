import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createManagedBundledPluginWorkerRecovery } from "../app.js";
import { listReadyPluginEnvironmentDrivers } from "../services/plugin-environment-driver.js";
import { pluginLoader, type PluginLoader } from "../services/plugin-loader.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  listConfigs: vi.fn(),
  update: vi.fn(),
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
    mockRegistry.getById.mockReset();
    mockRegistry.list.mockReset();
    mockRegistry.listConfigs.mockReset();
    mockRegistry.update.mockReset();
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

  it("does not lazy-start managed bundled plugins without sandbox provider drivers", async () => {
    const plugin = {
      ...createPlugin("ready"),
      manifestJson: {
        ...manifest,
        capabilities: [],
        environmentDrivers: undefined,
      },
    };
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
        pluginKeys: [PLUGIN_KEY],
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

  it("discards the dead handle a failed recovery attempt leaves behind so later requests retry", async () => {
    const plugin = createPlugin("ready");
    mockRegistry.list.mockResolvedValue([plugin]);

    // Simulates the initialize-failure path: startWorker registers a handle,
    // the worker dies during initialize, and no restart is scheduled — the
    // crashed handle stays registered in the worker manager.
    let handle: { status: string } | undefined;
    let running = false;
    const stopWorker = vi.fn(async () => {
      handle = undefined;
    });
    const workerManager = {
      isRunning: vi.fn(() => running),
      getWorker: vi.fn(() => handle),
      stopWorker,
    } as unknown as PluginWorkerManager;

    const loadSingle = vi.fn<PluginLoader["loadSingle"]>()
      .mockImplementationOnce(async () => {
        handle = { status: "crashed" };
        throw new Error("Worker initialize failed");
      })
      .mockImplementationOnce(async () => {
        handle = { status: "running" };
        running = true;
        return { plugin, success: true } as never;
      });

    const startWorker = createManagedBundledPluginWorkerRecovery({
      managedBundledPluginKeys: [PLUGIN_KEY],
      workerManager,
      getLoader: () => ({ loadSingle }) as Pick<PluginLoader, "loadSingle">,
    });

    const firstDrivers = await listReadyPluginEnvironmentDrivers({
      db: {} as never,
      workerManager,
      recoverMissingWorker: {
        pluginKeys: [PLUGIN_KEY],
        startWorker,
      },
    });

    expect(firstDrivers).toEqual([]);
    expect(stopWorker).toHaveBeenCalledWith(PLUGIN_ID);
    expect(handle).toBeUndefined();

    const secondDrivers = await listReadyPluginEnvironmentDrivers({
      db: {} as never,
      workerManager,
      recoverMissingWorker: {
        pluginKeys: [PLUGIN_KEY],
        startWorker,
      },
    });

    expect(loadSingle).toHaveBeenCalledTimes(2);
    expect(secondDrivers).toEqual([
      expect.objectContaining({
        pluginId: PLUGIN_ID,
        driverKey: "daytona",
      }),
    ]);
  });

  it("lets callers suppress shared error-state writes on activation failure", async () => {
    const plugin = {
      ...createPlugin("ready"),
      packageName: "@paperclipai/missing-sandbox-provider",
      packagePath: null,
      version: "1.0.0",
    };
    mockRegistry.getById.mockResolvedValue(plugin);
    const lifecycleManager = {
      markError: vi.fn().mockResolvedValue(undefined),
    };
    const loader = pluginLoader(
      {} as never,
      {
        enableLocalFilesystem: false,
        enableNpmDiscovery: false,
        localPluginDir: "__missing_plugin_dir__",
      },
      {
        lifecycleManager,
        workerManager: {},
        eventBus: {},
        jobScheduler: {},
        jobStore: {},
        toolDispatcher: {},
        buildHostHandlers: vi.fn(),
        instanceInfo: {
          instanceId: "test",
          hostVersion: "0.0.0",
        },
      } as never,
    );

    await expect(loader.loadSingle(PLUGIN_ID)).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("Package root not found"),
    });
    expect(lifecycleManager.markError).toHaveBeenCalledTimes(1);

    lifecycleManager.markError.mockClear();
    await expect(loader.loadSingle(PLUGIN_ID, { markErrorOnFailure: false })).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("Package root not found"),
    });
    expect(lifecycleManager.markError).not.toHaveBeenCalled();
  });

  it("tears down partially-activated runtime state when error writes are suppressed", async () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-recovery-fixture-"));
    try {
      fs.writeFileSync(
        path.join(fixtureDir, "package.json"),
        JSON.stringify({
          name: "@paperclipai/daytona-sandbox-provider",
          version: "1.0.0",
          paperclipPlugin: { manifest: "manifest.mjs" },
        }),
      );
      fs.writeFileSync(
        path.join(fixtureDir, "manifest.mjs"),
        `export default ${JSON.stringify(manifest)};`,
      );
      fs.mkdirSync(path.join(fixtureDir, "dist"));
      fs.writeFileSync(path.join(fixtureDir, "dist", "worker.js"), "");

      const plugin = {
        ...createPlugin("ready"),
        packageName: "@paperclipai/daytona-sandbox-provider",
        packagePath: fixtureDir,
        version: "1.0.0",
      };
      mockRegistry.getById.mockResolvedValue(plugin);
      mockRegistry.listConfigs.mockResolvedValue([]);
      mockRegistry.update.mockResolvedValue(undefined);

      const lifecycleManager = { markError: vi.fn().mockResolvedValue(undefined) };
      const workerManager = {
        startWorker: vi.fn().mockResolvedValue(undefined),
        isRunning: vi.fn(() => true),
        stopWorker: vi.fn().mockResolvedValue(undefined),
      };
      const eventBus = {
        forPlugin: vi.fn(() => {
          throw new Error("event bus offline");
        }),
        clearPlugin: vi.fn(),
        subscriptionCount: vi.fn(() => 0),
      };
      const jobScheduler = { unregisterPlugin: vi.fn().mockResolvedValue(undefined) };
      const toolDispatcher = { unregisterPluginTools: vi.fn(), registerPluginTools: vi.fn() };

      const loader = pluginLoader(
        {} as never,
        {
          enableLocalFilesystem: false,
          enableNpmDiscovery: false,
          localPluginDir: "__missing_plugin_dir__",
        },
        {
          lifecycleManager,
          workerManager,
          eventBus,
          jobScheduler,
          jobStore: {},
          toolDispatcher,
          buildHostHandlers: vi.fn(() => ({})),
          instanceInfo: {
            instanceId: "test",
            hostVersion: "0.0.0",
          },
        } as never,
      );

      await expect(loader.loadSingle(PLUGIN_ID, { markErrorOnFailure: false })).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining("event bus offline"),
      });

      expect(lifecycleManager.markError).not.toHaveBeenCalled();
      expect(jobScheduler.unregisterPlugin).toHaveBeenCalledWith(PLUGIN_ID);
      expect(eventBus.clearPlugin).toHaveBeenCalledWith(PLUGIN_KEY);
      expect(toolDispatcher.unregisterPluginTools).toHaveBeenCalledWith(PLUGIN_KEY);
      expect(workerManager.stopWorker).toHaveBeenCalledWith(PLUGIN_ID);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
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
