import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PluginRecord, PluginStatus } from "@paperclipai/shared";
import { isDisabledByOperator } from "../services/plugin-lifecycle.js";
import type { PluginWorkerManager, PluginWorkerHandle, WorkerStartOptions } from "../services/plugin-worker-manager.js";

// ---------------------------------------------------------------------------
// Mock the registry and logger before any imports that use them
// ---------------------------------------------------------------------------

const mockRegistry = {
  list: vi.fn(),
  listByStatus: vi.fn(),
  getById: vi.fn(),
  getByKey: vi.fn(),
  install: vi.fn(),
  update: vi.fn(),
  updateStatus: vi.fn(),
  uninstall: vi.fn(),
  getConfig: vi.fn(),
  upsertConfig: vi.fn(),
  patchConfig: vi.fn(),
  setConfigError: vi.fn(),
  deleteConfig: vi.fn(),
};

const mockLoader = {
  discoverAll: vi.fn(),
  discoverFromLocalFilesystem: vi.fn(),
  discoverFromNpm: vi.fn(),
  loadManifest: vi.fn(),
  installPlugin: vi.fn(),
  upgradePlugin: vi.fn(),
  isSupportedApiVersion: vi.fn(),
  getLocalPluginDir: vi.fn(),
};

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

vi.mock("../services/plugin-loader.js", () => ({
  pluginLoader: () => mockLoader,
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

// Must import after mocks are set up
const { pluginLifecycleManager } = await import("../services/plugin-lifecycle.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlugin(overrides: Partial<PluginRecord> = {}): PluginRecord {
  return {
    id: "plugin-uuid-1",
    pluginKey: "acme.test-plugin",
    packageName: "@acme/test-plugin",
    version: "1.0.0",
    apiVersion: 1,
    categories: ["connector"],
    manifestJson: {
      id: "acme.test-plugin",
      apiVersion: 1,
      version: "1.0.0",
      displayName: "Test Plugin",
      description: "A test plugin",
      categories: ["connector"],
      capabilities: ["issues.read"],
      entrypoints: { worker: "worker.js" },
    },
    status: "installed" as PluginStatus,
    installOrder: 1,
    lastError: null,
    installedAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pluginLifecycleManager", () => {
  const db = {} as any; // DB is not used directly; the registry mock handles it
  let lifecycle: ReturnType<typeof pluginLifecycleManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    lifecycle = pluginLifecycleManager(db);
  });

  // =========================================================================
  // load
  // =========================================================================

  describe("load", () => {
    it("transitions installed → ready", async () => {
      const plugin = makePlugin({ status: "installed" });
      const readyPlugin = { ...plugin, status: "ready" as PluginStatus };

      mockRegistry.getById.mockResolvedValue(plugin);
      mockRegistry.updateStatus.mockResolvedValue(readyPlugin);

      const result = await lifecycle.load(plugin.id);
      expect(result.status).toBe("ready");
      expect(mockRegistry.updateStatus).toHaveBeenCalledWith(plugin.id, {
        status: "ready",
        lastError: null,
      });
    });

    it("emits plugin.loaded and plugin.enabled events", async () => {
      const plugin = makePlugin({ status: "installed" });
      const readyPlugin = { ...plugin, status: "ready" as PluginStatus };
      mockRegistry.getById.mockResolvedValue(plugin);
      mockRegistry.updateStatus.mockResolvedValue(readyPlugin);

      const loadedEvents: unknown[] = [];
      const enabledEvents: unknown[] = [];
      lifecycle.on("plugin.loaded", (e) => loadedEvents.push(e));
      lifecycle.on("plugin.enabled", (e) => enabledEvents.push(e));

      await lifecycle.load(plugin.id);

      expect(loadedEvents).toHaveLength(1);
      expect(enabledEvents).toHaveLength(1);
    });

    it("allows transition (ready → ready) for idempotency/upgrades", async () => {
      const plugin = makePlugin({ status: "ready" });
      const readyPlugin = { ...plugin };
      mockRegistry.getById.mockResolvedValue(plugin);
      mockRegistry.updateStatus.mockResolvedValue(readyPlugin);

      const result = await lifecycle.load(plugin.id);
      expect(result.status).toBe("ready");
    });

    it("throws 404 for non-existent plugin", async () => {
      mockRegistry.getById.mockResolvedValue(null);

      await expect(lifecycle.load("nonexistent")).rejects.toThrow(/not found/i);
    });
  });

  // =========================================================================
  // enable
  // =========================================================================

  describe("enable", () => {
    it("transitions error → ready", async () => {
      const plugin = makePlugin({ status: "error", lastError: "worker crashed" });
      const readyPlugin = { ...plugin, status: "ready" as PluginStatus, lastError: null };

      mockRegistry.getById.mockResolvedValue(plugin);
      mockRegistry.updateStatus.mockResolvedValue(readyPlugin);

      const result = await lifecycle.enable(plugin.id);
      expect(result.status).toBe("ready");
    });

    it("transitions upgrade_pending → ready", async () => {
      const plugin = makePlugin({ status: "upgrade_pending" });
      const readyPlugin = { ...plugin, status: "ready" as PluginStatus };

      mockRegistry.getById.mockResolvedValue(plugin);
      mockRegistry.updateStatus.mockResolvedValue(readyPlugin);

      const result = await lifecycle.enable(plugin.id);
      expect(result.status).toBe("ready");
    });

    it("rejects enabling from installed status", async () => {
      const plugin = makePlugin({ status: "installed" });
      mockRegistry.getById.mockResolvedValue(plugin);

      await expect(lifecycle.enable(plugin.id)).rejects.toThrow(
        /Cannot enable plugin in status 'installed'/,
      );
    });

    it("rejects enabling from ready status", async () => {
      const plugin = makePlugin({ status: "ready" });
      mockRegistry.getById.mockResolvedValue(plugin);

      await expect(lifecycle.enable(plugin.id)).rejects.toThrow(
        /Cannot enable plugin in status 'ready'/,
      );
    });

    it("emits plugin.enabled event", async () => {
      const plugin = makePlugin({ status: "error" });
      const readyPlugin = { ...plugin, status: "ready" as PluginStatus };
      mockRegistry.getById.mockResolvedValue(plugin);
      mockRegistry.updateStatus.mockResolvedValue(readyPlugin);

      const events: unknown[] = [];
      lifecycle.on("plugin.enabled", (e) => events.push(e));

      await lifecycle.enable(plugin.id);
      expect(events).toHaveLength(1);
    });

    it("does not double-fetch the plugin (passes existing to transition)", async () => {
      const plugin = makePlugin({ status: "error" });
      const readyPlugin = { ...plugin, status: "ready" as PluginStatus };

      mockRegistry.getById.mockResolvedValue(plugin);
      mockRegistry.updateStatus.mockResolvedValue(readyPlugin);

      await lifecycle.enable(plugin.id);

      // getById should only be called once (by enable's requirePlugin),
      // not a second time by transition's requirePlugin
      expect(mockRegistry.getById).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // disable
  // =========================================================================

  describe("disable", () => {
    it("transitions ready → error with disabled sentinel", async () => {
      const plugin = makePlugin({ status: "ready" });
      const errorPlugin = {
        ...plugin,
        status: "error" as PluginStatus,
        lastError: "disabled_by_operator",
      };

      mockRegistry.getById.mockResolvedValue(plugin);
      mockRegistry.updateStatus.mockResolvedValue(errorPlugin);

      const result = await lifecycle.disable(plugin.id);
      expect(result.status).toBe("error");
      expect(mockRegistry.updateStatus).toHaveBeenCalledWith(plugin.id, {
        status: "error",
        lastError: "disabled_by_operator",
      });
    });

    it("includes reason in the disabled sentinel", async () => {
      const plugin = makePlugin({ status: "ready" });
      const errorPlugin = {
        ...plugin,
        status: "error" as PluginStatus,
        lastError: "disabled_by_operator: maintenance window",
      };

      mockRegistry.getById.mockResolvedValue(plugin);
      mockRegistry.updateStatus.mockResolvedValue(errorPlugin);

      await lifecycle.disable(plugin.id, "maintenance window");

      expect(mockRegistry.updateStatus).toHaveBeenCalledWith(plugin.id, {
        status: "error",
        lastError: "disabled_by_operator: maintenance window",
      });
    });

    it("rejects disabling from non-ready status", async () => {
      const plugin = makePlugin({ status: "installed" });
      mockRegistry.getById.mockResolvedValue(plugin);

      await expect(lifecycle.disable(plugin.id)).rejects.toThrow(
        /Cannot disable plugin in status 'installed'/,
      );
    });

    it("emits plugin.disabled event with reason", async () => {
      const plugin = makePlugin({ status: "ready" });
      const errorPlugin = { ...plugin, status: "error" as PluginStatus };
      mockRegistry.getById.mockResolvedValue(plugin);
      mockRegistry.updateStatus.mockResolvedValue(errorPlugin);

      const events: any[] = [];
      lifecycle.on("plugin.disabled", (e) => events.push(e));

      await lifecycle.disable(plugin.id, "testing");
      expect(events).toHaveLength(1);
      expect(events[0].reason).toBe("testing");
    });

    it("does not double-fetch the plugin", async () => {
      const plugin = makePlugin({ status: "ready" });
      const errorPlugin = { ...plugin, status: "error" as PluginStatus };
      mockRegistry.getById.mockResolvedValue(plugin);
      mockRegistry.updateStatus.mockResolvedValue(errorPlugin);

      await lifecycle.disable(plugin.id);
      expect(mockRegistry.getById).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // unload
  // =========================================================================

  describe("unload", () => {
    it("soft-unloads from ready state", async () => {
      const plugin = makePlugin({ status: "ready" });
      const uninstalledPlugin = { ...plugin, status: "uninstalled" as PluginStatus };

      mockRegistry.getById.mockResolvedValue(plugin);
      mockRegistry.uninstall.mockResolvedValue(uninstalledPlugin);

      const result = await lifecycle.unload(plugin.id);
      expect(result?.status).toBe("uninstalled");
      expect(mockRegistry.uninstall).toHaveBeenCalledWith(plugin.id, false);
    });

    it("hard-deletes when removeData is true", async () => {
      const plugin = makePlugin({ status: "ready" });
      mockRegistry.getById.mockResolvedValue(plugin);
      mockRegistry.uninstall.mockResolvedValue(plugin);

      await lifecycle.unload(plugin.id, true);
      expect(mockRegistry.uninstall).toHaveBeenCalledWith(plugin.id, true);
    });

    it("hard-deletes an already-uninstalled plugin when removeData is true", async () => {
      const plugin = makePlugin({ status: "uninstalled" });
      mockRegistry.getById.mockResolvedValue(plugin);
      mockRegistry.uninstall.mockResolvedValue(null);

      await lifecycle.unload(plugin.id, true);
      expect(mockRegistry.uninstall).toHaveBeenCalledWith(plugin.id, true);
    });

    it("rejects unloading an already-uninstalled plugin without removeData", async () => {
      const plugin = makePlugin({ status: "uninstalled" });
      mockRegistry.getById.mockResolvedValue(plugin);

      await expect(lifecycle.unload(plugin.id)).rejects.toThrow(/already uninstalled/);
    });

    it("emits plugin.unloaded and plugin.status_changed events", async () => {
      const plugin = makePlugin({ status: "ready" });
      const uninstalledPlugin = { ...plugin, status: "uninstalled" as PluginStatus };
      mockRegistry.getById.mockResolvedValue(plugin);
      mockRegistry.uninstall.mockResolvedValue(uninstalledPlugin);

      const unloadedEvents: any[] = [];
      const statusChangedEvents: any[] = [];
      lifecycle.on("plugin.unloaded", (e) => unloadedEvents.push(e));
      lifecycle.on("plugin.status_changed", (e) => statusChangedEvents.push(e));

      await lifecycle.unload(plugin.id);

      expect(unloadedEvents).toHaveLength(1);
      expect(unloadedEvents[0].removeData).toBe(false);
      expect(statusChangedEvents).toHaveLength(1);
      expect(statusChangedEvents[0].previousStatus).toBe("ready");
      expect(statusChangedEvents[0].newStatus).toBe("uninstalled");
    });

    it("can unload from error state", async () => {
      const plugin = makePlugin({ status: "error" });
      const uninstalledPlugin = { ...plugin, status: "uninstalled" as PluginStatus };
      mockRegistry.getById.mockResolvedValue(plugin);
      mockRegistry.uninstall.mockResolvedValue(uninstalledPlugin);

      const result = await lifecycle.unload(plugin.id);
      expect(result?.status).toBe("uninstalled");
    });

    it("can unload from upgrade_pending state", async () => {
      const plugin = makePlugin({ status: "upgrade_pending" });
      const uninstalledPlugin = { ...plugin, status: "uninstalled" as PluginStatus };
      mockRegistry.getById.mockResolvedValue(plugin);
      mockRegistry.uninstall.mockResolvedValue(uninstalledPlugin);

      const result = await lifecycle.unload(plugin.id);
      expect(result?.status).toBe("uninstalled");
    });
  });

  // =========================================================================
  // markError
  // =========================================================================

  describe("markError", () => {
    it("transitions ready → error with error message", async () => {
      const plugin = makePlugin({ status: "ready" });
      const errorPlugin = {
        ...plugin,
        status: "error" as PluginStatus,
        lastError: "worker crashed",
      };

      mockRegistry.getById.mockResolvedValue(plugin);
      mockRegistry.updateStatus.mockResolvedValue(errorPlugin);

      const result = await lifecycle.markError(plugin.id, "worker crashed");
      expect(result.status).toBe("error");
      expect(mockRegistry.updateStatus).toHaveBeenCalledWith(plugin.id, {
        status: "error",
        lastError: "worker crashed",
      });
    });

    it("transitions installed → error", async () => {
      const plugin = makePlugin({ status: "installed" });
      const errorPlugin = { ...plugin, status: "error" as PluginStatus };
      mockRegistry.getById.mockResolvedValue(plugin);
      mockRegistry.updateStatus.mockResolvedValue(errorPlugin);

      const result = await lifecycle.markError(plugin.id, "init failure");
      expect(result.status).toBe("error");
    });

    it("emits plugin.error event", async () => {
      const plugin = makePlugin({ status: "ready" });
      const errorPlugin = { ...plugin, status: "error" as PluginStatus };
      mockRegistry.getById.mockResolvedValue(plugin);
      mockRegistry.updateStatus.mockResolvedValue(errorPlugin);

      const events: any[] = [];
      lifecycle.on("plugin.error", (e) => events.push(e));

      await lifecycle.markError(plugin.id, "failure");
      expect(events).toHaveLength(1);
      expect(events[0].error).toBe("failure");
    });

    it("rejects invalid transition (uninstalled → error)", async () => {
      const plugin = makePlugin({ status: "uninstalled" });
      mockRegistry.getById.mockResolvedValue(plugin);

      await expect(lifecycle.markError(plugin.id, "fail")).rejects.toThrow(
        /Invalid lifecycle transition/,
      );
    });
  });

  // =========================================================================
  // markUpgradePending
  // =========================================================================

  describe("markUpgradePending", () => {
    it("transitions ready → upgrade_pending", async () => {
      const plugin = makePlugin({ status: "ready" });
      const pendingPlugin = { ...plugin, status: "upgrade_pending" as PluginStatus };

      mockRegistry.getById.mockResolvedValue(plugin);
      mockRegistry.updateStatus.mockResolvedValue(pendingPlugin);

      const result = await lifecycle.markUpgradePending(plugin.id);
      expect(result.status).toBe("upgrade_pending");
    });

    it("emits plugin.upgrade_pending event", async () => {
      const plugin = makePlugin({ status: "ready" });
      const pendingPlugin = { ...plugin, status: "upgrade_pending" as PluginStatus };
      mockRegistry.getById.mockResolvedValue(plugin);
      mockRegistry.updateStatus.mockResolvedValue(pendingPlugin);

      const events: unknown[] = [];
      lifecycle.on("plugin.upgrade_pending", (e) => events.push(e));

      await lifecycle.markUpgradePending(plugin.id);
      expect(events).toHaveLength(1);
    });

    it("rejects invalid transition (installed → upgrade_pending)", async () => {
      const plugin = makePlugin({ status: "installed" });
      mockRegistry.getById.mockResolvedValue(plugin);

      await expect(lifecycle.markUpgradePending(plugin.id)).rejects.toThrow(
        /Invalid lifecycle transition/,
      );
    });
  });

  // =========================================================================
  // upgrade
  // =========================================================================

  describe("upgrade", () => {
    it("transitions directly to ready when no new capabilities", async () => {
      const plugin = makePlugin({ status: "ready" });
      const newManifest = { ...plugin.manifestJson, version: "1.1.0" };
      const readyPlugin = {
        ...plugin,
        version: "1.1.0",
        manifestJson: newManifest,
      };

      mockRegistry.getById.mockResolvedValue(plugin);
      mockLoader.upgradePlugin.mockResolvedValue({
        oldManifest: plugin.manifestJson,
        newManifest,
        discovered: { version: "1.1.0" },
      });
      mockRegistry.updateStatus.mockResolvedValue(readyPlugin);

      const result = await lifecycle.upgrade(plugin.id, "1.1.0");

      expect(result.status).toBe("ready");
      expect(result.version).toBe("1.1.0");
      expect(mockLoader.upgradePlugin).toHaveBeenCalledWith(plugin.id, {
        version: "1.1.0",
      });
    });

    it("transitions to upgrade_pending when new capabilities are added", async () => {
      const plugin = makePlugin({ status: "ready" });
      const newManifest = {
        ...plugin.manifestJson,
        version: "1.1.0",
        capabilities: ["issues.read", "issues.create"], // Added issues.create
      };
      const pendingPlugin = {
        ...plugin,
        status: "upgrade_pending" as PluginStatus,
        version: "1.1.0",
        manifestJson: newManifest,
      };

      mockRegistry.getById.mockResolvedValue(plugin);
      mockLoader.upgradePlugin.mockResolvedValue({
        oldManifest: plugin.manifestJson,
        newManifest,
        discovered: { version: "1.1.0" },
      });
      mockRegistry.updateStatus.mockResolvedValue(pendingPlugin);

      const result = await lifecycle.upgrade(plugin.id, "1.1.0");

      expect(result.status).toBe("upgrade_pending");
    });

    it("rejects upgrade from installed status", async () => {
      const plugin = makePlugin({ status: "installed" });
      mockRegistry.getById.mockResolvedValue(plugin);

      await expect(lifecycle.upgrade(plugin.id)).rejects.toThrow(
        /Cannot upgrade plugin in status 'installed'/,
      );
    });
  });

  // =========================================================================
  // getStatus
  // =========================================================================

  describe("getStatus", () => {
    it("returns the plugin status", async () => {
      mockRegistry.getById.mockResolvedValue(makePlugin({ status: "ready" }));
      expect(await lifecycle.getStatus("plugin-uuid-1")).toBe("ready");
    });

    it("returns null for non-existent plugin", async () => {
      mockRegistry.getById.mockResolvedValue(null);
      expect(await lifecycle.getStatus("nonexistent")).toBeNull();
    });
  });

  // =========================================================================
  // canTransition
  // =========================================================================

  describe("canTransition", () => {
    it("returns true for valid transitions", async () => {
      mockRegistry.getById.mockResolvedValue(makePlugin({ status: "installed" }));
      expect(await lifecycle.canTransition("id", "ready")).toBe(true);
      expect(await lifecycle.canTransition("id", "error")).toBe(true);
    });

    it("returns false for invalid transitions", async () => {
      mockRegistry.getById.mockResolvedValue(makePlugin({ status: "installed" }));
      expect(await lifecycle.canTransition("id", "upgrade_pending")).toBe(false);
    });

    it("returns false for non-existent plugin", async () => {
      mockRegistry.getById.mockResolvedValue(null);
      expect(await lifecycle.canTransition("nonexistent", "ready")).toBe(false);
    });
  });

  // =========================================================================
  // Event subscription management
  // =========================================================================

  describe("event subscription", () => {
    it("once only fires once", async () => {
      const plugin = makePlugin({ status: "installed" });
      const readyPlugin = { ...plugin, status: "ready" as PluginStatus };

      mockRegistry.getById.mockResolvedValue(plugin);
      mockRegistry.updateStatus.mockResolvedValue(readyPlugin);

      let count = 0;
      lifecycle.once("plugin.status_changed", () => { count++; });

      await lifecycle.load(plugin.id);

      // Reset for second call
      const plugin2 = makePlugin({ status: "installed", id: "p2" });
      const readyPlugin2 = { ...plugin2, status: "ready" as PluginStatus };
      mockRegistry.getById.mockResolvedValue(plugin2);
      mockRegistry.updateStatus.mockResolvedValue(readyPlugin2);

      await lifecycle.load(plugin2.id);

      expect(count).toBe(1);
    });

    it("off removes listener", async () => {
      const plugin = makePlugin({ status: "installed" });
      const readyPlugin = { ...plugin, status: "ready" as PluginStatus };

      mockRegistry.getById.mockResolvedValue(plugin);
      mockRegistry.updateStatus.mockResolvedValue(readyPlugin);

      let count = 0;
      const listener = () => { count++; };
      lifecycle.on("plugin.status_changed", listener);
      lifecycle.off("plugin.status_changed", listener);

      await lifecycle.load(plugin.id);
      expect(count).toBe(0);
    });
  });
});

// ===========================================================================
// Worker manager integration tests
// ===========================================================================

function makeMockWorkerHandle(overrides: Partial<PluginWorkerHandle> = {}): PluginWorkerHandle {
  return {
    pluginId: "plugin-uuid-1",
    status: "running",
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    call: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    diagnostics: vi.fn().mockReturnValue({
      pluginId: "plugin-uuid-1",
      status: "running",
      pid: 12345,
      uptime: 1000,
      consecutiveCrashes: 0,
      totalCrashes: 0,
      pendingRequests: 0,
      lastCrashAt: null,
      nextRestartAt: null,
    }),
    ...overrides,
  } as unknown as PluginWorkerHandle;
}

function makeMockWorkerManager(
  overrides: Partial<PluginWorkerManager> = {},
): PluginWorkerManager {
  return {
    startWorker: vi.fn().mockResolvedValue(makeMockWorkerHandle()),
    stopWorker: vi.fn().mockResolvedValue(undefined),
    getWorker: vi.fn().mockReturnValue(undefined),
    isRunning: vi.fn().mockReturnValue(false),
    stopAll: vi.fn().mockResolvedValue(undefined),
    diagnostics: vi.fn().mockReturnValue([]),
    call: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as PluginWorkerManager;
}

describe("pluginLifecycleManager with workerManager", () => {
  const db = {} as any;
  let mockWM: PluginWorkerManager;
  let lifecycle: ReturnType<typeof pluginLifecycleManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWM = makeMockWorkerManager();
    lifecycle = pluginLifecycleManager(db, { workerManager: mockWM });
  });

  // =========================================================================
  // disable — stops worker before transitioning
  // =========================================================================

  describe("disable (with worker manager)", () => {
    it("stops the worker before transitioning to error", async () => {
      const plugin = makePlugin({ status: "ready" });
      const errorPlugin = { ...plugin, status: "error" as PluginStatus };

      (mockWM.isRunning as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (mockWM.getWorker as ReturnType<typeof vi.fn>).mockReturnValue(makeMockWorkerHandle());
      mockRegistry.getById.mockResolvedValue(plugin);
      mockRegistry.updateStatus.mockResolvedValue(errorPlugin);

      await lifecycle.disable(plugin.id);

      expect(mockWM.stopWorker).toHaveBeenCalledWith(plugin.id);
      expect(mockRegistry.updateStatus).toHaveBeenCalled();
    });

    it("emits plugin.worker_stopped event when worker was running", async () => {
      const plugin = makePlugin({ status: "ready" });
      const errorPlugin = { ...plugin, status: "error" as PluginStatus };

      (mockWM.isRunning as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (mockWM.getWorker as ReturnType<typeof vi.fn>).mockReturnValue(makeMockWorkerHandle());
      mockRegistry.getById.mockResolvedValue(plugin);
      mockRegistry.updateStatus.mockResolvedValue(errorPlugin);

      const workerStoppedEvents: any[] = [];
      lifecycle.on("plugin.worker_stopped", (e) => workerStoppedEvents.push(e));

      await lifecycle.disable(plugin.id);

      expect(workerStoppedEvents).toHaveLength(1);
      expect(workerStoppedEvents[0].pluginId).toBe(plugin.id);
    });

    it("succeeds even if worker stop fails (best-effort)", async () => {
      const plugin = makePlugin({ status: "ready" });
      const errorPlugin = { ...plugin, status: "error" as PluginStatus };

      (mockWM.isRunning as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (mockWM.getWorker as ReturnType<typeof vi.fn>).mockReturnValue(makeMockWorkerHandle());
      (mockWM.stopWorker as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("stop failed"));
      mockRegistry.getById.mockResolvedValue(plugin);
      mockRegistry.updateStatus.mockResolvedValue(errorPlugin);

      // Should not throw despite worker stop failing
      const result = await lifecycle.disable(plugin.id);
      expect(result.status).toBe("error");
    });
  });

  // =========================================================================
  // unload — stops worker before uninstalling
  // =========================================================================

  describe("unload (with worker manager)", () => {
    it("stops the worker before uninstalling", async () => {
      const plugin = makePlugin({ status: "ready" });
      const uninstalledPlugin = { ...plugin, status: "uninstalled" as PluginStatus };

      (mockWM.isRunning as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (mockWM.getWorker as ReturnType<typeof vi.fn>).mockReturnValue(makeMockWorkerHandle());
      mockRegistry.getById.mockResolvedValue(plugin);
      mockRegistry.uninstall.mockResolvedValue(uninstalledPlugin);

      await lifecycle.unload(plugin.id);

      expect(mockWM.stopWorker).toHaveBeenCalledWith(plugin.id);
    });

    it("does not attempt to stop worker for already-uninstalled plugin with removeData", async () => {
      const plugin = makePlugin({ status: "uninstalled" });
      mockRegistry.getById.mockResolvedValue(plugin);
      mockRegistry.uninstall.mockResolvedValue(null);

      await lifecycle.unload(plugin.id, true);

      expect(mockWM.stopWorker).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // markError — stops worker when marking error
  // =========================================================================

  describe("markError (with worker manager)", () => {
    it("stops the worker when marking plugin as errored", async () => {
      const plugin = makePlugin({ status: "ready" });
      const errorPlugin = { ...plugin, status: "error" as PluginStatus };

      (mockWM.isRunning as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (mockWM.getWorker as ReturnType<typeof vi.fn>).mockReturnValue(makeMockWorkerHandle());
      mockRegistry.getById.mockResolvedValue(plugin);
      mockRegistry.updateStatus.mockResolvedValue(errorPlugin);

      await lifecycle.markError(plugin.id, "worker crashed");

      expect(mockWM.stopWorker).toHaveBeenCalledWith(plugin.id);
    });

    it("does not call stopWorker when no worker is running", async () => {
      const plugin = makePlugin({ status: "installed" });
      const errorPlugin = { ...plugin, status: "error" as PluginStatus };

      (mockWM.isRunning as ReturnType<typeof vi.fn>).mockReturnValue(false);
      (mockWM.getWorker as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
      mockRegistry.getById.mockResolvedValue(plugin);
      mockRegistry.updateStatus.mockResolvedValue(errorPlugin);

      await lifecycle.markError(plugin.id, "init failure");

      expect(mockWM.stopWorker).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // markUpgradePending — stops worker while awaiting approval
  // =========================================================================

  describe("markUpgradePending (with worker manager)", () => {
    it("stops the worker when transitioning to upgrade_pending", async () => {
      const plugin = makePlugin({ status: "ready" });
      const pendingPlugin = { ...plugin, status: "upgrade_pending" as PluginStatus };

      (mockWM.isRunning as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (mockWM.getWorker as ReturnType<typeof vi.fn>).mockReturnValue(makeMockWorkerHandle());
      mockRegistry.getById.mockResolvedValue(plugin);
      mockRegistry.updateStatus.mockResolvedValue(pendingPlugin);

      await lifecycle.markUpgradePending(plugin.id);

      expect(mockWM.stopWorker).toHaveBeenCalledWith(plugin.id);
    });
  });

  // =========================================================================
  // upgrade — stops worker before package update
  // =========================================================================

  describe("upgrade (with worker manager)", () => {
    it("stops the worker before upgrading on disk", async () => {
      const plugin = makePlugin({ status: "ready" });
      const newManifest = { ...plugin.manifestJson, version: "1.1.0" };
      const readyPlugin = { ...plugin, version: "1.1.0", manifestJson: newManifest };

      (mockWM.isRunning as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (mockWM.getWorker as ReturnType<typeof vi.fn>).mockReturnValue(makeMockWorkerHandle());
      mockRegistry.getById.mockResolvedValue(plugin);
      mockLoader.upgradePlugin.mockResolvedValue({
        oldManifest: plugin.manifestJson,
        newManifest,
        discovered: { version: "1.1.0" },
      });
      mockRegistry.updateStatus.mockResolvedValue(readyPlugin);

      await lifecycle.upgrade(plugin.id, "1.1.0");

      expect(mockWM.stopWorker).toHaveBeenCalledWith(plugin.id);
    });
  });

  // =========================================================================
  // startWorker
  // =========================================================================

  describe("startWorker", () => {
    it("starts a worker for a ready plugin", async () => {
      const plugin = makePlugin({ status: "ready" });
      mockRegistry.getById.mockResolvedValue(plugin);

      const workerOptions = {
        entrypointPath: "/path/to/worker.cjs",
        manifest: plugin.manifestJson,
        config: {},
        instanceInfo: { instanceId: "inst-1", hostVersion: "1.0.0" },
        apiVersion: 1,
        hostHandlers: {},
      } as unknown as WorkerStartOptions;

      await lifecycle.startWorker(plugin.id, workerOptions);

      expect(mockWM.startWorker).toHaveBeenCalledWith(plugin.id, workerOptions);
    });

    it("emits plugin.worker_started event", async () => {
      const plugin = makePlugin({ status: "ready" });
      mockRegistry.getById.mockResolvedValue(plugin);

      const events: any[] = [];
      lifecycle.on("plugin.worker_started", (e) => events.push(e));

      const workerOptions = {
        entrypointPath: "/path/to/worker.cjs",
        manifest: plugin.manifestJson,
        config: {},
        instanceInfo: { instanceId: "inst-1", hostVersion: "1.0.0" },
        apiVersion: 1,
        hostHandlers: {},
      } as unknown as WorkerStartOptions;

      await lifecycle.startWorker(plugin.id, workerOptions);

      expect(events).toHaveLength(1);
      expect(events[0].pluginId).toBe(plugin.id);
    });

    it("rejects starting worker for non-ready plugin", async () => {
      const plugin = makePlugin({ status: "installed" });
      mockRegistry.getById.mockResolvedValue(plugin);

      const workerOptions = {
        entrypointPath: "/path/to/worker.cjs",
        manifest: plugin.manifestJson,
        config: {},
        instanceInfo: { instanceId: "inst-1", hostVersion: "1.0.0" },
        apiVersion: 1,
        hostHandlers: {},
      } as unknown as WorkerStartOptions;

      await expect(lifecycle.startWorker(plugin.id, workerOptions)).rejects.toThrow(
        /Plugin must be in 'ready' status/,
      );
    });
  });

  // =========================================================================
  // stopWorker
  // =========================================================================

  describe("stopWorker", () => {
    it("stops a running worker", async () => {
      const plugin = makePlugin({ status: "ready" });
      (mockWM.isRunning as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (mockWM.getWorker as ReturnType<typeof vi.fn>).mockReturnValue(makeMockWorkerHandle());
      mockRegistry.getById.mockResolvedValue(plugin);

      await lifecycle.stopWorker(plugin.id);

      expect(mockWM.stopWorker).toHaveBeenCalledWith(plugin.id);
    });

    it("does nothing when no worker manager is configured", async () => {
      const lifecycleNoWM = pluginLifecycleManager(db);
      const plugin = makePlugin({ status: "ready" });
      mockRegistry.getById.mockResolvedValue(plugin);

      // Should not throw
      await lifecycleNoWM.stopWorker(plugin.id);
    });
  });

  // =========================================================================
  // restartWorker
  // =========================================================================

  describe("restartWorker", () => {
    it("restarts a running worker", async () => {
      const mockHandle = makeMockWorkerHandle();
      const plugin = makePlugin({ status: "ready" });
      (mockWM.getWorker as ReturnType<typeof vi.fn>).mockReturnValue(mockHandle);
      mockRegistry.getById.mockResolvedValue(plugin);

      await lifecycle.restartWorker(plugin.id);

      expect(mockHandle.restart).toHaveBeenCalled();
    });

    it("emits worker_stopped and worker_started events", async () => {
      const mockHandle = makeMockWorkerHandle();
      const plugin = makePlugin({ status: "ready" });
      (mockWM.getWorker as ReturnType<typeof vi.fn>).mockReturnValue(mockHandle);
      mockRegistry.getById.mockResolvedValue(plugin);

      const stoppedEvents: any[] = [];
      const startedEvents: any[] = [];
      lifecycle.on("plugin.worker_stopped", (e) => stoppedEvents.push(e));
      lifecycle.on("plugin.worker_started", (e) => startedEvents.push(e));

      await lifecycle.restartWorker(plugin.id);

      expect(stoppedEvents).toHaveLength(1);
      expect(startedEvents).toHaveLength(1);
    });

    it("rejects restarting worker for non-ready plugin", async () => {
      const plugin = makePlugin({ status: "error" });
      mockRegistry.getById.mockResolvedValue(plugin);

      await expect(lifecycle.restartWorker(plugin.id)).rejects.toThrow(
        /Plugin must be in 'ready' status/,
      );
    });

    it("rejects restarting when no worker is running", async () => {
      const plugin = makePlugin({ status: "ready" });
      (mockWM.getWorker as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
      mockRegistry.getById.mockResolvedValue(plugin);

      await expect(lifecycle.restartWorker(plugin.id)).rejects.toThrow(
        /no worker is running/,
      );
    });

    it("rejects when no worker manager is configured", async () => {
      const lifecycleNoWM = pluginLifecycleManager(db);
      const plugin = makePlugin({ status: "ready" });
      mockRegistry.getById.mockResolvedValue(plugin);

      await expect(lifecycleNoWM.restartWorker(plugin.id)).rejects.toThrow(
        /no PluginWorkerManager is configured/,
      );
    });
  });
});

// ===========================================================================
// Legacy API compatibility — second arg as PluginLoader
// ===========================================================================

describe("pluginLifecycleManager legacy API", () => {
  const db = {} as any;

  it("accepts a PluginLoader as second argument (legacy signature)", async () => {
    vi.clearAllMocks();
    const lifecycle = pluginLifecycleManager(db, mockLoader as any);
    const plugin = makePlugin({ status: "installed" });
    const readyPlugin = { ...plugin, status: "ready" as PluginStatus };

    mockRegistry.getById.mockResolvedValue(plugin);
    mockRegistry.updateStatus.mockResolvedValue(readyPlugin);

    // Should work without errors — uses the provided loader
    const result = await lifecycle.load(plugin.id);
    expect(result.status).toBe("ready");
  });
});

// ===========================================================================
// isDisabledByOperator (standalone export)
// ===========================================================================

describe("isDisabledByOperator", () => {
  it("returns true for disabled_by_operator sentinel", () => {
    expect(isDisabledByOperator("disabled_by_operator")).toBe(true);
  });

  it("returns true for disabled_by_operator with reason", () => {
    expect(isDisabledByOperator("disabled_by_operator: maintenance")).toBe(true);
  });

  it("returns false for regular error messages", () => {
    expect(isDisabledByOperator("worker crashed")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isDisabledByOperator(null)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isDisabledByOperator("")).toBe(false);
  });
});
