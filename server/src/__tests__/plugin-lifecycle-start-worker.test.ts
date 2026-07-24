/**
 * Regression test for bundled-plugin activation.
 *
 * Bundled plugins (e.g. paperclip-plugin-telegram v0.3.0 served from
 * Paperclip's internal registry) failed to start with:
 *
 *   "Worker initialize failed: Plugin ... is not allowed to perform
 *    config.get: company context is required"
 *
 * because the host passed no `invocationScope` to the worker. The first
 * capability call the plugin makes during setup() (typically config.get)
 * was rejected by the SDK's `host-client-factory.js` (the allowedCompanyId
 * check), so the worker never reached `ready` and the install landed in
 * `status='error'`.
 *
 * The fix is for `lifecycle.startWorker` to look up the install's company
 * via `registry.listConfigs(pluginId)` and pass it on the options as
 * `invocationScope: { companyId }`. The plugin's first config row carries
 * the company that originated the install; a bundled plugin has exactly
 * one.
 *
 * @see PLUGIN_SPEC.md §13 - Host-Worker Protocol
 * @see packages/plugin-sdk/src/host-client-factory.js
 */
import { describe, expect, it, vi } from "vitest";

const pluginRecord = {
  id: "plugin-1",
  pluginKey: "example.bundled",
  status: "ready",
  manifestJson: { id: "example.bundled", capabilities: [] },
  packageName: "@example/bundled",
  version: "0.3.0",
  packagePath: "/usr/local/lib/example/bundled",
};

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  update: vi.fn(),
  updateStatus: vi.fn(),
  upsertConfig: vi.fn(),
  getConfig: vi.fn(),
  listConfigs: vi.fn(),
  list: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";
import type { PluginLoader } from "../services/plugin-loader.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

function makeWorkerManagerStub() {
  return {
    workerManager: {
      getWorker: vi.fn().mockReturnValue(null),
      isRunning: vi.fn().mockReturnValue(false),
      startWorker: vi.fn().mockResolvedValue(undefined),
      stopWorker: vi.fn().mockResolvedValue(undefined),
      restartWorker: vi.fn().mockResolvedValue(undefined),
    } as unknown as PluginWorkerManager,
  };
}

function makeLoader(overrides: Partial<PluginLoader> = {}): PluginLoader {
  return {
    hasRuntimeServices: vi.fn().mockReturnValue(false),
    installPlugin: vi.fn(),
    upgradePlugin: vi.fn(),
    loadSingle: vi.fn(),
    unloadSingle: vi.fn(),
    isSupportedApiVersion: vi.fn().mockReturnValue(true),
    removeRuntimeArtifacts: vi.fn(),
    shutdownAll: vi.fn(),
    ...overrides,
  } as PluginLoader;
}

const baseOptions = {
  entrypointPath: "/tmp/example.bundled/dist/worker.js",
  manifest: pluginRecord.manifestJson as any,
  config: {},
  instanceInfo: { instanceId: "inst-1", hostVersion: "2026.720.0" },
  apiVersion: 1,
  hostHandlers: {} as any,
};

describe("pluginLifecycleManager.startWorker", () => {
  it("passes invocationScope.companyId derived from the install's first config", async () => {
    mockRegistry.getById.mockResolvedValue(pluginRecord);
    mockRegistry.listConfigs.mockResolvedValue([
      { companyId: "company-A", configJson: {} },
    ]);

    const { workerManager } = makeWorkerManagerStub();
    const lifecycle = pluginLifecycleManager(
      {} as never,
      { loader: makeLoader(), workerManager },
    );

    await lifecycle.startWorker("plugin-1", baseOptions);

    expect(workerManager.startWorker).toHaveBeenCalledTimes(1);
    const [passedPluginId, passedOptions] = (workerManager.startWorker as any).mock.calls[0];
    expect(passedPluginId).toBe("plugin-1");
    expect(passedOptions.invocationScope).toEqual({ companyId: "company-A" });
  });

  it("uses the first config row's companyId when several are present", async () => {
    mockRegistry.getById.mockResolvedValue(pluginRecord);
    mockRegistry.listConfigs.mockResolvedValue([
      { companyId: "company-A", configJson: {} },
      { companyId: "company-B", configJson: {} },
    ]);

    const { workerManager } = makeWorkerManagerStub();
    const lifecycle = pluginLifecycleManager(
      {} as never,
      { loader: makeLoader(), workerManager },
    );

    await lifecycle.startWorker("plugin-1", baseOptions);

    const [, passedOptions] = (workerManager.startWorker as any).mock.calls[0];
    expect(passedOptions.invocationScope).toEqual({ companyId: "company-A" });
  });

  it("preserves existing options when adding invocationScope", async () => {
    mockRegistry.getById.mockResolvedValue(pluginRecord);
    mockRegistry.listConfigs.mockResolvedValue([
      { companyId: "company-A", configJson: {} },
    ]);

    const { workerManager } = makeWorkerManagerStub();
    const lifecycle = pluginLifecycleManager(
      {} as never,
      { loader: makeLoader(), workerManager },
    );

    await lifecycle.startWorker("plugin-1", {
      ...baseOptions,
      config: { foo: "bar" },
      rpcTimeoutMs: 5000,
      autoRestart: false,
      proactiveCompanyScopes: ["company-A"],
    });

    const [, passedOptions] = (workerManager.startWorker as any).mock.calls[0];
    expect(passedOptions).toMatchObject({
      rpcTimeoutMs: 5000,
      autoRestart: false,
      proactiveCompanyScopes: ["company-A"],
      config: { foo: "bar" },
      invocationScope: { companyId: "company-A" },
    });
  });

  it("does not invent a scope when the plugin has no config rows", async () => {
    mockRegistry.getById.mockResolvedValue(pluginRecord);
    mockRegistry.listConfigs.mockResolvedValue([]);

    const { workerManager } = makeWorkerManagerStub();
    const lifecycle = pluginLifecycleManager(
      {} as never,
      { loader: makeLoader(), workerManager },
    );

    await lifecycle.startWorker("plugin-1", baseOptions);

    const [, passedOptions] = (workerManager.startWorker as any).mock.calls[0];
    expect(passedOptions.invocationScope).toBeUndefined();
  });

  it("does not abort when listConfigs rejects (transient DB blip)", async () => {
    // Resilience regression: a registry.listConfigs rejection must NOT
    // propagate into a hard activation failure. A transient DB blip
    // during activation should leave the worker starting without a
    // pre-seeded scope (same best-effort shape as plugin-loader). The
    // worker's own init code will surface the missing-scope error if it
    // really needs the company; we don't want activation to flip to
    // status='error' here.
    mockRegistry.getById.mockResolvedValue(pluginRecord);
    mockRegistry.listConfigs.mockRejectedValue(new Error("DB unavailable"));

    const { workerManager } = makeWorkerManagerStub();
    const lifecycle = pluginLifecycleManager(
      {} as never,
      { loader: makeLoader(), workerManager },
    );

    await expect(lifecycle.startWorker("plugin-1", baseOptions)).resolves.toBeUndefined();

    expect(workerManager.startWorker).toHaveBeenCalledTimes(1);
    const [, passedOptions] = (workerManager.startWorker as any).mock.calls[0];
    expect(passedOptions.invocationScope).toBeUndefined();
  });
});
