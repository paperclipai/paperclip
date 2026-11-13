import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { listReadyPluginEnvironmentDrivers, pluginSupportsLoginPty } from "../services/plugin-environment-driver.js";
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

const PLUGIN_ID = "plugin-capability";
const PLUGIN_KEY = "paperclip.capability-sandbox-provider";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_KEY,
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Capability Sandbox Provider",
  description: "Sandbox provider that declares fine-grained capabilities.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: { worker: "dist/worker.js" },
  environmentDrivers: [
    {
      driverKey: "capability-provider",
      kind: "sandbox_provider",
      displayName: "Capability Provider",
      supportsReusableLeases: true,
      sandboxCapabilities: {
        reusableLeases: true,
        nativeSyncIn: true,
        nativeSyncOut: true,
        persistentProcessSessions: false,
      },
      configSchema: { type: "object", properties: {} },
    },
  ],
};

describe("listReadyPluginEnvironmentDrivers sandbox capability projection", () => {
  beforeEach(() => {
    mockRegistry.getById.mockReset();
    mockRegistry.list.mockReset();
    mockRegistry.listConfigs.mockReset();
    mockRegistry.update.mockReset();
  });

  it("test_capabilities_propagate_from_manifest_to_ready_driver_projection", async () => {
    mockRegistry.list.mockResolvedValue([
      { id: PLUGIN_ID, pluginKey: PLUGIN_KEY, status: "ready", manifestJson: manifest },
    ]);
    const workerManager = {
      isRunning: vi.fn(() => true),
      getWorker: vi.fn(() => ({ status: "running" })),
    } as unknown as PluginWorkerManager;

    const drivers = await listReadyPluginEnvironmentDrivers({
      db: {} as never,
      workerManager,
    });

    expect(drivers).toHaveLength(1);
    // The projection allowlist carries the raw declaration through unchanged, so
    // no reader downstream loses the capability contract.
    expect(drivers[0]?.sandboxCapabilities).toEqual({
      reusableLeases: true,
      nativeSyncIn: true,
      nativeSyncOut: true,
      persistentProcessSessions: false,
    });
    expect(drivers[0]?.supportsReusableLeases).toBe(true);
  });
  it("preserves existing sandbox login presentation without plugin allocation recovery", async () => {
    mockRegistry.list.mockResolvedValue([{
      id: PLUGIN_ID, pluginKey: PLUGIN_KEY, status: "ready", manifestJson: {
        ...manifest, environmentDrivers: [{ ...manifest.environmentDrivers![0], supportsLoginPty: true }],
      },
    }]);
    const workerManager = { isRunning: () => true, getWorker: () => ({ supportedMethods: [] }) } as unknown as PluginWorkerManager;
    const [driver] = await listReadyPluginEnvironmentDrivers({ db: {} as never, workerManager });
    expect(driver.supportsLoginPty).toBe(true);
  });

});

describe("live login capability admission and presentation", () => {
  const hooks = ["environmentAcquireLease", "environmentInspectLease", "environmentReleaseLease", "loginPtyOpen", "loginPtyInput", "loginPtyStop", "loginPtyClose"];
  const driver = { supportsLoginPty: true, creationOperationVersion: 1 as const };
  it("fails closed for each missing allocation, recovery, cleanup or transport hook", () => {
    for (const missing of hooks) expect(pluginSupportsLoginPty(driver, hooks.filter(hook => hook !== missing))).toBe(false);
    expect(pluginSupportsLoginPty({ ...driver, supportsLoginPty: false }, hooks)).toBe(false);
  });
  it("requires recoverable allocation identity before admitting login", () => {
    expect(pluginSupportsLoginPty({ supportsLoginPty: true }, hooks)).toBe(false);
    expect(pluginSupportsLoginPty({ supportsLoginPty: true }, [...hooks, "loginPtyReadCredential"], true)).toBe(false);
  });
  it("requires the narrow credential hook only for Codex", () => {
    expect(pluginSupportsLoginPty(driver, hooks)).toBe(true);
    expect(pluginSupportsLoginPty(driver, hooks, true)).toBe(false);
    expect(pluginSupportsLoginPty(driver, [...hooks, "loginPtyReadCredential"], true)).toBe(true);
  });
  it.each(["complete", "missing-version", "environmentAcquireLease", "environmentInspectLease", "environmentReleaseLease"] as const)(
    "projects the same recovery gate for login presentation: %s", async mode => {
      mockRegistry.list.mockResolvedValue([{
        id: PLUGIN_ID, pluginKey: PLUGIN_KEY, status: "ready", manifestJson: {
          ...manifest, environmentDrivers: [{ ...manifest.environmentDrivers![0], ...driver,
            kind: "environment_driver", creationOperationVersion: mode === "missing-version" ? undefined : 1,
          }],
        },
      }]);
      const methods = [...hooks, "loginPtyReadCredential"].filter(method => method !== mode);
      const workerManager = { isRunning: () => true, getWorker: () => ({ supportedMethods: methods }) } as unknown as PluginWorkerManager;
      const [projected] = await listReadyPluginEnvironmentDrivers({ db: {} as never, workerManager, kind: "environment_driver" });
      expect(projected.supportsLoginPty).toBe(mode === "complete");
      expect(projected.supportsCodexLogin).toBe(mode === "complete");
    },
  );
});
