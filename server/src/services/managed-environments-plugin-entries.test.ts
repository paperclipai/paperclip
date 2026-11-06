import { describe, expect, it, vi } from "vitest";
import { unprocessable } from "../errors.js";
import {
  applyManagedEnvironments,
  createManagedEnvironmentRecovery,
  registerManagedPluginInstanceDefaultRetry,
} from "./managed-environments.js";
import { idleWorkSnapshot } from "./task-admission.js";
import {
  environmentRow,
  PLUGIN_KEY,
  environmentsSeam,
  instanceSettingsSeam,
  noDb,
  parsedConfig,
  pluginEnvironmentRow,
  readyDriverResolver,
  reconciliationResult,
  recoveryHandle,
  tick,
  type InstanceSettingsSeam,
  type RecoveryHandle,
} from "./managed-environments.test-support.js";

describe("applyManagedEnvironments plugin entries", () => {
  const pluginEntry = (overrides: Record<string, unknown> = {}) => ({
    name: "Remote Host",
    description: "Runs the agent on a remote host",
    driver: "plugin",
    pluginKey: PLUGIN_KEY,
    driverKey: "tasks",
    driverConfig: {},
    ...overrides,
  });
  const configWith = (environments: unknown[], features: Record<string, unknown> = {}) => parsedConfig({
    plugins: { autoInstall: ["daytona", "remote-host"] },
    features,
    environments,
  });
  const readyPlugin = (status = "ready", declaresDriver = true) => vi.fn(async () => ({
    plugin: { id: "remote-host-plugin", pluginKey: PLUGIN_KEY, status },
    declaresDriver,
  }));
  const workerManager = (running = true, handle?: RecoveryHandle) => ({
    isRunning: vi.fn(() => running),
    call: vi.fn(),
    getWorker: vi.fn(() => handle),
  });

  it("ensures a plugin entry with the plugin validator's worker manager", async () => {
    const environments = environmentsSeam();
    const result = await applyManagedEnvironments(noDb, configWith([pluginEntry()]), {
      env: {},
      workerManager: workerManager(),
      environments,
      instanceSettings: instanceSettingsSeam(),
      resolveEnvironmentPlugin: readyPlugin(),
      autoInstalledPluginKeys: [PLUGIN_KEY],
    });

    expect(environments.ensureManagedPluginEnvironment).toHaveBeenCalledWith({
      name: "Remote Host",
      description: "Runs the agent on a remote host",
      pluginKey: PLUGIN_KEY,
      driverKey: "tasks",
      driverConfig: {},
      workerManager: { isRunning: expect.any(Function), call: expect.any(Function) },
    });
    expect(result).toMatchObject({ ensured: 1, added: 1, failed: 0 });
    expect(result?.pluginOutcomes).toEqual([{
      environmentId: "plugin-env",
      name: "Remote Host",
      pluginKey: PLUGIN_KEY,
      driverKey: "tasks",
      action: "added",
    }]);
    expect(environments.ensureManagedSandboxEnvironment).not.toHaveBeenCalled();
  });

  it("runs the sandbox entry first", async () => {
    const order: string[] = [];
    const environments = environmentsSeam({
      ensureManagedSandboxEnvironment: vi.fn(async () => {
        order.push("sandbox");
        return reconciliationResult() as never;
      }),
      ensureManagedPluginEnvironment: vi.fn(async () => {
        order.push("plugin");
        return { environment: pluginEnvironmentRow(), action: "added" as const };
      }),
    });
    await applyManagedEnvironments(noDb, configWith([{ name: "Daytona", provider: "daytona" }, pluginEntry()]), {
      env: {},
      workerManager: workerManager(),
      environments,
      instanceSettings: instanceSettingsSeam(),
      resolveSandboxProviderDriver: readyDriverResolver(),
      resolveEnvironmentPlugin: readyPlugin(),
      autoInstalledPluginKeys: [PLUGIN_KEY],
    });
    expect(order).toEqual(["sandbox", "plugin"]);
  });

  it("refuses startup when no auto-installed catalog entry installs the entry's plugin", async () => {
    const environments = environmentsSeam();
    await expect(applyManagedEnvironments(noDb, configWith([pluginEntry()]), {
      env: {},
      workerManager: workerManager(),
      environments,
      instanceSettings: instanceSettingsSeam(),
      resolveEnvironmentPlugin: readyPlugin(),
      autoInstalledPluginKeys: ["paperclip.daytona-sandbox-provider"],
    })).rejects.toThrow(/uses plugin "example.remote-host-plugin", which no "plugins.autoInstall" catalog entry installs/);
    expect(environments.ensureManagedPluginEnvironment).not.toHaveBeenCalled();
  });

  it("resolves the auto-installed manifest ids from the catalog when the caller passes none", async () => {
    // "remote-host" is not in this build's bundled catalog and the test root
    // has no distribution catalog, so the catalog lookup refuses.
    await expect(applyManagedEnvironments(noDb, configWith([pluginEntry()]), {
      env: { PAPERCLIP_BUNDLED_PLUGIN_ROOT: "/nonexistent-paperclip-catalog" },
      workerManager: workerManager(),
      environments: environmentsSeam(),
      instanceSettings: instanceSettingsSeam(),
    })).rejects.toThrow(/auto-install key "remote-host" is not in the bundled catalog/);
  });

  it("does not claim the sandbox slot, so a forced execution mode can coexist with plugin-only entries", async () => {
    await expect(applyManagedEnvironments(noDb, configWith([pluginEntry()]), {
      env: { PAPERCLIP_EXECUTION_MODE: "kubernetes" },
      workerManager: workerManager(),
      environments: environmentsSeam(),
      instanceSettings: instanceSettingsSeam(),
      resolveEnvironmentPlugin: readyPlugin(),
      autoInstalledPluginKeys: [PLUGIN_KEY],
    })).resolves.toMatchObject({ ensured: 1 });
  });

  it("archives the row of a plugin that is down and reactivates it on worker recovery", async () => {
    const { handle, fireReady } = recoveryHandle();
    const environments = environmentsSeam({
      archiveManagedPluginEnvironment: vi.fn().mockResolvedValue(pluginEnvironmentRow({ status: "archived" })),
    });
    const manager = workerManager(false, handle);
    const result = await applyManagedEnvironments(noDb, configWith([pluginEntry()]), {
      env: {},
      workerManager: manager,
      environments,
      instanceSettings: instanceSettingsSeam(),
      resolveEnvironmentPlugin: readyPlugin(),
      autoInstalledPluginKeys: [PLUGIN_KEY],
    });

    expect(result).toMatchObject({ ensured: 0, failed: 1 });
    expect(environments.archiveManagedPluginEnvironment).toHaveBeenCalledWith({ pluginKey: PLUGIN_KEY, driverKey: "tasks" });
    expect(environments.ensureManagedPluginEnvironment).not.toHaveBeenCalled();

    manager.isRunning.mockReturnValue(true);
    fireReady();
    fireReady();
    await tick();

    expect(environments.ensureManagedPluginEnvironment).toHaveBeenCalledTimes(1);
    expect(handle.off).toHaveBeenCalledTimes(1);
  });

  it("keeps recovery armed after a worker failure and stops after one success", async () => {
    const { handle, fireReady } = recoveryHandle();
    const ensureManagedPluginEnvironment = vi.fn()
      .mockRejectedValueOnce(new Error("worker crashed during environmentValidateConfig"))
      .mockResolvedValue({ environment: pluginEnvironmentRow(), action: "updated" });
    const environments = environmentsSeam({ ensureManagedPluginEnvironment });
    const manager = workerManager(false, handle);
    await applyManagedEnvironments(noDb, configWith([pluginEntry()]), {
      env: {},
      workerManager: manager,
      environments,
      instanceSettings: instanceSettingsSeam(),
      resolveEnvironmentPlugin: readyPlugin(),
      autoInstalledPluginKeys: [PLUGIN_KEY],
    });
    manager.isRunning.mockReturnValue(true);

    fireReady();
    await tick();
    expect(ensureManagedPluginEnvironment).toHaveBeenCalledTimes(1);
    expect(handle.off).not.toHaveBeenCalled();

    fireReady();
    await tick();
    expect(ensureManagedPluginEnvironment).toHaveBeenCalledTimes(2);
    expect(handle.off).toHaveBeenCalledTimes(1);

    fireReady();
    await tick();
    expect(ensureManagedPluginEnvironment).toHaveBeenCalledTimes(2);
  });

  it("queues one more attempt when the worker becomes ready during an attempt", async () => {
    const { handle, fireReady } = recoveryHandle();
    let failFirst!: (err: Error) => void;
    const ensureManagedPluginEnvironment = vi.fn()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { failFirst = reject; }))
      .mockResolvedValue({ environment: pluginEnvironmentRow(), action: "updated" });
    const manager = workerManager(false, handle);
    await applyManagedEnvironments(noDb, configWith([pluginEntry()]), {
      env: {},
      workerManager: manager,
      environments: environmentsSeam({ ensureManagedPluginEnvironment }),
      instanceSettings: instanceSettingsSeam(),
      resolveEnvironmentPlugin: readyPlugin(),
      autoInstalledPluginKeys: [PLUGIN_KEY],
    });
    manager.isRunning.mockReturnValue(true);

    fireReady();
    fireReady();
    expect(ensureManagedPluginEnvironment).toHaveBeenCalledTimes(1);
    failFirst(new Error("worker crashed"));
    await tick();
    await tick();
    expect(ensureManagedPluginEnvironment).toHaveBeenCalledTimes(2);
    expect(handle.off).toHaveBeenCalledTimes(1);
  });

  it("stops recovery when the plugin permanently rejects the config", async () => {
    const { handle, fireReady } = recoveryHandle();
    const ensureManagedPluginEnvironment = vi.fn().mockRejectedValue(unprocessable("driverConfig.region is not supported"));
    const manager = workerManager(false, handle);
    await applyManagedEnvironments(noDb, configWith([pluginEntry()]), {
      env: {},
      workerManager: manager,
      environments: environmentsSeam({ ensureManagedPluginEnvironment }),
      instanceSettings: instanceSettingsSeam(),
      resolveEnvironmentPlugin: readyPlugin(),
      autoInstalledPluginKeys: [PLUGIN_KEY],
    });
    manager.isRunning.mockReturnValue(true);

    fireReady();
    await tick();
    fireReady();
    await tick();
    expect(ensureManagedPluginEnvironment).toHaveBeenCalledTimes(1);
    expect(handle.off).toHaveBeenCalledTimes(1);
  });

  it("archives and arms recovery when the worker dies during the boot ensure", async () => {
    const { handle, fireReady } = recoveryHandle();
    const manager = workerManager(true, handle);
    const ensureManagedPluginEnvironment = vi.fn()
      .mockImplementationOnce(async () => {
        manager.isRunning.mockReturnValue(false);
        throw new Error("worker crashed during environmentValidateConfig");
      })
      .mockResolvedValue({ environment: pluginEnvironmentRow(), action: "updated" });
    const environments = environmentsSeam({ ensureManagedPluginEnvironment });
    const result = await applyManagedEnvironments(noDb, configWith([pluginEntry()]), {
      env: {},
      workerManager: manager,
      environments,
      instanceSettings: instanceSettingsSeam(),
      resolveEnvironmentPlugin: readyPlugin(),
      autoInstalledPluginKeys: [PLUGIN_KEY],
    });
    await tick();

    expect(result).toMatchObject({ ensured: 0, failed: 1 });
    expect(environments.archiveManagedPluginEnvironment).toHaveBeenCalledWith({ pluginKey: PLUGIN_KEY, driverKey: "tasks" });
    expect(ensureManagedPluginEnvironment).toHaveBeenCalledTimes(1);

    manager.isRunning.mockReturnValue(true);
    fireReady();
    await tick();
    expect(ensureManagedPluginEnvironment).toHaveBeenCalledTimes(2);
    expect(handle.off).toHaveBeenCalledTimes(1);
  });

  it("keeps the row and retries when the ensure fails while the worker keeps running", async () => {
    const { handle, fireReady } = recoveryHandle();
    const ensureManagedPluginEnvironment = vi.fn()
      .mockRejectedValueOnce(new Error("environmentValidateConfig timed out"))
      .mockRejectedValueOnce(new Error("environmentValidateConfig timed out"))
      .mockResolvedValue({ environment: pluginEnvironmentRow(), action: "unchanged" });
    const environments = environmentsSeam({ ensureManagedPluginEnvironment });
    const result = await applyManagedEnvironments(noDb, configWith([pluginEntry()]), {
      env: {},
      workerManager: workerManager(true, handle),
      environments,
      instanceSettings: instanceSettingsSeam(),
      resolveEnvironmentPlugin: readyPlugin(),
      autoInstalledPluginKeys: [PLUGIN_KEY],
    });
    await tick();

    expect(result).toMatchObject({ ensured: 0, failed: 1 });
    expect(environments.archiveManagedPluginEnvironment).not.toHaveBeenCalled();
    // The immediate retry also failed; the next `ready` succeeds.
    expect(ensureManagedPluginEnvironment).toHaveBeenCalledTimes(2);
    fireReady();
    await tick();
    expect(ensureManagedPluginEnvironment).toHaveBeenCalledTimes(3);
    expect(handle.off).toHaveBeenCalledTimes(1);
  });

  it("neither archives nor retries when the boot ensure gets a permanent config rejection", async () => {
    const { handle } = recoveryHandle();
    const environments = environmentsSeam({
      ensureManagedPluginEnvironment: vi.fn().mockRejectedValue(unprocessable("driverConfig.region is not supported")),
    });
    const manager = workerManager(true, handle);
    const result = await applyManagedEnvironments(noDb, configWith([pluginEntry()]), {
      env: {},
      workerManager: manager,
      environments,
      instanceSettings: instanceSettingsSeam(),
      resolveEnvironmentPlugin: readyPlugin(),
      autoInstalledPluginKeys: [PLUGIN_KEY],
    });
    expect(result).toMatchObject({ ensured: 0, failed: 1 });
    expect(environments.archiveManagedPluginEnvironment).not.toHaveBeenCalled();
    expect(manager.getWorker).not.toHaveBeenCalled();
  });

  it("keeps waiting through a restart that replaces the worker handle", async () => {
    // Manager-wide `ready` subscription: the worker handle is never consulted,
    // so a replacement handle's `ready` still reaches the listener.
    const readyListeners = new Set<(pluginId: string) => void>();
    const manager = {
      isRunning: vi.fn(() => false),
      call: vi.fn(),
      getWorker: vi.fn(() => undefined),
      onWorkerReady: vi.fn((listener: (pluginId: string) => void) => {
        readyListeners.add(listener);
        return () => { readyListeners.delete(listener); };
      }),
    };
    const environments = environmentsSeam();
    await applyManagedEnvironments(noDb, configWith([pluginEntry()]), {
      env: {},
      workerManager: manager,
      environments,
      instanceSettings: instanceSettingsSeam(),
      resolveEnvironmentPlugin: readyPlugin(),
      autoInstalledPluginKeys: [PLUGIN_KEY],
    });
    expect(manager.getWorker).not.toHaveBeenCalled();

    manager.isRunning.mockReturnValue(true);
    for (const listener of [...readyListeners]) listener("another-plugin");
    await tick();
    expect(environments.ensureManagedPluginEnvironment).not.toHaveBeenCalled();
    for (const listener of [...readyListeners]) listener("remote-host-plugin");
    await tick();
    expect(environments.ensureManagedPluginEnvironment).toHaveBeenCalledTimes(1);
    expect(readyListeners.size).toBe(0);
  });

  it("tracks recovery attempts as idle work and lets shutdown await and unsubscribe them", async () => {
    const { handle, fireReady } = recoveryHandle();
    let finishEnsure!: () => void;
    const ensureManagedPluginEnvironment = vi.fn(() => new Promise((resolve) => {
      finishEnsure = () => resolve({ environment: pluginEnvironmentRow(), action: "updated" });
    }));
    const recovery = createManagedEnvironmentRecovery();
    const manager = workerManager(false, handle);
    await applyManagedEnvironments(noDb, configWith([pluginEntry()]), {
      env: {},
      workerManager: manager,
      environments: environmentsSeam({ ensureManagedPluginEnvironment: ensureManagedPluginEnvironment as never }),
      instanceSettings: instanceSettingsSeam(),
      resolveEnvironmentPlugin: readyPlugin(),
      autoInstalledPluginKeys: [PLUGIN_KEY],
      recovery,
    });
    const idleBefore = idleWorkSnapshot().active;
    manager.isRunning.mockReturnValue(true);
    fireReady();
    expect(idleWorkSnapshot().active).toBe(idleBefore + 1);

    let stopped = false;
    const stopping = recovery.stop().then(() => { stopped = true; });
    await tick();
    expect(stopped).toBe(false);
    expect(handle.off).toHaveBeenCalled();
    finishEnsure();
    await stopping;
    expect(stopped).toBe(true);
    expect(idleWorkSnapshot().active).toBe(idleBefore);

    fireReady();
    await tick();
    expect(ensureManagedPluginEnvironment).toHaveBeenCalledTimes(1);
  });

  it("treats a missing plugin, a plugin without the driver, or a worker manager without call as unavailable", async () => {
    for (const [resolveEnvironmentPlugin, manager] of [
      [vi.fn(async () => null), workerManager()],
      [readyPlugin("ready", false), workerManager()],
      [readyPlugin("error"), workerManager()],
      [readyPlugin(), { isRunning: vi.fn(() => true), getWorker: vi.fn(() => undefined) }],
    ] as const) {
      const environments = environmentsSeam();
      const result = await applyManagedEnvironments(noDb, configWith([pluginEntry()]), {
        env: {},
        workerManager: manager,
        environments,
        instanceSettings: instanceSettingsSeam(),
        resolveEnvironmentPlugin,
        autoInstalledPluginKeys: [PLUGIN_KEY],
      });
      expect(result).toMatchObject({ ensured: 0, failed: 1 });
      expect(environments.archiveManagedPluginEnvironment).toHaveBeenCalledTimes(1);
      expect(environments.ensureManagedPluginEnvironment).not.toHaveBeenCalled();
      expect(manager.getWorker).not.toHaveBeenCalled();
    }
  });

  it("never archives a row whose entry was removed from the document", async () => {
    const environments = environmentsSeam();
    expect(await applyManagedEnvironments(noDb, configWith([]), {
      env: {},
      workerManager: workerManager(),
      environments,
      instanceSettings: instanceSettingsSeam(),
    })).toBeNull();
    expect(environments.archiveManagedPluginEnvironment).not.toHaveBeenCalled();
  });

  it("never changes the instance default, and the sandbox stamp never replaces a plugin default", async () => {
    const settings = instanceSettingsSeam({
      get: vi.fn().mockResolvedValue({ defaultEnvironmentId: "plugin-env" }) as InstanceSettingsSeam["get"],
    });
    await applyManagedEnvironments(noDb, configWith(
      [{ name: "Daytona", provider: "daytona" }, pluginEntry()],
      { enableManagedSandboxOnly: true },
    ), {
      env: {},
      workerManager: workerManager(),
      instanceSettings: settings,
      environments: environmentsSeam({ getById: vi.fn().mockResolvedValue(pluginEnvironmentRow()) }),
      resolveSandboxProviderDriver: readyDriverResolver(),
      resolveEnvironmentPlugin: readyPlugin(),
      autoInstalledPluginKeys: [PLUGIN_KEY],
    });
    expect(settings.update).not.toHaveBeenCalled();
  });

  describe("instanceDefault", () => {
    const decided = (status: "applied" | "declined" | "pending" | "already_decided" = "applied") =>
      vi.fn(async () => ({ status, reason: null, previousDefaultEnvironmentId: null }));
    const MARKER = `${PLUGIN_KEY}:tasks`;

    it("evaluates the default with the ensured row", async () => {
      const applyPluginInstanceDefault = decided();
      await applyManagedEnvironments(noDb, configWith([pluginEntry({ instanceDefault: true })]), {
        env: {},
        workerManager: workerManager(),
        environments: environmentsSeam(),
        instanceSettings: instanceSettingsSeam(),
        resolveEnvironmentPlugin: readyPlugin(),
        autoInstalledPluginKeys: [PLUGIN_KEY],
        applyPluginInstanceDefault,
      });
      expect(applyPluginInstanceDefault).toHaveBeenCalledWith({
        environment: expect.objectContaining({ id: "plugin-env", status: "active" }),
        marker: MARKER,
      });
    });

    it("does not evaluate a default for an entry without the flag", async () => {
      const applyPluginInstanceDefault = decided();
      await applyManagedEnvironments(noDb, configWith([pluginEntry()]), {
        env: {},
        workerManager: workerManager(),
        environments: environmentsSeam(),
        instanceSettings: instanceSettingsSeam(),
        resolveEnvironmentPlugin: readyPlugin(),
        autoInstalledPluginKeys: [PLUGIN_KEY],
        applyPluginInstanceDefault,
      });
      expect(applyPluginInstanceDefault).not.toHaveBeenCalled();
    });

    it("records the decision while the plugin is down, never with an active row, and re-evaluates on recovery", async () => {
      const { handle, fireReady } = recoveryHandle();
      const environments = environmentsSeam({
        findManagedPluginEnvironment: vi.fn().mockResolvedValue(pluginEnvironmentRow()),
      });
      const applyPluginInstanceDefault = decided("pending");
      const manager = workerManager(false, handle);
      await applyManagedEnvironments(noDb, configWith([pluginEntry({ instanceDefault: true })]), {
        env: {},
        workerManager: manager,
        environments,
        instanceSettings: instanceSettingsSeam(),
        resolveEnvironmentPlugin: readyPlugin(),
        autoInstalledPluginKeys: [PLUGIN_KEY],
        applyPluginInstanceDefault,
      });
      expect(applyPluginInstanceDefault).toHaveBeenCalledWith({
        environment: { id: "plugin-env", status: "unavailable" },
        marker: MARKER,
      });

      manager.isRunning.mockReturnValue(true);
      fireReady();
      await tick();
      expect(applyPluginInstanceDefault).toHaveBeenLastCalledWith({
        environment: expect.objectContaining({ id: "plugin-env", status: "active" }),
        marker: MARKER,
      });
    });

    it("records the decision when the boot ensure fails", async () => {
      const applyPluginInstanceDefault = decided("pending");
      await applyManagedEnvironments(noDb, configWith([pluginEntry({ instanceDefault: true })]), {
        env: {},
        workerManager: workerManager(),
        environments: environmentsSeam({
          ensureManagedPluginEnvironment: vi.fn().mockRejectedValue(unprocessable("driverConfig.region is not supported")),
        }),
        instanceSettings: instanceSettingsSeam(),
        resolveEnvironmentPlugin: readyPlugin(),
        autoInstalledPluginKeys: [PLUGIN_KEY],
        applyPluginInstanceDefault,
      });
      expect(applyPluginInstanceDefault).toHaveBeenCalledWith({ environment: null, marker: MARKER });
    });

    it("never lets the sandbox stamp or its revert path replace a plugin default", async () => {
      const settings = instanceSettingsSeam({
        get: vi.fn().mockResolvedValue({ defaultEnvironmentId: "plugin-env" }) as InstanceSettingsSeam["get"],
      });
      const getById = vi.fn().mockResolvedValue(pluginEnvironmentRow());
      await applyManagedEnvironments(noDb, configWith(
        [{ name: "Daytona", provider: "daytona" }, pluginEntry({ instanceDefault: true })],
        { enableManagedSandboxOnly: true },
      ), {
        env: {},
        workerManager: workerManager(),
        instanceSettings: settings,
        environments: environmentsSeam({ getById }),
        resolveSandboxProviderDriver: readyDriverResolver(),
        resolveEnvironmentPlugin: readyPlugin(),
        autoInstalledPluginKeys: [PLUGIN_KEY],
        applyPluginInstanceDefault: decided("already_decided"),
      });
      await applyManagedEnvironments(noDb, configWith([pluginEntry({ instanceDefault: true })]), {
        env: {},
        workerManager: workerManager(),
        instanceSettings: settings,
        environments: environmentsSeam({
          getById,
          findManagedSandboxEnvironment: vi.fn().mockResolvedValue(
            environmentRow({ metadata: { managedByPaperclip: true, managedDefaultStamped: true } }),
          ),
        }),
        resolveEnvironmentPlugin: readyPlugin(),
        autoInstalledPluginKeys: [PLUGIN_KEY],
        applyPluginInstanceDefault: decided("already_decided"),
      });
      expect(settings.update).not.toHaveBeenCalled();
    });

    it("registers the retry worker only for an instanceDefault entry, with a query-free pending check", async () => {
      const readyListeners = new Set<(pluginId: string) => void>();
      const manager = {
        isRunning: vi.fn(() => true),
        call: vi.fn(),
        onWorkerReady: vi.fn((listener: (pluginId: string) => void) => {
          readyListeners.add(listener);
          return () => { readyListeners.delete(listener); };
        }),
      };
      const wake = vi.fn();
      let task!: { retryMs: number; run: () => Promise<unknown>; hasPending: () => Promise<boolean> };
      const deliveryWork = { register: vi.fn((_queue: string, registered: typeof task) => { task = registered; return { wake }; }) };
      const recovery = createManagedEnvironmentRecovery();

      expect(registerManagedPluginInstanceDefaultRetry({
        db: noDb, managedConfig: configWith([pluginEntry()]), deliveryWork, workerManager: manager, recovery,
      })).toBeNull();
      expect(deliveryWork.register).not.toHaveBeenCalled();

      const worker = registerManagedPluginInstanceDefaultRetry({
        db: noDb,
        managedConfig: configWith([pluginEntry({ instanceDefault: true })]),
        deliveryWork,
        workerManager: manager,
        recovery,
      });
      expect(deliveryWork.register).toHaveBeenCalledWith("managed-environment-default", expect.objectContaining({ retryMs: 60_000 }));
      // Nothing requested: idle, and `run` touches nothing (the db is null here).
      expect(await task.hasPending()).toBe(false);
      await task.run();

      // A worker start asks for an attempt; so does a failed inline decision.
      for (const listener of [...readyListeners]) listener("remote-host-plugin");
      expect(wake).toHaveBeenCalledTimes(1);
      expect(await task.hasPending()).toBe(true);
      worker!.requestRetry();
      expect(wake).toHaveBeenCalledTimes(2);

      // A throwing attempt keeps the request, so the coordinator retries it.
      await expect(task.run()).rejects.toThrow();
      expect(await task.hasPending()).toBe(true);

      await recovery.stop();
      expect(readyListeners.size).toBe(0);
    });

    it("hands a retry requested before registration to the new worker", async () => {
      let task!: { hasPending: () => Promise<boolean> };
      const deliveryWork = { register: vi.fn((_queue: string, registered: typeof task) => { task = registered; return { wake: vi.fn() }; }) };
      registerManagedPluginInstanceDefaultRetry({
        db: noDb,
        managedConfig: configWith([pluginEntry({ instanceDefault: true })]),
        deliveryWork: deliveryWork as never,
        recovery: createManagedEnvironmentRecovery(),
        requested: true,
      });
      expect(await task.hasPending()).toBe(true);
    });

    it("keeps an ensure counted and asks the retry worker for a failed default decision", async () => {
      const requestInstanceDefaultRetry = vi.fn();
      const result = await applyManagedEnvironments(noDb, configWith([pluginEntry({ instanceDefault: true })]), {
        env: {},
        workerManager: workerManager(),
        environments: environmentsSeam(),
        instanceSettings: instanceSettingsSeam(),
        resolveEnvironmentPlugin: readyPlugin(),
        autoInstalledPluginKeys: [PLUGIN_KEY],
        applyPluginInstanceDefault: vi.fn().mockRejectedValue(new Error("db exploded")),
        requestInstanceDefaultRetry,
      });
      expect(result).toMatchObject({ ensured: 1, failed: 0 });
      expect(requestInstanceDefaultRetry).toHaveBeenCalledTimes(1);
    });
  });

  it("is fail-safe: an ensure failure is logged and counted, not thrown", async () => {
    const result = await applyManagedEnvironments(noDb, configWith([pluginEntry()]), {
      env: {},
      workerManager: workerManager(),
      environments: environmentsSeam({
        ensureManagedPluginEnvironment: vi.fn().mockRejectedValue(new Error("validator refused")),
      }),
      instanceSettings: instanceSettingsSeam(),
      resolveEnvironmentPlugin: readyPlugin(),
      autoInstalledPluginKeys: [PLUGIN_KEY],
    });
    expect(result).toMatchObject({ ensured: 0, failed: 1 });
  });
});
