import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { createPluginJobCoordinator } from "../services/plugin-job-coordinator.js";
import type { PluginJobCoordinator } from "../services/plugin-job-coordinator.js";
import type { PluginJobScheduler } from "../services/plugin-job-scheduler.js";
import type { PluginJobStore } from "../services/plugin-job-store.js";
import type { PluginLifecycleManager } from "../services/plugin-lifecycle.js";

// ---------------------------------------------------------------------------
// Mock logger — must be before any imports that use it
// ---------------------------------------------------------------------------

vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Mock plugin registry
// ---------------------------------------------------------------------------

const mockRegistryGetById = vi.fn();

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => ({
    getById: mockRegistryGetById,
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PLUGIN_ID = "plugin-uuid-1";
const PLUGIN_KEY = "acme.test";

function makePluginRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: PLUGIN_ID,
    pluginKey: PLUGIN_KEY,
    status: "ready",
    version: "1.0.0",
    manifestJson: {
      id: PLUGIN_KEY,
      apiVersion: 1,
      version: "1.0.0",
      displayName: "Test Plugin",
      description: "A test plugin",
      categories: ["connector"],
      capabilities: ["jobs.schedule"],
      entrypoints: { worker: "dist/worker.js" },
      jobs: [
        {
          jobKey: "full-sync",
          displayName: "Full Sync",
          description: "Sync all data",
          schedule: "*/15 * * * *",
        },
        {
          jobKey: "daily-report",
          displayName: "Daily Report",
          schedule: "0 9 * * *",
        },
      ],
    },
    lastError: null,
    ...overrides,
  };
}

/**
 * Create a mock lifecycle manager backed by a real EventEmitter.
 */
function makeMockLifecycle(): PluginLifecycleManager & { emit: EventEmitter["emit"] } {
  const emitter = new EventEmitter();
  return {
    load: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    unload: vi.fn(),
    markError: vi.fn(),
    markUpgradePending: vi.fn(),
    upgrade: vi.fn(),
    getStatus: vi.fn(),
    canTransition: vi.fn(),
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    once: emitter.once.bind(emitter),
    emit: emitter.emit.bind(emitter),
  } as any;
}

function makeMockScheduler(): PluginJobScheduler {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    registerPlugin: vi.fn().mockResolvedValue(undefined),
    unregisterPlugin: vi.fn().mockResolvedValue(undefined),
    triggerJob: vi.fn(),
    tick: vi.fn(),
    diagnostics: vi.fn(),
  } as any;
}

function makeMockJobStore(): PluginJobStore {
  return {
    syncJobDeclarations: vi.fn().mockResolvedValue(undefined),
    listJobs: vi.fn().mockResolvedValue([]),
    getJobByKey: vi.fn().mockResolvedValue(null),
    getJobById: vi.fn().mockResolvedValue(null),
    updateJobStatus: vi.fn().mockResolvedValue(undefined),
    updateRunTimestamps: vi.fn().mockResolvedValue(undefined),
    deleteAllJobs: vi.fn().mockResolvedValue(undefined),
    createRun: vi.fn(),
    markRunning: vi.fn(),
    completeRun: vi.fn(),
    getRunById: vi.fn(),
    listRunsByJob: vi.fn(),
    listRunsByPlugin: vi.fn(),
  } as any;
}

function makeMocks() {
  const lifecycle = makeMockLifecycle();
  const scheduler = makeMockScheduler();
  const jobStore = makeMockJobStore();
  const db = {} as any;
  return { lifecycle, scheduler, jobStore, db };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PluginJobCoordinator", () => {
  let mocks: ReturnType<typeof makeMocks>;
  let coordinator: PluginJobCoordinator;

  beforeEach(() => {
    mocks = makeMocks();
    mockRegistryGetById.mockReset();
    coordinator = createPluginJobCoordinator({
      db: mocks.db,
      lifecycle: mocks.lifecycle,
      scheduler: mocks.scheduler,
      jobStore: mocks.jobStore,
    });
  });

  afterEach(() => {
    coordinator.stop();
  });

  // =========================================================================
  // start / stop
  // =========================================================================

  describe("start / stop", () => {
    it("is idempotent — multiple starts are no-ops", () => {
      coordinator.start();
      coordinator.start();
      // Should not throw or double-subscribe
    });

    it("is idempotent — stop before start is safe", () => {
      coordinator.stop();
      // Should not throw
    });
  });

  // =========================================================================
  // plugin.loaded event
  // =========================================================================

  describe("plugin.loaded", () => {
    it("syncs job declarations and registers plugin with scheduler", async () => {
      const plugin = makePluginRecord();
      mockRegistryGetById.mockResolvedValue(plugin);

      coordinator.start();
      mocks.lifecycle.emit("plugin.loaded", {
        pluginId: PLUGIN_ID,
        pluginKey: PLUGIN_KEY,
      });

      // Allow async handlers to run
      await vi.waitFor(() => {
        expect(mocks.jobStore.syncJobDeclarations).toHaveBeenCalled();
      });

      // Should sync the 2 job declarations from the manifest
      expect(mocks.jobStore.syncJobDeclarations).toHaveBeenCalledWith(
        PLUGIN_ID,
        expect.arrayContaining([
          expect.objectContaining({ jobKey: "full-sync" }),
          expect.objectContaining({ jobKey: "daily-report" }),
        ]),
      );

      // Should register with the scheduler
      expect(mocks.scheduler.registerPlugin).toHaveBeenCalledWith(PLUGIN_ID);
    });

    it("skips sync when manifest has no jobs", async () => {
      const plugin = makePluginRecord({
        manifestJson: {
          id: PLUGIN_KEY,
          apiVersion: 1,
          version: "1.0.0",
          displayName: "Test Plugin",
          description: "A test plugin",
          categories: ["connector"],
          capabilities: [],
          entrypoints: { worker: "dist/worker.js" },
          // No jobs declared
        },
      });
      mockRegistryGetById.mockResolvedValue(plugin);

      coordinator.start();
      mocks.lifecycle.emit("plugin.loaded", {
        pluginId: PLUGIN_ID,
        pluginKey: PLUGIN_KEY,
      });

      await vi.waitFor(() => {
        expect(mocks.scheduler.registerPlugin).toHaveBeenCalledWith(PLUGIN_ID);
      });

      // Should NOT sync (no jobs)
      expect(mocks.jobStore.syncJobDeclarations).not.toHaveBeenCalled();

      // Should still register with the scheduler
      expect(mocks.scheduler.registerPlugin).toHaveBeenCalledWith(PLUGIN_ID);
    });

    it("skips when plugin manifest is not found", async () => {
      mockRegistryGetById.mockResolvedValue(null);

      coordinator.start();
      mocks.lifecycle.emit("plugin.loaded", {
        pluginId: PLUGIN_ID,
        pluginKey: PLUGIN_KEY,
      });

      // Give async handlers time to run
      await new Promise((r) => setTimeout(r, 50));

      expect(mocks.jobStore.syncJobDeclarations).not.toHaveBeenCalled();
      expect(mocks.scheduler.registerPlugin).not.toHaveBeenCalled();
    });

    it("handles errors gracefully during job sync", async () => {
      const plugin = makePluginRecord();
      mockRegistryGetById.mockResolvedValue(plugin);
      (mocks.jobStore.syncJobDeclarations as any).mockRejectedValue(
        new Error("DB connection failed"),
      );

      coordinator.start();
      mocks.lifecycle.emit("plugin.loaded", {
        pluginId: PLUGIN_ID,
        pluginKey: PLUGIN_KEY,
      });

      // Give async handlers time to run (and swallow the error)
      await new Promise((r) => setTimeout(r, 50));

      // Should not throw — error is caught and logged
      expect(mocks.jobStore.syncJobDeclarations).toHaveBeenCalled();
    });

    it("does not fire events when coordinator is stopped", async () => {
      const plugin = makePluginRecord();
      mockRegistryGetById.mockResolvedValue(plugin);

      coordinator.start();
      coordinator.stop();

      mocks.lifecycle.emit("plugin.loaded", {
        pluginId: PLUGIN_ID,
        pluginKey: PLUGIN_KEY,
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(mocks.jobStore.syncJobDeclarations).not.toHaveBeenCalled();
      expect(mocks.scheduler.registerPlugin).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // plugin.disabled event
  // =========================================================================

  describe("plugin.disabled", () => {
    it("unregisters plugin from scheduler", async () => {
      coordinator.start();
      mocks.lifecycle.emit("plugin.disabled", {
        pluginId: PLUGIN_ID,
        pluginKey: PLUGIN_KEY,
        reason: "Disabled by operator",
      });

      await vi.waitFor(() => {
        expect(mocks.scheduler.unregisterPlugin).toHaveBeenCalledWith(PLUGIN_ID);
      });
    });

    it("handles errors gracefully", async () => {
      (mocks.scheduler.unregisterPlugin as any).mockRejectedValue(
        new Error("Scheduler error"),
      );

      coordinator.start();
      mocks.lifecycle.emit("plugin.disabled", {
        pluginId: PLUGIN_ID,
        pluginKey: PLUGIN_KEY,
      });

      // Give async handlers time to run
      await new Promise((r) => setTimeout(r, 50));

      // Should not throw
      expect(mocks.scheduler.unregisterPlugin).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // plugin.unloaded event
  // =========================================================================

  describe("plugin.unloaded", () => {
    it("unregisters plugin from scheduler (soft delete)", async () => {
      coordinator.start();
      mocks.lifecycle.emit("plugin.unloaded", {
        pluginId: PLUGIN_ID,
        pluginKey: PLUGIN_KEY,
        removeData: false,
      });

      await vi.waitFor(() => {
        expect(mocks.scheduler.unregisterPlugin).toHaveBeenCalledWith(PLUGIN_ID);
      });

      // Should NOT delete jobs when removeData is false
      expect(mocks.jobStore.deleteAllJobs).not.toHaveBeenCalled();
    });

    it("unregisters and purges job data when removeData is true", async () => {
      coordinator.start();
      mocks.lifecycle.emit("plugin.unloaded", {
        pluginId: PLUGIN_ID,
        pluginKey: PLUGIN_KEY,
        removeData: true,
      });

      await vi.waitFor(() => {
        expect(mocks.scheduler.unregisterPlugin).toHaveBeenCalledWith(PLUGIN_ID);
      });

      // Should delete all jobs when removeData is true
      expect(mocks.jobStore.deleteAllJobs).toHaveBeenCalledWith(PLUGIN_ID);
    });

    it("handles errors gracefully during purge", async () => {
      (mocks.jobStore.deleteAllJobs as any).mockRejectedValue(
        new Error("Delete failed"),
      );

      coordinator.start();
      mocks.lifecycle.emit("plugin.unloaded", {
        pluginId: PLUGIN_ID,
        pluginKey: PLUGIN_KEY,
        removeData: true,
      });

      // Give async handlers time to run
      await new Promise((r) => setTimeout(r, 50));

      // Should not throw — error is caught and logged
    });
  });

  // =========================================================================
  // Full integration scenario
  // =========================================================================

  describe("full lifecycle scenario", () => {
    it("handles load → disable → re-enable lifecycle", async () => {
      const plugin = makePluginRecord();
      mockRegistryGetById.mockResolvedValue(plugin);

      coordinator.start();

      // 1. Plugin loaded
      mocks.lifecycle.emit("plugin.loaded", {
        pluginId: PLUGIN_ID,
        pluginKey: PLUGIN_KEY,
      });

      await vi.waitFor(() => {
        expect(mocks.scheduler.registerPlugin).toHaveBeenCalledTimes(1);
      });
      expect(mocks.jobStore.syncJobDeclarations).toHaveBeenCalledTimes(1);

      // 2. Plugin disabled
      mocks.lifecycle.emit("plugin.disabled", {
        pluginId: PLUGIN_ID,
        pluginKey: PLUGIN_KEY,
        reason: "Maintenance",
      });

      await vi.waitFor(() => {
        expect(mocks.scheduler.unregisterPlugin).toHaveBeenCalledTimes(1);
      });

      // 3. Plugin re-enabled (loaded again)
      mocks.lifecycle.emit("plugin.loaded", {
        pluginId: PLUGIN_ID,
        pluginKey: PLUGIN_KEY,
      });

      await vi.waitFor(() => {
        expect(mocks.scheduler.registerPlugin).toHaveBeenCalledTimes(2);
      });
      expect(mocks.jobStore.syncJobDeclarations).toHaveBeenCalledTimes(2);
    });
  });
});
