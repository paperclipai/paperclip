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
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from "node:fs";
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

  it("rejects npm Kubernetes installs and persisted records before worker startup", async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_REQUIRE_ISOLATED_AGENT_RUNTIME", "true");
    try {
      const plugin = createPluginRecord({
        pluginKey: "paperclip.kubernetes-sandbox-provider",
        packageName: "@paperclipai/plugin-kubernetes",
        packagePath: null,
        status: "ready",
      });
      mockRegistry.getById.mockResolvedValue(plugin);
      const runtime = createRuntimeServices();
      const startWorker = vi.fn();
      runtime.workerManager.startWorker = startWorker;
      const loader = createLoader(runtime);

      await expect(loader.installPlugin({ packageName: "@paperclipai/plugin-kubernetes" }))
        .rejects.toThrow(/bundled Kubernetes sandbox provider/);
      const result = await loader.loadSingle(plugin.id);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/bundled Kubernetes sandbox provider/);
      expect(startWorker).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses external Kubernetes manifests before direct install, upgrade, or load", async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "external-kubernetes-")));
    vi.stubEnv("PAPERCLIP_SECRETS_REQUIRE_ISOLATED_AGENT_RUNTIME", "true");
    try {
      const external = path.join(root, "external");
      const marker = path.join(root, "manifest-imported");
      mkdirSync(path.join(external, "dist"), { recursive: true });
      writeFileSync(path.join(external, "package.json"), JSON.stringify({
        name: "@paperclipai/plugin-kubernetes",
        type: "module",
        paperclipPlugin: { manifest: "dist/manifest.js", worker: "dist/worker.js" },
      }));
      writeFileSync(path.join(external, "dist/manifest.js"),
        "import { writeFileSync } from 'node:fs'; writeFileSync(" + JSON.stringify(marker) + ", 'executed'); export default {};");
      const plugin = createPluginRecord({
        pluginKey: "paperclip.kubernetes-sandbox-provider",
        packageName: "@paperclipai/plugin-kubernetes",
        packagePath: external,
        status: "ready",
        manifestJson: { ...createPluginRecord().manifestJson, id: "paperclip.kubernetes-sandbox-provider" },
      });
      mockRegistry.getById.mockResolvedValue(plugin);
      const runtime = createRuntimeServices();
      const startWorker = vi.fn();
      runtime.workerManager.startWorker = startWorker;
      const loader = pluginLoader({} as Db, { localPluginDir: root }, runtime);

      await expect(loader.installPlugin({ localPath: external })).rejects.toThrow(/bundled Kubernetes sandbox provider/);
      await expect(loader.loadManifest(external)).rejects.toThrow(/bundled Kubernetes sandbox provider/);
      await expect(loader.upgradePlugin(plugin.id, { localPath: external })).rejects.toThrow(/bundled Kubernetes sandbox provider/);
      const loaded = await loader.loadSingle(plugin.id);
      expect(loaded.success).toBe(false);
      expect(loaded.error).toMatch(/bundled Kubernetes sandbox provider/);
      expect(existsSync(marker)).toBe(false);
      expect(startWorker).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never imports a renamed Kubernetes manifest or starts an unverified plugin in isolation mode", async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "renamed-kubernetes-")));
    vi.stubEnv("PAPERCLIP_SECRETS_REQUIRE_ISOLATED_AGENT_RUNTIME", "true");
    try {
      const external = path.join(root, "local/@acme/plugin-demo");
      const marker = path.join(root, "manifest-imported");
      mkdirSync(path.join(external, "dist"), { recursive: true });
      writeFileSync(path.join(external, "package.json"), JSON.stringify({
        name: "@acme/plugin-demo",
        type: "module",
        paperclipPlugin: { manifest: "dist/manifest.js", worker: "dist/worker.js" },
      }));
      writeFileSync(path.join(external, "dist/manifest.js"),
        "import { writeFileSync } from 'node:fs'; writeFileSync(" + JSON.stringify(marker) +
        ", 'executed'); export default " + JSON.stringify({
          ...createPluginRecord().manifestJson,
          id: "paperclip.kubernetes-sandbox-provider",
        }) + ";");
      writeFileSync(path.join(external, "dist/worker.js"), "export default {};");
      const npmPackage = path.join(root, "node_modules/@acme/plugin-demo");
      mkdirSync(path.dirname(npmPackage), { recursive: true });
      symlinkSync(external, npmPackage);

      const plugin = createPluginRecord({
        packageName: "@acme/plugin-demo",
        packagePath: external,
        status: "ready",
      });
      mockRegistry.getById.mockResolvedValue(plugin);
      const runtime = createRuntimeServices();
      const startWorker = vi.fn();
      runtime.workerManager.startWorker = startWorker;
      const loader = pluginLoader({} as Db, { localPluginDir: path.join(root, "local") }, runtime);

      await expect(loader.installPlugin({ localPath: external })).rejects.toThrow(/verified release-bundled plugin/);
      await expect(loader.installPlugin({ packageName: "@acme/plugin-demo" })).rejects.toThrow(/verified release-bundled plugin/);
      await expect(loader.loadManifest(external)).rejects.toThrow(/verified release-bundled plugin/);
      await expect(loader.upgradePlugin(plugin.id, { localPath: external })).rejects.toThrow(/verified release-bundled plugin/);
      const localDiscovery = await loader.discoverFromLocalFilesystem(path.join(root, "local"));
      expect(localDiscovery.discovered).toHaveLength(0);
      expect(localDiscovery.errors).toHaveLength(1);
      const npmDiscovery = await loader.discoverFromNpm([path.join(root, "node_modules")]);
      expect(npmDiscovery.discovered).toHaveLength(0);
      expect(npmDiscovery.errors).toHaveLength(1);
      const loaded = await loader.loadSingle(plugin.id);
      expect(loaded.success).toBe(false);
      expect(loaded.error).toMatch(/verified release-bundled plugin/);
      expect(existsSync(marker)).toBe(false);
      expect(startWorker).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("loads a digest-verified distribution manifest in isolation mode", async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "isolated-distribution-")));
    vi.stubEnv("PAPERCLIP_SECRETS_REQUIRE_ISOLATED_AGENT_RUNTIME", "true");
    try {
      const packageRoot = path.join(root, "distribution/example");
      mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
      const manifest = {
        ...createPluginRecord().manifestJson,
        categories: ["automation"],
        capabilities: ["issues.read"],
      };
      writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
        name: "@example/broken-plugin",
        version: "1.0.0",
        type: "module",
        paperclipPlugin: { manifest: "dist/manifest.js", worker: "dist/worker.js" },
      }));
      writeFileSync(path.join(packageRoot, "dist/manifest.js"), `export default ${JSON.stringify(manifest)};`);
      writeFileSync(path.join(packageRoot, "dist/worker.js"), "export default {};");
      writeFileSync(path.join(root, "distribution/catalog.json"), JSON.stringify({
        schemaVersion: 1,
        plugins: [{
          key: "example",
          pluginKey: manifest.id,
          version: manifest.version,
          directory: "example",
          digest: distributionBundleDigest(packageRoot),
        }],
      }));
      const entries = readDistributionPluginCatalog(root, []);
      const loader = pluginLoader({} as Db, {
        trustedDistributionPlugins: entries,
        assertPackageActivation: distributionPluginActivationGuard(root, entries, ["example"]),
      });
      expect(await loader.loadManifest(packageRoot)).toEqual(manifest);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["retarget", "remove"] as const)(
    "uses the canonical bundle after a trusted alias is %s before manifest load",
    async (action) => {
      const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "kubernetes-alias-")));
      vi.stubEnv("PAPERCLIP_SECRETS_REQUIRE_ISOLATED_AGENT_RUNTIME", "true");
      vi.stubEnv("PAPERCLIP_BUNDLED_PLUGIN_ROOT", path.join(root, "catalog"));
      try {
        const bundle = path.join(root, "catalog/sandbox-providers/kubernetes");
        const attacker = path.join(root, "attacker");
        const fallback = path.join(root, "installed/node_modules/@paperclipai/plugin-kubernetes");
        const alias = path.join(root, "alias");
        const marker = path.join(root, "untrusted-manifest-imported");
        const manifest = {
          ...createPluginRecord().manifestJson,
          id: "paperclip.kubernetes-sandbox-provider",
          categories: ["automation"],
          capabilities: ["issues.read"],
        };
        const packageJson = JSON.stringify({
          name: "@paperclipai/plugin-kubernetes",
          type: "module",
          paperclipPlugin: { manifest: "dist/manifest.js", worker: "dist/worker.js" },
        });
        for (const dir of [bundle, attacker, fallback]) {
          mkdirSync(path.join(dir, "dist"), { recursive: true });
          writeFileSync(path.join(dir, "package.json"), packageJson);
          writeFileSync(path.join(dir, "dist/worker.js"), "export default {};");
        }
        writeFileSync(path.join(bundle, "dist/manifest.js"), "export default " + JSON.stringify(manifest) + ";");
        const untrustedManifest =
          "import { writeFileSync } from 'node:fs'; writeFileSync(" + JSON.stringify(marker) +
          ", 'executed'); export default " + JSON.stringify(manifest) + ";";
        writeFileSync(path.join(attacker, "dist/manifest.js"), untrustedManifest);
        writeFileSync(path.join(fallback, "dist/manifest.js"), untrustedManifest);
        symlinkSync(bundle, alias);

        const plugin = createPluginRecord({
          pluginKey: "paperclip.kubernetes-sandbox-provider",
          packageName: "@paperclipai/plugin-kubernetes",
          packagePath: alias,
          status: "ready",
          manifestJson: manifest,
        });
        mockRegistry.getById.mockResolvedValue(plugin);
        const runtime = createRuntimeServices();
        const startWorker = vi.fn(async () => {});
        runtime.workerManager.startWorker = startWorker;
        let changed = false;
        const loader = pluginLoader({} as Db, {
          localPluginDir: path.join(root, "installed"),
          assertPackageActivation: ({ packageRoot }) => {
            expect(packageRoot).toBe(realpathSync(bundle));
            if (changed) return;
            changed = true;
            rmSync(alias);
            if (action === "retarget") symlinkSync(attacker, alias);
            else rmSync(path.join(bundle, "dist/worker.js"));
          },
        }, runtime);

        const result = await loader.loadSingle(plugin.id);
        expect(changed).toBe(true);
        expect(existsSync(marker)).toBe(false);
        if (action === "remove") {
          expect(result.success).toBe(false);
          expect(result.error).toMatch(/ENOENT/);
          expect(startWorker).not.toHaveBeenCalled();
        } else {
          expect(startWorker).toHaveBeenCalledWith(plugin.id, expect.objectContaining({
            entrypointPath: path.join(bundle, "dist/worker.js"),
          }));
        }
      } finally {
        vi.unstubAllEnvs();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

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
