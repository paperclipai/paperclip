import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

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

vi.mock("../middleware/logger.js", () => {
  const mockLogger: Record<string, unknown> = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(() => mockLogger),
  };
  return { logger: mockLogger, httpLogger: vi.fn() };
});

import { logger } from "../middleware/logger.js";
import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";
import { runDetachedWithPluginReloadLock, runWithPluginReloadLock } from "../services/plugin-reload-lock.js";
import type { PluginLoader } from "../services/plugin-loader.js";
import {
  createPluginWorkerManager,
  type PluginWorkerManager,
  type WorkerStartOptions,
} from "../services/plugin-worker-manager.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const DELAYED_WORKER_ENTRYPOINT = path.join(FIXTURES_DIR, "plugin-worker-delayed.cjs");

const MANIFEST: PaperclipPluginManifestV1 = {
  id: "test.plugin",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Test plugin",
  description: "Test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [],
  entrypoints: { worker: "dist/worker.js" },
};

const WORKER_OPTIONS: WorkerStartOptions = {
  entrypointPath: DELAYED_WORKER_ENTRYPOINT,
  manifest: MANIFEST,
  config: {},
  instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
  apiVersion: 1,
  hostHandlers: {},
};

function pluginRecord(id: string, status = "ready") {
  return {
    id,
    pluginKey: `key.${id}`,
    status,
    manifestJson: MANIFEST,
    packageName: "@example/plugin",
    version: "1.0.0",
    packagePath: "/tmp/example-plugin",
  };
}

function useRegistry(status = "ready") {
  mockRegistry.getById.mockImplementation(async (id: string) => pluginRecord(id, status));
  mockRegistry.updateStatus.mockImplementation(async (id: string, patch: { status: string }) =>
    pluginRecord(id, patch.status));
}

function stateOnlyLoader(): PluginLoader {
  return {
    hasRuntimeServices: () => false,
    loadSingle: vi.fn(),
    unloadSingle: vi.fn(),
  } as unknown as PluginLoader;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

async function flush(times = 5) {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setImmediate(r));
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("plugin reload interleaving (dev watcher restart vs API upgrade)", () => {
  let manager: PluginWorkerManager | undefined;
  afterEach(async () => {
    await manager?.stopAll();
    manager = undefined;
  });

  it("an upgrade issued while a watcher restart is starting the worker ends with a running worker", async () => {
    useRegistry();
    manager = createPluginWorkerManager();
    const workerManager = manager;
    const pluginId = "plugin-race";
    await workerManager.startWorker(pluginId, WORKER_OPTIONS);

    const routeLoader = {
      hasRuntimeServices: () => true,
      unloadSingle: vi.fn(async (id: string) => {
        if (workerManager.isRunning(id)) await workerManager.stopWorker(id);
      }),
      upgradePlugin: vi.fn(async () => ({
        oldManifest: MANIFEST,
        newManifest: { ...MANIFEST, version: "1.0.1" },
        discovered: { version: "1.0.1" },
      })),
      loadSingle: vi.fn(async (id: string) => {
        try {
          await workerManager.startWorker(id, WORKER_OPTIONS);
          return { success: true, plugin: pluginRecord(id) };
        } catch (err) {
          return {
            success: false,
            plugin: pluginRecord(id),
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    } as unknown as PluginLoader;

    const watcherLifecycle = pluginLifecycleManager({} as never, {
      loader: stateOnlyLoader(),
      workerManager,
    });
    const routeLifecycle = pluginLifecycleManager({} as never, {
      loader: routeLoader,
      workerManager,
    });

    const handle = workerManager.getWorker(pluginId)!;
    const starting = new Promise<void>((resolve) => {
      handle.on("status", ({ status }) => { if (status === "starting") resolve(); });
    });

    const restart = watcherLifecycle.restartWorker(pluginId);
    await starting;
    expect(workerManager.getWorker(pluginId)?.status).toBe("starting");

    await expect(routeLifecycle.upgrade(pluginId)).resolves.toMatchObject({ status: "ready" });
    await expect(restart).resolves.toBeUndefined();
    expect(workerManager.isRunning(pluginId)).toBe(true);
  }, 20_000);
});

describe("per-plugin reload lock", () => {
  function controllableWorkerManager() {
    const restarts = new Map<string, Array<ReturnType<typeof deferred>>>();
    const restartCalls: string[] = [];
    const handleFor = (pluginId: string) => ({
      restart: vi.fn(() => {
        restartCalls.push(pluginId);
        const gate = deferred();
        restarts.set(pluginId, [...(restarts.get(pluginId) ?? []), gate]);
        return gate.promise;
      }),
    });
    const handles = new Map<string, ReturnType<typeof handleFor>>();
    const workerManager = {
      getWorker: vi.fn((pluginId: string) => {
        if (!handles.has(pluginId)) handles.set(pluginId, handleFor(pluginId));
        return handles.get(pluginId);
      }),
      isRunning: vi.fn().mockReturnValue(true),
      stopWorker: vi.fn(),
      startWorker: vi.fn(),
    } as unknown as PluginWorkerManager;
    return {
      workerManager,
      restartCalls,
      release(pluginId: string, index: number) {
        restarts.get(pluginId)![index]!.resolve();
      },
    };
  }

  it("runs two reloads of the same plugin one after the other, across lifecycle instances", async () => {
    useRegistry();
    const { workerManager, restartCalls, release } = controllableWorkerManager();
    const watcherLifecycle = pluginLifecycleManager({} as never, { loader: stateOnlyLoader(), workerManager });
    const routeLifecycle = pluginLifecycleManager({} as never, { loader: stateOnlyLoader(), workerManager });

    let firstDone = false;
    let secondDone = false;
    const first = watcherLifecycle.restartWorker("plugin-a").then(() => { firstDone = true; });
    const second = routeLifecycle.restartWorker("plugin-a").then(() => { secondDone = true; });
    await flush();

    expect(restartCalls).toEqual(["plugin-a"]);
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      { pluginId: "plugin-a", operation: "restartWorker" },
      "plugin lifecycle: waiting for another reload of this plugin to finish",
    );

    release("plugin-a", 0);
    await flush();
    expect(firstDone).toBe(true);
    expect(secondDone).toBe(false);
    expect(restartCalls).toEqual(["plugin-a", "plugin-a"]);

    release("plugin-a", 1);
    await Promise.all([first, second]);
    expect(secondDone).toBe(true);
  });

  it("does not make a reload of one plugin wait for another plugin", async () => {
    useRegistry();
    const { workerManager, restartCalls, release } = controllableWorkerManager();
    const lifecycle = pluginLifecycleManager({} as never, { loader: stateOnlyLoader(), workerManager });

    const slow = lifecycle.restartWorker("plugin-a");
    const fast = lifecycle.restartWorker("plugin-b");
    await flush();
    expect(restartCalls).toEqual(["plugin-a", "plugin-b"]);

    release("plugin-b", 0);
    await expect(fast).resolves.toBeUndefined();
    expect(vi.mocked(logger.info)).not.toHaveBeenCalledWith(
      expect.anything(),
      "plugin lifecycle: waiting for another reload of this plugin to finish",
    );

    release("plugin-a", 0);
    await expect(slow).resolves.toBeUndefined();
  });

  it("releases the lock when a reload fails, so a queued reload still runs", async () => {
    useRegistry();
    const { workerManager, restartCalls, release } = controllableWorkerManager();
    const lifecycle = pluginLifecycleManager({} as never, { loader: stateOnlyLoader(), workerManager });
    vi.mocked(workerManager.getWorker).mockReturnValueOnce(undefined);

    const failing = lifecycle.restartWorker("plugin-a");
    const queued = lifecycle.restartWorker("plugin-a");
    await expect(failing).rejects.toThrow("no worker is running");
    await flush();
    expect(restartCalls).toEqual(["plugin-a"]);

    release("plugin-a", 0);
    await expect(queued).resolves.toBeUndefined();
  });

  it("lets a loader re-enter the lifecycle for the same plugin without deadlocking", async () => {
    useRegistry("error");
    const workerManager = { getWorker: vi.fn(), isRunning: vi.fn().mockReturnValue(false) } as unknown as PluginWorkerManager;
    const appLifecycle = pluginLifecycleManager({} as never, { loader: stateOnlyLoader(), workerManager });
    const routeLoader = {
      hasRuntimeServices: () => true,
      unloadSingle: vi.fn(),
      loadSingle: vi.fn(async (id: string) => {
        await appLifecycle.load(id);
        return { success: true, plugin: pluginRecord(id) };
      }),
    } as unknown as PluginLoader;
    const routeLifecycle = pluginLifecycleManager({} as never, { loader: routeLoader, workerManager });

    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error("deadlocked")), 2_000);
    });
    try {
      await expect(Promise.race([routeLifecycle.enable("plugin-a"), timeout])).resolves.toMatchObject({
        status: "ready",
      });
    } finally {
      clearTimeout(deadline);
    }
    expect(routeLoader.loadSingle).toHaveBeenCalledWith("plugin-a");
  });
});

describe("reload lock held by work that outlives or never awaits its caller", () => {
  it("treats a timer created under a lock as a normal caller once that holder has released", async () => {
    const owner = {};
    const fired = deferred();
    let timerRun: Promise<string> | undefined;
    await runWithPluginReloadLock(owner, "plugin-a", async () => {
      setTimeout(() => {
        timerRun = runWithPluginReloadLock(owner, "plugin-a", async () => "timer");
        fired.resolve();
      }, 20);
    });
    const gate = deferred();
    const nextHolder = runWithPluginReloadLock(owner, "plugin-a", () => gate.promise);

    await fired.promise;
    let timerDone = false;
    void timerRun!.then(() => { timerDone = true; });
    await flush();
    expect(timerDone).toBe(false);

    gate.resolve();
    await nextHolder;
    await expect(timerRun).resolves.toBe("timer");
  });

  it("queues detached work behind the live holder that started it", async () => {
    const owner = {};
    const gate = deferred();
    let detached: Promise<string> | undefined;
    const holder = runWithPluginReloadLock(owner, "plugin-a", async () => {
      detached = runDetachedWithPluginReloadLock(owner, "plugin-a", async () => "detached");
      await gate.promise;
    });
    await flush();
    let detachedDone = false;
    void detached!.then(() => { detachedDone = true; });
    await flush();
    expect(detachedDone).toBe(false);

    gate.resolve();
    await holder;
    await expect(detached).resolves.toBe("detached");
  });
});
