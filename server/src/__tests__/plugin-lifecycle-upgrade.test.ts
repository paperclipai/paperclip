import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PaperclipPluginManifestV1,
  PluginRecord,
} from "@paperclipai/shared";
import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";
import type { PluginLoader } from "../services/plugin-loader.js";

const mocks = vi.hoisted(() => ({
  registry: {
    getById: vi.fn(),
    updateStatus: vi.fn(),
  },
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mocks.registry,
}));

function manifest(version: string, capabilities: PaperclipPluginManifestV1["capabilities"]): PaperclipPluginManifestV1 {
  return {
    apiVersion: "paperclip.plugin/v1",
    id: "github-pr-ingress",
    name: "GitHub PR Ingress",
    version,
    description: "Routes GitHub PR webhooks into Paperclip issues.",
    categories: ["source-control"],
    capabilities,
    entrypoint: "./dist/worker.js",
  };
}

function pluginRecord(status: PluginRecord["status"], manifestJson: PaperclipPluginManifestV1): PluginRecord {
  return {
    id: "plugin-1",
    pluginKey: manifestJson.id,
    packageName: "paperclip-plugin-github-pr-ingress",
    packagePath: null,
    version: manifestJson.version,
    apiVersion: manifestJson.apiVersion,
    categories: manifestJson.categories,
    manifestJson,
    status,
    lastError: null,
    installOrder: 1,
    createdAt: new Date("2026-05-03T00:00:00Z"),
    updatedAt: new Date("2026-05-03T00:00:00Z"),
  } as PluginRecord;
}

describe("pluginLifecycleManager upgrade", () => {
  beforeEach(() => {
    mocks.registry.getById.mockReset();
    mocks.registry.updateStatus.mockReset();
  });

  it("leaves capability-escalating upgrades in upgrade_pending without activating the worker", async () => {
    const oldManifest = manifest("1.0.0", ["webhooks.receive"]);
    const newManifest = manifest("1.1.0", ["webhooks.receive", "secrets.read-ref"]);
    const oldPlugin = pluginRecord("ready", oldManifest);
    const upgradedPlugin = pluginRecord("upgrade_pending", newManifest);
    const loader = {
      upgradePlugin: vi.fn().mockResolvedValue({
        oldManifest,
        newManifest,
        discovered: {
          packageName: oldPlugin.packageName,
          packagePath: null,
          version: newManifest.version,
          source: "local-filesystem",
          manifest: newManifest,
        },
      }),
      hasRuntimeServices: vi.fn(() => true),
      unloadSingle: vi.fn(),
      loadSingle: vi.fn(),
    } as unknown as PluginLoader;
    const lifecycle = pluginLifecycleManager({} as never, { loader });

    mocks.registry.getById.mockResolvedValue(oldPlugin);
    mocks.registry.updateStatus.mockResolvedValue(upgradedPlugin);

    const result = await lifecycle.upgrade(oldPlugin.id, newManifest.version);

    expect(result.status).toBe("upgrade_pending");
    expect(loader.unloadSingle).toHaveBeenCalledWith(oldPlugin.id, oldPlugin.pluginKey);
    expect(loader.loadSingle).not.toHaveBeenCalled();
    expect(mocks.registry.updateStatus).toHaveBeenCalledWith(oldPlugin.id, {
      status: "upgrade_pending",
      lastError: null,
    });
  });
});
