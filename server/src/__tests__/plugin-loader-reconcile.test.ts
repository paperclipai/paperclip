/**
 * Unit tests for `pluginLoader().reconcileLoadedPlugins()`.
 *
 * After a plugin snapshot swap (plugin-artifact-replication.ts) the on-disk
 * plugin tree and the registry rows may no longer match what this replica
 * has activated in memory. `reconcileLoadedPlugins()` converges the runtime:
 * it diffs the registry's `ready` rows against the worker manager's handle
 * map and `loadSingle`s / `unloadSingle`s the difference.
 *
 * The diff logic is tested with the registry module mocked and a fake
 * worker manager; `loadSingle`/`unloadSingle` are stubbed on the loader
 * instance so no real workers are spawned.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRegistry = vi.hoisted(() => ({
  listByStatus: vi.fn(),
  getById: vi.fn(),
  listInstalled: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

import { pluginLoader } from "../services/plugin-loader.js";

function createLoader(workerPluginIds: string[]) {
  const workerManager = {
    diagnostics: vi.fn(() =>
      workerPluginIds.map((pluginId) => ({ pluginId, status: "running" })),
    ),
  };
  const loader = pluginLoader(
    {} as never,
    {},
    {
      workerManager,
      instanceInfo: { instanceId: "test", hostVersion: "0.0.0" },
    } as never,
  );
  const loadSingle = vi.fn(async (pluginId: string) => ({
    plugin: { id: pluginId },
    success: true,
    registered: { worker: true, eventSubscriptions: 0, jobs: 0, webhooks: 0, tools: 0 },
  }));
  const unloadSingle = vi.fn(async (_pluginId: string, _pluginKey: string) => {});
  loader.loadSingle = loadSingle as never;
  loader.unloadSingle = unloadSingle as never;
  return { loader, loadSingle, unloadSingle, workerManager };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRegistry.listByStatus.mockResolvedValue([]);
  mockRegistry.getById.mockResolvedValue(null);
});

describe("pluginLoader.reconcileLoadedPlugins", () => {
  it("loads ready plugins that have no worker handle", async () => {
    mockRegistry.listByStatus.mockResolvedValue([
      { id: "plugin-a", pluginKey: "acme.a", status: "ready" },
      { id: "plugin-b", pluginKey: "acme.b", status: "ready" },
    ]);
    const { loader, loadSingle, unloadSingle } = createLoader(["plugin-a"]);

    const result = await loader.reconcileLoadedPlugins();

    expect(loadSingle).toHaveBeenCalledTimes(1);
    expect(loadSingle).toHaveBeenCalledWith("plugin-b");
    expect(unloadSingle).not.toHaveBeenCalled();
    expect(result).toEqual({ loaded: ["plugin-b"], unloaded: [] });
  });

  it("unloads workers whose registry row is no longer ready (key from registry)", async () => {
    mockRegistry.listByStatus.mockResolvedValue([]);
    mockRegistry.getById.mockResolvedValue({
      id: "plugin-x",
      pluginKey: "acme.x",
      status: "disabled",
    });
    const { loader, loadSingle, unloadSingle } = createLoader(["plugin-x"]);

    const result = await loader.reconcileLoadedPlugins();

    expect(unloadSingle).toHaveBeenCalledTimes(1);
    expect(unloadSingle).toHaveBeenCalledWith("plugin-x", "acme.x");
    expect(loadSingle).not.toHaveBeenCalled();
    expect(result).toEqual({ loaded: [], unloaded: ["plugin-x"] });
  });

  it("unloads workers whose registry row was purged, falling back to the id as key", async () => {
    mockRegistry.listByStatus.mockResolvedValue([]);
    mockRegistry.getById.mockResolvedValue(null);
    const { loader, unloadSingle } = createLoader(["plugin-gone"]);

    const result = await loader.reconcileLoadedPlugins();

    expect(unloadSingle).toHaveBeenCalledWith("plugin-gone", "plugin-gone");
    expect(result.unloaded).toEqual(["plugin-gone"]);
  });

  it("is a no-op when registry and runtime already match", async () => {
    mockRegistry.listByStatus.mockResolvedValue([
      { id: "plugin-a", pluginKey: "acme.a", status: "ready" },
    ]);
    const { loader, loadSingle, unloadSingle } = createLoader(["plugin-a"]);

    const result = await loader.reconcileLoadedPlugins();

    expect(loadSingle).not.toHaveBeenCalled();
    expect(unloadSingle).not.toHaveBeenCalled();
    expect(result).toEqual({ loaded: [], unloaded: [] });
  });

  it("continues past individual load/unload failures and reports only successes", async () => {
    mockRegistry.listByStatus.mockResolvedValue([
      { id: "plugin-ok", pluginKey: "acme.ok", status: "ready" },
      { id: "plugin-broken", pluginKey: "acme.broken", status: "ready" },
    ]);
    const { loader, loadSingle } = createLoader([]);
    loadSingle.mockImplementation(async (pluginId: string) => {
      if (pluginId === "plugin-broken") throw new Error("activation failed");
      return {
        plugin: { id: pluginId },
        success: true,
        registered: { worker: true, eventSubscriptions: 0, jobs: 0, webhooks: 0, tools: 0 },
      };
    });

    const result = await loader.reconcileLoadedPlugins();

    expect(loadSingle).toHaveBeenCalledTimes(2);
    expect(result.loaded).toEqual(["plugin-ok"]);
  });

  it("restarts a loaded plugin whose registry version moved (peer upgrade via snapshot swap)", async () => {
    mockRegistry.listByStatus.mockResolvedValue([
      { id: "plugin-a", pluginKey: "acme.a", status: "ready", version: "1.1.0" },
    ]);
    const { loader, loadSingle, unloadSingle } = createLoader(["plugin-a"]);
    // Seed: this replica activated version 1.0.0 — the worker still runs the
    // OLD code even though the snapshot swap put 1.1.0 on disk.
    loader.activePluginVersion = vi.fn(() => "1.0.0");

    const result = await loader.reconcileLoadedPlugins();

    expect(unloadSingle).toHaveBeenCalledTimes(1);
    expect(unloadSingle).toHaveBeenCalledWith("plugin-a", "acme.a");
    expect(loadSingle).toHaveBeenCalledTimes(1);
    expect(loadSingle).toHaveBeenCalledWith("plugin-a");
    expect(result).toEqual({ loaded: ["plugin-a"], unloaded: ["plugin-a"] });
  });

  it("does not restart a loaded plugin whose version is unchanged", async () => {
    mockRegistry.listByStatus.mockResolvedValue([
      { id: "plugin-a", pluginKey: "acme.a", status: "ready", version: "1.0.0" },
    ]);
    const { loader, loadSingle, unloadSingle } = createLoader(["plugin-a"]);
    loader.activePluginVersion = vi.fn(() => "1.0.0");

    const result = await loader.reconcileLoadedPlugins();

    expect(loadSingle).not.toHaveBeenCalled();
    expect(unloadSingle).not.toHaveBeenCalled();
    expect(result).toEqual({ loaded: [], unloaded: [] });
  });

  it("does not restart a loaded plugin whose activated version was never recorded", async () => {
    mockRegistry.listByStatus.mockResolvedValue([
      { id: "plugin-a", pluginKey: "acme.a", status: "ready", version: "1.1.0" },
    ]);
    const { loader, loadSingle, unloadSingle } = createLoader(["plugin-a"]);
    loader.activePluginVersion = vi.fn(() => undefined);

    const result = await loader.reconcileLoadedPlugins();

    // Conservative: without a recorded activation version we cannot tell an
    // upgrade from a recording gap — never bounce a healthy worker blindly.
    expect(loadSingle).not.toHaveBeenCalled();
    expect(unloadSingle).not.toHaveBeenCalled();
    expect(result).toEqual({ loaded: [], unloaded: [] });
  });

  it("continues past a failing restart and reports nothing for it", async () => {
    mockRegistry.listByStatus.mockResolvedValue([
      { id: "plugin-a", pluginKey: "acme.a", status: "ready", version: "1.1.0" },
      { id: "plugin-b", pluginKey: "acme.b", status: "ready", version: "2.0.0" },
    ]);
    const { loader, loadSingle, unloadSingle } = createLoader(["plugin-a", "plugin-b"]);
    loader.activePluginVersion = vi.fn((pluginId: string) =>
      pluginId === "plugin-a" ? "1.0.0" : "1.9.0",
    );
    unloadSingle.mockImplementation(async (pluginId: string) => {
      if (pluginId === "plugin-a") throw new Error("unload failed");
    });

    const result = await loader.reconcileLoadedPlugins();

    // plugin-a's restart failed at unload (logged, skipped); plugin-b restarted.
    expect(result.unloaded).toEqual(["plugin-b"]);
    expect(result.loaded).toEqual(["plugin-b"]);
    expect(loadSingle).toHaveBeenCalledTimes(1);
    expect(loadSingle).toHaveBeenCalledWith("plugin-b");
  });

  it("throws when constructed without runtime services", async () => {
    const loader = pluginLoader({} as never, {});
    await expect(loader.reconcileLoadedPlugins()).rejects.toThrow(/PluginRuntimeServices/);
  });
});
