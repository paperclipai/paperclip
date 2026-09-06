/**
 * Capability grants must not drift from the package that is actually running.
 *
 * The stored manifest is the grant of record — `buildHostHandlers` gates every
 * worker→host call on `manifestJson.capabilities`. Two host behaviours used to
 * combine badly around that:
 *
 * 1. `upgradePlugin` threw on any upgrade that added a capability, telling the
 *    operator that "approval" was required when no approval path existed. The
 *    `upgrade_pending` branch the lifecycle already implemented was therefore
 *    dead code, and operators fell back to swapping the package on disk.
 * 2. A package swapped on disk left the stored manifest untouched until the
 *    next activation, so the new code ran against the old capability set and
 *    every call needing a new capability was denied with nothing reporting why.
 *
 * `upgradePlugin` now reports the escalation instead of throwing and applies it
 * only against an explicit approval, and `inspectManifestDrift` makes the
 * stored-vs-disk difference observable.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { PluginCapability } from "@paperclipai/shared";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  list: vi.fn(),
  listInstalled: vi.fn(async () => []),
  listByStatus: vi.fn(async () => []),
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
import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";

const BASE_CAPABILITIES: PluginCapability[] = ["issues.read", "issue.comments.read"];
const ADDED_CAPABILITY: PluginCapability = "access.members.read";

function manifestSource(version: string, capabilities: PluginCapability[]): string {
  const manifest = {
    id: "example.drift-plugin",
    apiVersion: 1,
    version,
    displayName: "Drift Plugin",
    description: "Fixture plugin for capability drift tests",
    author: "Test",
    categories: ["connector"],
    capabilities,
    entrypoints: { worker: "worker.js" },
  };
  return `export default ${JSON.stringify(manifest, null, 2)};\n`;
}

/** Write a minimal on-disk plugin package the loader can read a manifest from. */
async function writePackage(
  root: string,
  version: string,
  capabilities: PluginCapability[],
): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "@example/drift-plugin",
      version,
      type: "module",
      paperclipPlugin: { manifest: "./manifest.js", worker: "./worker.js" },
    }),
  );
  // Cache-busted by mtime on import, so rewrites are picked up in-process.
  await writeFile(path.join(root, "manifest.js"), manifestSource(version, capabilities));
  await writeFile(path.join(root, "worker.js"), "export default {};\n");
}

function createPluginRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "plugin-drift-1",
    pluginKey: "example.drift-plugin",
    packageName: "@example/drift-plugin",
    packagePath: null,
    version: "1.0.0",
    apiVersion: 1,
    categories: ["connector"],
    status: "ready",
    lastError: null,
    installOrder: 1,
    manifestJson: {
      id: "example.drift-plugin",
      apiVersion: 1,
      version: "1.0.0",
      displayName: "Drift Plugin",
      description: "Fixture plugin for capability drift tests",
      author: "Test",
      categories: ["connector"],
      capabilities: BASE_CAPABILITIES,
      entrypoints: { worker: "worker.js" },
    },
    ...overrides,
  };
}

function createLoader(localPluginDir: string) {
  return pluginLoader({} as unknown as Db, {
    localPluginDir,
    enableLocalFilesystem: false,
    enableNpmDiscovery: false,
  });
}

describe("plugin capability drift", () => {
  let tmpRoot: string;
  let packageRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRegistry.listInstalled.mockResolvedValue([]);
    tmpRoot = await mkdtemp(path.join(tmpdir(), "plugin-drift-"));
    packageRoot = path.join(tmpRoot, "drift-plugin");
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  describe("upgradePlugin", () => {
    it("reports an unapproved capability escalation without granting it", async () => {
      const plugin = createPluginRecord({ packagePath: packageRoot });
      mockRegistry.getById.mockResolvedValue(plugin);
      await writePackage(packageRoot, "1.1.0", [...BASE_CAPABILITIES, ADDED_CAPABILITY]);

      const loader = createLoader(tmpRoot);
      const result = await loader.upgradePlugin(plugin.id, {});

      expect(result.applied).toBe(false);
      expect(result.addedCapabilities).toEqual([ADDED_CAPABILITY]);
      expect(result.newManifest.version).toBe("1.1.0");
      // The grant of record is untouched: the operator has not approved yet.
      expect(mockRegistry.update).not.toHaveBeenCalled();
    });

    it("applies the upgrade when every added capability is approved", async () => {
      const plugin = createPluginRecord({ packagePath: packageRoot });
      mockRegistry.getById.mockResolvedValue(plugin);
      await writePackage(packageRoot, "1.1.0", [...BASE_CAPABILITIES, ADDED_CAPABILITY]);

      const loader = createLoader(tmpRoot);
      const result = await loader.upgradePlugin(plugin.id, {
        approveCapabilities: [ADDED_CAPABILITY],
      });

      expect(result.applied).toBe(true);
      expect(result.addedCapabilities).toEqual([ADDED_CAPABILITY]);
      expect(mockRegistry.update).toHaveBeenCalledWith(
        plugin.id,
        expect.objectContaining({
          version: "1.1.0",
          manifest: expect.objectContaining({
            capabilities: [...BASE_CAPABILITIES, ADDED_CAPABILITY],
          }),
        }),
      );
    });

    it("holds the upgrade when only part of the escalation is approved", async () => {
      const plugin = createPluginRecord({ packagePath: packageRoot });
      mockRegistry.getById.mockResolvedValue(plugin);
      await writePackage(packageRoot, "1.1.0", [
        ...BASE_CAPABILITIES,
        ADDED_CAPABILITY,
        "issues.wakeup",
      ]);

      const loader = createLoader(tmpRoot);
      const result = await loader.upgradePlugin(plugin.id, {
        approveCapabilities: [ADDED_CAPABILITY],
      });

      expect(result.applied).toBe(false);
      expect(result.addedCapabilities).toEqual([ADDED_CAPABILITY, "issues.wakeup"]);
      expect(mockRegistry.update).not.toHaveBeenCalled();
    });

    it("applies an upgrade that adds no capabilities", async () => {
      const plugin = createPluginRecord({ packagePath: packageRoot });
      mockRegistry.getById.mockResolvedValue(plugin);
      await writePackage(packageRoot, "1.0.1", BASE_CAPABILITIES);

      const loader = createLoader(tmpRoot);
      const result = await loader.upgradePlugin(plugin.id, {});

      expect(result.applied).toBe(true);
      expect(result.addedCapabilities).toEqual([]);
      expect(mockRegistry.update).toHaveBeenCalledWith(
        plugin.id,
        expect.objectContaining({ version: "1.0.1" }),
      );
    });
  });

  describe("inspectManifestDrift", () => {
    it("reports capabilities the package declares but the stored grant lacks", async () => {
      await writePackage(packageRoot, "1.1.0", [...BASE_CAPABILITIES, ADDED_CAPABILITY]);
      const plugin = createPluginRecord({ packagePath: packageRoot });

      const drift = await createLoader(tmpRoot).inspectManifestDrift(plugin as never);

      expect(drift.packageReadable).toBe(true);
      expect(drift.drifted).toBe(true);
      expect(drift.storedVersion).toBe("1.0.0");
      expect(drift.packageVersion).toBe("1.1.0");
      expect(drift.addedCapabilities).toEqual([ADDED_CAPABILITY]);
      expect(drift.removedCapabilities).toEqual([]);
    });

    it("reports capabilities still granted that the package dropped", async () => {
      await writePackage(packageRoot, "2.0.0", ["issues.read"]);
      const plugin = createPluginRecord({ packagePath: packageRoot });

      const drift = await createLoader(tmpRoot).inspectManifestDrift(plugin as never);

      expect(drift.addedCapabilities).toEqual([]);
      expect(drift.removedCapabilities).toEqual(["issue.comments.read"]);
    });

    it("reports no drift when the package matches the stored manifest", async () => {
      await writePackage(packageRoot, "1.0.0", BASE_CAPABILITIES);
      const plugin = createPluginRecord({ packagePath: packageRoot });

      const drift = await createLoader(tmpRoot).inspectManifestDrift(plugin as never);

      expect(drift.drifted).toBe(false);
      expect(drift.addedCapabilities).toEqual([]);
      expect(drift.removedCapabilities).toEqual([]);
    });

    it("reports an unreadable package instead of throwing", async () => {
      const plugin = createPluginRecord({ packagePath: path.join(tmpRoot, "missing") });

      const drift = await createLoader(tmpRoot).inspectManifestDrift(plugin as never);

      expect(drift.packageReadable).toBe(false);
      expect(drift.error).toBeTruthy();
      expect(drift.addedCapabilities).toEqual([]);
    });
  });

  /**
   * Holding the upgrade is only a gate if it cannot be walked around. The
   * held package stays on disk and activation adopts the on-disk manifest, so
   * `enable` on an `upgrade_pending` plugin would otherwise grant exactly the
   * capabilities the operator declined to approve.
   */
  describe("enable on a held upgrade", () => {
    function createLifecycle(localPluginDir: string) {
      return pluginLifecycleManager({} as unknown as Db, createLoader(localPluginDir));
    }

    it("refuses to enable a pending upgrade that would grant unapproved capabilities", async () => {
      await writePackage(packageRoot, "1.1.0", [...BASE_CAPABILITIES, ADDED_CAPABILITY]);
      const plugin = createPluginRecord({
        packagePath: packageRoot,
        status: "upgrade_pending",
      });
      mockRegistry.getById.mockResolvedValue(plugin);

      await expect(createLifecycle(tmpRoot).enable(plugin.id)).rejects.toThrow(
        new RegExp(`never approved: ${ADDED_CAPABILITY}`),
      );
      // Neither the status nor the grant of record moved.
      expect(mockRegistry.updateStatus).not.toHaveBeenCalled();
      expect(mockRegistry.update).not.toHaveBeenCalled();
    });

    it("enables a pending upgrade once the package adds nothing over the stored grant", async () => {
      // What an approved upgrade leaves behind: the package on disk and the
      // stored manifest declare the same capabilities.
      await writePackage(packageRoot, "1.1.0", BASE_CAPABILITIES);
      const plugin = createPluginRecord({
        packagePath: packageRoot,
        status: "upgrade_pending",
      });
      mockRegistry.getById.mockResolvedValue(plugin);
      mockRegistry.updateStatus.mockResolvedValue({ ...plugin, status: "ready" });

      const result = await createLifecycle(tmpRoot).enable(plugin.id);

      expect(result.status).toBe("ready");
      expect(mockRegistry.updateStatus).toHaveBeenCalledWith(
        plugin.id,
        expect.objectContaining({ status: "ready" }),
      );
    });

    it("refuses to enable a pending upgrade whose package cannot be read", async () => {
      const plugin = createPluginRecord({
        packagePath: path.join(tmpRoot, "missing"),
        status: "upgrade_pending",
      });
      mockRegistry.getById.mockResolvedValue(plugin);

      await expect(createLifecycle(tmpRoot).enable(plugin.id)).rejects.toThrow(
        /could not be read/,
      );
      expect(mockRegistry.updateStatus).not.toHaveBeenCalled();
    });

    it("still enables a disabled plugin without inspecting a pending upgrade", async () => {
      await writePackage(packageRoot, "1.0.0", BASE_CAPABILITIES);
      const plugin = createPluginRecord({ packagePath: packageRoot, status: "disabled" });
      mockRegistry.getById.mockResolvedValue(plugin);
      mockRegistry.updateStatus.mockResolvedValue({ ...plugin, status: "ready" });

      const result = await createLifecycle(tmpRoot).enable(plugin.id);

      expect(result.status).toBe("ready");
    });
  });
});
