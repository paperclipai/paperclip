/**
 * loadAll boot retry for plugins stranded in error status.
 *
 * An activation failure marks a plugin `error`, and the loader used to skip
 * those rows on every later boot — the row stayed dead until an operator
 * flipped it back to `ready` by hand, even when the underlying cause (missing
 * package dependencies, a stale build output) had long been fixed on disk.
 * loadAll now queues errored plugins for one retry per boot: it flips each row
 * to `ready` first (the error status cannot legally re-enter `error`, so a
 * failed retry could not re-mark itself otherwise) and then activates it like
 * any ready plugin. A retry that fails re-records the error through markError.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { distributionBundleDigest, distributionPluginActivationGuard, readDistributionPluginCatalog } from "../services/distribution-plugin-catalog.js";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  list: vi.fn(),
  listInstalled: vi.fn(),
  listByStatus: vi.fn(),
  update: vi.fn(),
  updateStatus: vi.fn(),
  upsertConfig: vi.fn(),
  getConfig: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

import { pluginLoader } from "../services/plugin-loader.js";
import type { PluginRuntimeServices } from "../services/plugin-loader.js";

function createPluginRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "plugin-err-1",
    pluginKey: "example.broken-plugin",
    packageName: "@example/broken-plugin",
    packagePath: "/nonexistent/broken-plugin",
    version: "1.0.0",
    apiVersion: 1,
    categories: [],
    status: "error",
    lastError: "Activation failed: previous boot failure",
    installOrder: 1,
    manifestJson: {
      id: "example.broken-plugin",
      apiVersion: 1,
      version: "1.0.0",
      displayName: "Broken Plugin",
      description: "Fixture",
      author: "Test",
      categories: [],
      capabilities: [],
      entrypoints: { worker: "dist/worker.js" },
    },
    ...overrides,
  };
}

function createRuntimeServices() {
  return {
    lifecycleManager: {
      markError: vi.fn(async () => createPluginRecord()),
    },
    workerManager: {},
    eventBus: {},
    jobScheduler: {},
    jobStore: {},
    toolDispatcher: {},
    buildHostHandlers: vi.fn(() => ({})),
    instanceInfo: { hostVersion: "0.0.0-test" },
  } as unknown as PluginRuntimeServices;
}

function createLoader(runtimeServices: PluginRuntimeServices) {
  return pluginLoader(
    {} as unknown as Db,
    { localPluginDir: "/nonexistent/local-plugins", enableLocalFilesystem: false, enableNpmDiscovery: false },
    runtimeServices,
  );
}

describe("pluginLoader.loadAll error retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("flips an errored plugin to ready and retries its activation at boot", async () => {
    const erroredPlugin = createPluginRecord();
    mockRegistry.listByStatus.mockImplementation(async (status: string) => {
      if (status === "error") return [erroredPlugin];
      return [];
    });
    mockRegistry.updateStatus.mockResolvedValue({ ...erroredPlugin, status: "ready", lastError: null });

    const runtimeServices = createRuntimeServices();
    const loader = createLoader(runtimeServices);

    const result = await loader.loadAll();

    // The flip precedes activation, and clears the stale error.
    expect(mockRegistry.updateStatus).toHaveBeenCalledExactlyOnceWith(erroredPlugin.id, { status: "ready" });
    // The retried plugin joins the boot batch; its package is unresolvable, so
    // the attempt fails and re-records a fresh error via markError.
    expect(result.total).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(1);
    expect(runtimeServices.lifecycleManager.markError).toHaveBeenCalledWith(
      erroredPlugin.id,
      expect.stringContaining("Activation failed"),
    );
  });

  it("keeps loading ready plugins when the errored flip fails", async () => {
    const readyPlugin = createPluginRecord({
      id: "plugin-ready-1",
      pluginKey: "example.ready-plugin",
      status: "ready",
      lastError: null,
    });
    const erroredPlugin = createPluginRecord();
    mockRegistry.listByStatus.mockImplementation(async (status: string) => {
      if (status === "ready") return [readyPlugin];
      if (status === "error") return [erroredPlugin];
      return [];
    });
    mockRegistry.updateStatus.mockRejectedValue(new Error("db write refused"));

    const loader = createLoader(createRuntimeServices());

    const result = await loader.loadAll();

    // The failed flip skips the retry but never aborts the boot load.
    expect(mockRegistry.updateStatus).toHaveBeenCalledExactlyOnceWith(erroredPlugin.id, { status: "ready" });
    expect(result.total).toBe(1);
    expect(result.results[0]?.plugin.id).toBe(readyPlugin.id);
  });

  it("returns the empty result when no plugin is ready or errored", async () => {
    mockRegistry.listByStatus.mockResolvedValue([]);

    const loader = createLoader(createRuntimeServices());

    const result = await loader.loadAll();

    expect(result).toEqual({ total: 0, succeeded: 0, failed: 0, results: [] });
  });

  it("rejects distribution capability escalation before saving a runtime refresh or starting a worker", async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "distribution-refresh-")));
    try {
      const packageRoot = path.join(root, "distribution", "example");
      mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
      const plugin = createPluginRecord({ status: "ready", packagePath: packageRoot });
      const replacement = { ...plugin.manifestJson, categories: ["ui"], capabilities: ["issues.read"] };
      writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: plugin.packageName, version: "1.0.0", type: "module", paperclipPlugin: { manifest: "dist/manifest.js", worker: "dist/worker.js" } }));
      writeFileSync(path.join(packageRoot, "dist/manifest.js"), `export default ${JSON.stringify(replacement)};`);
      writeFileSync(path.join(packageRoot, "dist/worker.js"), "throw new Error('unapproved worker must not start');");
      writeFileSync(path.join(root, "distribution/catalog.json"), JSON.stringify({ schemaVersion: 1, plugins: [{ key: "example", pluginKey: plugin.pluginKey, version: "1.0.0", directory: "example", digest: distributionBundleDigest(packageRoot) }] }));
      const runtime = createRuntimeServices();
      const startWorker = vi.fn();
      runtime.workerManager.startWorker = startWorker;
      mockRegistry.getById.mockResolvedValue(plugin);
      const loader = pluginLoader({} as Db, {
        localPluginDir: root,
        assertPackageActivation: distributionPluginActivationGuard(root, readDistributionPluginCatalog(root, []), ["example"]),
      }, runtime);
      const result = await loader.loadSingle(plugin.id);
      expect(result.success).toBe(false);
      expect(result.error).toContain("capabilities require approval: issues.read");
      expect(mockRegistry.update).not.toHaveBeenCalled();
      expect(startWorker).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not import an npm fallback for a removed distribution install", async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "distribution-removal-")));
    try {
      const packageRoot = path.join(root, "node_modules/@example/broken-plugin");
      mkdirSync(packageRoot, { recursive: true });
      const plugin = createPluginRecord({ status: "ready", packagePath: path.join(root, "distribution/removed") });
      writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: plugin.packageName, type: "module", paperclipPlugin: { manifest: "manifest.js" } }));
      writeFileSync(path.join(packageRoot, "manifest.js"), "throw new Error('fallback manifest must never import');");
      const runtime = createRuntimeServices();
      const startWorker = vi.fn();
      runtime.workerManager.startWorker = startWorker;
      mockRegistry.getById.mockResolvedValue(plugin);
      const loader = pluginLoader({} as Db, {
        localPluginDir: root,
        assertPackageActivation: distributionPluginActivationGuard(root, [], []),
      }, runtime);
      const result = await loader.loadSingle(plugin.id);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Distribution plugin is absent or not selected");
      expect(mockRegistry.update).not.toHaveBeenCalled();
      expect(startWorker).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
