import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

const registryMock = vi.hoisted(() => ({ updateStatusIf: vi.fn(async () => null) }));

vi.mock("../services/plugin-registry.js", () => ({ pluginRegistryService: () => registryMock }));

vi.mock("../middleware/logger.js", () => {
  const mockLogger: Record<string, unknown> = {
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
    child: vi.fn(() => mockLogger),
  };
  return { logger: mockLogger, httpLogger: vi.fn() };
});

import { PLUGIN_ACTIVATION_TIMEOUT_ERROR_PREFIX, pluginLoader, type PluginRuntimeServices } from "../services/plugin-loader.js";
import { runWithPluginReloadLock } from "../services/plugin-reload-lock.js";
import {
  createPluginWorkerManager,
  type PluginWorkerManager,
  type WorkerStartOptions,
} from "../services/plugin-worker-manager.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const DELAYED_WORKER_ENTRYPOINT = path.join(FIXTURES_DIR, "plugin-worker-delayed.cjs");
const PLUGIN_ID = "plugin-teardown";
const PLUGIN_KEY = "test.plugin";
const BACKOFF_MS = 300;

const MANIFEST: PaperclipPluginManifestV1 = {
  id: PLUGIN_KEY,
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Test plugin",
  description: "Test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [],
  entrypoints: { worker: "dist/worker.js" },
};

function workerOptions(autoRestart: boolean): WorkerStartOptions {
  return {
    entrypointPath: DELAYED_WORKER_ENTRYPOINT,
    manifest: MANIFEST,
    config: {},
    instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
    apiVersion: 1,
    hostHandlers: {},
    autoRestart,
    crashRecovery: { minBackoffMs: BACKOFF_MS },
  };
}

function loaderFor(workerManager: PluginWorkerManager) {
  const services = {
    workerManager,
    lifecycleManager: { markError: vi.fn() },
    jobStore: { syncJobDeclarations: vi.fn() },
    jobScheduler: { registerPlugin: vi.fn(), unregisterPlugin: vi.fn(), stop: vi.fn() },
    toolDispatcher: { unregisterPluginTools: vi.fn() },
    eventBus: { forPlugin: vi.fn(), subscriptionCount: vi.fn(() => 0), clearPlugin: vi.fn() },
    buildHostHandlers: vi.fn(() => ({})),
    instanceInfo: { instanceId: "fixture", hostVersion: "1.0.0" },
  } as unknown as PluginRuntimeServices;
  return pluginLoader({} as unknown as Db, { enableLocalFilesystem: false, enableNpmDiscovery: false }, services);
}

describe("loader teardown of a worker handle that is not running", () => {
  let manager: PluginWorkerManager | undefined;
  afterEach(async () => {
    await manager?.stopAll();
    manager = undefined;
  });

  it.each([
    { state: "backoff", autoRestart: true },
    { state: "crashed", autoRestart: false },
  ] as const)("removes a $state handle and no restart brings a worker back", async ({ state, autoRestart }) => {
    manager = createPluginWorkerManager();
    await manager.startWorker(PLUGIN_ID, workerOptions(autoRestart));
    const handle = manager.getWorker(PLUGIN_ID)!;
    const reached = new Promise<void>((resolve) => {
      handle.on("status", ({ status }) => { if (status === state) resolve(); });
    });
    process.kill(handle.diagnostics().pid!, "SIGKILL");
    await reached;
    expect(handle.status).toBe(state);

    const statusesAfterTeardown: string[] = [];
    await loaderFor(manager).unloadSingle(PLUGIN_ID, PLUGIN_KEY);
    handle.on("status", ({ status }) => { statusesAfterTeardown.push(status); });

    expect(manager.getWorker(PLUGIN_ID)).toBeUndefined();
    expect(handle.status).toBe("stopped");
    expect(handle.diagnostics().nextRestartAt).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS * 3));
    expect(statusesAfterTeardown).toEqual([]);
    expect(handle.status).toBe("stopped");
    expect(handle.diagnostics().pid).toBeNull();
    expect(manager.getWorker(PLUGIN_ID)).toBeUndefined();
  }, 20_000);
});

describe("on-demand activation recovery and the per-plugin reload lock", () => {
  it("starts only after a held reload of the same plugin finishes, without blocking other plugins", async () => {
    registryMock.updateStatusIf.mockClear();
    const manager = createPluginWorkerManager();
    const loader = loaderFor(manager);
    let releaseReload!: () => void;
    const reloadGate = new Promise<void>((resolve) => { releaseReload = resolve; });
    let reloadHolding!: () => void;
    const holding = new Promise<void>((resolve) => { reloadHolding = resolve; });
    const reload = runWithPluginReloadLock(manager, PLUGIN_ID, async () => {
      reloadHolding();
      await reloadGate;
    });
    await holding;

    const accepted = loader.requestActivationTimeoutRecovery({
      id: PLUGIN_ID,
      status: "error",
      lastError: `${PLUGIN_ACTIVATION_TIMEOUT_ERROR_PREFIX} after 2 retries`,
    });
    expect(accepted).toBe(true);
    await expect(runWithPluginReloadLock(manager, "another-plugin", async () => "ran")).resolves.toBe("ran");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(registryMock.updateStatusIf).not.toHaveBeenCalled();

    releaseReload();
    await reload;
    await vi.waitFor(() => expect(registryMock.updateStatusIf).toHaveBeenCalledOnce());
    await loader.stopActivationTimeoutRecovery();
  });
});
