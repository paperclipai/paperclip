import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { MANAGED_CONFIG_ENV_KEY, parseManagedConfigEnv } from "./managed-config.js";
import {
  applyManagedEnvironments,
  type ApplyManagedEnvironmentsOptions,
} from "./managed-environments.js";

const noDb = null as unknown as Db;

function parsedConfig(overrides: Record<string, unknown> = {}) {
  const config = parseManagedConfigEnv({
    [MANAGED_CONFIG_ENV_KEY]: JSON.stringify({
      v: 1,
      mode: "cloud",
      catalogVersion: "2026.720.0",
      features: {},
      plugins: { autoInstall: ["daytona"] },
      ...overrides,
    }),
  });
  if (!config) throw new Error("expected a parsed managed config");
  return config;
}

function environmentRow(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    id: "env-1",
    name: "Daytona",
    description: null,
    driver: "sandbox",
    status: "active",
    config: {},
    envVars: {},
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function reconciliationResult(
  overrides: Record<string, unknown> = {},
) {
  return {
    environment: environmentRow(),
    action: "added" as const,
    stockStatus: "missing" as const,
    updateAvailable: false,
    stockHash: "sha256:stock",
    ...overrides,
  };
}

function readyDriverResolver(status = "ready") {
  return vi.fn(async () => ({
    plugin: { id: "plugin-1", pluginKey: "sandbox-providers/daytona", status },
  }));
}

function runningWorkerManager(running = true) {
  return { isRunning: vi.fn(() => running), getWorker: vi.fn(() => undefined) };
}

type WorkerManagerSeam = NonNullable<ApplyManagedEnvironmentsOptions["workerManager"]>;
type RecoveryHandle = NonNullable<ReturnType<WorkerManagerSeam["getWorker"]>>;

/** A worker handle fake that records `ready` listeners so tests can fire them. */
function recoveryHandle() {
  const readyListeners: Array<(payload: { pluginId: string }) => void> = [];
  const handle: RecoveryHandle = {
    on: vi.fn((_event, listener) => {
      readyListeners.push(listener);
    }),
    off: vi.fn((_event, listener) => {
      const at = readyListeners.indexOf(listener);
      if (at !== -1) readyListeners.splice(at, 1);
    }),
  };
  return {
    handle,
    fireReady: () => {
      for (const listener of [...readyListeners]) listener({ pluginId: "plugin-1" });
    },
  };
}

/** Lets the fire-and-forget recovery ensure settle. */
function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

type EnvironmentsSeam = NonNullable<ApplyManagedEnvironmentsOptions["environments"]>;
type InstanceSettingsSeam = NonNullable<ApplyManagedEnvironmentsOptions["instanceSettings"]>;

function environmentsSeam(overrides: Partial<EnvironmentsSeam> = {}): EnvironmentsSeam {
  return {
    ensureManagedSandboxEnvironment:
      overrides.ensureManagedSandboxEnvironment ?? vi.fn().mockResolvedValue(reconciliationResult()),
    archiveManagedSandboxEnvironment:
      overrides.archiveManagedSandboxEnvironment ?? vi.fn().mockResolvedValue(null),
    getById: overrides.getById ?? vi.fn().mockResolvedValue(null),
    update: overrides.update ?? vi.fn().mockResolvedValue(environmentRow()),
    findManagedSandboxEnvironment:
      overrides.findManagedSandboxEnvironment ?? vi.fn().mockResolvedValue(null),
  };
}

function instanceSettingsSeam(overrides: Partial<InstanceSettingsSeam> = {}): InstanceSettingsSeam {
  return {
    get:
      overrides.get ??
      (vi.fn().mockResolvedValue({ defaultEnvironmentId: null }) as InstanceSettingsSeam["get"]),
    update:
      overrides.update ??
      (vi.fn().mockResolvedValue({ defaultEnvironmentId: "env-1" }) as InstanceSettingsSeam["update"]),
  };
}

describe("applyManagedEnvironments", () => {
  it("no-ops for self-hosted instances and for documents without environments", async () => {
    expect(await applyManagedEnvironments(noDb, null)).toBeNull();
    expect(await applyManagedEnvironments(noDb, parsedConfig())).toBeNull();
  });

  it("refuses startup when a forced execution mode also claims the managed sandbox slot", async () => {
    const config = parsedConfig({
      environments: [{ name: "Daytona", provider: "daytona" }],
    });
    await expect(
      applyManagedEnvironments(noDb, config, {
        env: { PAPERCLIP_EXECUTION_MODE: "kubernetes" },
      }),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it("ensures each declared environment through the provider-agnostic service call", async () => {
    const ensureManagedSandboxEnvironment = vi
      .fn()
      .mockResolvedValue(reconciliationResult());
    const config = parsedConfig({
      environments: [
        {
          name: "Daytona",
          description: "Managed Daytona sandbox.",
          provider: "daytona",
          config: { target: "us" },
        },
      ],
    });

    const resolveSandboxProviderDriver = readyDriverResolver();
    const workerManager = runningWorkerManager();
    const result = await applyManagedEnvironments(noDb, config, {
      env: {},
      workerManager,
      instanceSettings: instanceSettingsSeam(),
      environments: environmentsSeam({ ensureManagedSandboxEnvironment }),
      resolveSandboxProviderDriver,
    });

    expect(result).toMatchObject({ ensured: 1, failed: 0, added: 1, skipped: 0 });
    expect(result).toMatchObject({ removed: 0, backedUp: 0 });
    expect(resolveSandboxProviderDriver).toHaveBeenCalledWith({ db: noDb, driverKey: "daytona" });
    expect(workerManager.isRunning).toHaveBeenCalledWith("plugin-1");
    expect(ensureManagedSandboxEnvironment).toHaveBeenCalledTimes(1);
    expect(ensureManagedSandboxEnvironment).toHaveBeenCalledWith({
      name: "Daytona",
      description: "Managed Daytona sandbox.",
      provider: "daytona",
      config: { target: "us" },
      stockVersion: "2026.720.0",
    });
    // The frozen parsed config must not leak into the service (the row's
    // config is mutated downstream when the provider key is forced in).
    const passedConfig = ensureManagedSandboxEnvironment.mock.calls[0]?.[0]?.config;
    expect(Object.isFrozen(passedConfig)).toBe(false);
  });

  it("waits for the bundled-plugin startup pass before ensuring anything", async () => {
    const ensureManagedSandboxEnvironment = vi
      .fn()
      .mockResolvedValue(reconciliationResult());
    const config = parsedConfig({
      environments: [{ name: "Daytona", provider: "daytona" }],
    });

    let releasePlugins!: () => void;
    const pluginsReady = new Promise<void>((resolve) => {
      releasePlugins = resolve;
    });

    const pending = applyManagedEnvironments(noDb, config, {
      env: {},
      pluginsReady,
      workerManager: runningWorkerManager(),
      instanceSettings: instanceSettingsSeam(),
      environments: environmentsSeam({ ensureManagedSandboxEnvironment }),
      resolveSandboxProviderDriver: readyDriverResolver(),
    });

    // Give the ensure every chance to (incorrectly) run early.
    await new Promise((resolve) => setImmediate(resolve));
    expect(ensureManagedSandboxEnvironment).not.toHaveBeenCalled();

    releasePlugins();
    expect(await pending).toMatchObject({ ensured: 1, failed: 0, added: 1 });
    expect(ensureManagedSandboxEnvironment).toHaveBeenCalledTimes(1);
  });

  it("reports operator-modified rows as skipped with a stock update still available", async () => {
    const environments = environmentsSeam({
      ensureManagedSandboxEnvironment: vi.fn().mockResolvedValue(reconciliationResult({
        action: "skipped",
        stockStatus: "operator_modified",
        updateAvailable: true,
      })),
    });
    const result = await applyManagedEnvironments(noDb, parsedConfig({
      environments: [{ name: "Daytona", provider: "daytona" }],
    }), {
      env: {},
      workerManager: runningWorkerManager(),
      environments,
      resolveSandboxProviderDriver: readyDriverResolver(),
    });

    expect(result).toMatchObject({
      ensured: 0,
      failed: 0,
      added: 0,
      updated: 0,
      unchanged: 0,
      skipped: 1,
      outcomes: [{
        action: "skipped",
        stockStatus: "operator_modified",
        updateAvailable: true,
      }],
    });
  });

  it("skips an entry whose provider plugin is missing and archives its stale row", async () => {
    const environments = environmentsSeam({
      archiveManagedSandboxEnvironment: vi.fn().mockResolvedValue(environmentRow({ status: "archived" })),
    });
    const config = parsedConfig({
      environments: [{ name: "Daytona", provider: "daytona" }],
    });

    const result = await applyManagedEnvironments(noDb, config, {
      env: {},
      workerManager: runningWorkerManager(),
      environments,
      resolveSandboxProviderDriver: vi.fn(async () => null),
    });

    expect(result).toMatchObject({ ensured: 0, failed: 1 });
    expect(environments.ensureManagedSandboxEnvironment).not.toHaveBeenCalled();
    expect(environments.archiveManagedSandboxEnvironment).toHaveBeenCalledWith({
      provider: "daytona",
    });
  });

  it("skips (and counts failed) an entry whose provider plugin is not ready", async () => {
    const environments = environmentsSeam();
    const config = parsedConfig({
      environments: [{ name: "Daytona", provider: "daytona" }],
    });

    const result = await applyManagedEnvironments(noDb, config, {
      env: {},
      workerManager: runningWorkerManager(),
      environments,
      resolveSandboxProviderDriver: readyDriverResolver("disabled"),
    });

    expect(result).toMatchObject({ ensured: 0, failed: 1 });
    expect(environments.ensureManagedSandboxEnvironment).not.toHaveBeenCalled();
    expect(environments.archiveManagedSandboxEnvironment).toHaveBeenCalledWith({
      provider: "daytona",
    });
  });

  it("skips an entry whose plugin record is ready but whose worker is not running", async () => {
    const environments = environmentsSeam();
    const config = parsedConfig({
      environments: [{ name: "Daytona", provider: "daytona" }],
    });

    const workerManager = runningWorkerManager(false);
    const result = await applyManagedEnvironments(noDb, config, {
      env: {},
      workerManager,
      environments,
      resolveSandboxProviderDriver: readyDriverResolver(),
    });

    expect(result).toMatchObject({ ensured: 0, failed: 1 });
    expect(workerManager.isRunning).toHaveBeenCalledWith("plugin-1");
    expect(environments.ensureManagedSandboxEnvironment).not.toHaveBeenCalled();
    expect(environments.archiveManagedSandboxEnvironment).toHaveBeenCalledWith({
      provider: "daytona",
    });
    // No registered handle → no respawn is coming; degraded until next boot.
    expect(workerManager.getWorker).toHaveBeenCalledWith("plugin-1");
  });

  it("reactivates the archived environment once when the provider worker recovers", async () => {
    const environments = environmentsSeam();
    const config = parsedConfig({
      environments: [
        { name: "Daytona", provider: "daytona", config: { target: "us" } },
      ],
    });

    const { handle, fireReady } = recoveryHandle();
    const workerManager = {
      isRunning: vi.fn(() => false),
      getWorker: vi.fn(() => handle),
    };
    const result = await applyManagedEnvironments(noDb, config, {
      env: {},
      workerManager,
      environments,
      resolveSandboxProviderDriver: readyDriverResolver(),
    });

    // The boot pass itself stays degraded: archived, counted failed.
    expect(result).toMatchObject({ ensured: 0, failed: 1 });
    expect(environments.archiveManagedSandboxEnvironment).toHaveBeenCalledWith({
      provider: "daytona",
    });
    expect(environments.ensureManagedSandboxEnvironment).not.toHaveBeenCalled();

    // Worker manager respawns the worker → the handle re-emits `ready`.
    fireReady();
    fireReady();
    await tick();

    expect(environments.ensureManagedSandboxEnvironment).toHaveBeenCalledTimes(1);
    expect(environments.ensureManagedSandboxEnvironment).toHaveBeenCalledWith({
      name: "Daytona",
      description: undefined,
      provider: "daytona",
      config: { target: "us" },
      stockVersion: "2026.720.0",
    });
    expect(handle.off).toHaveBeenCalledTimes(1);
  });

  it("re-checks isRunning after subscribing so a recovery during the archive is not missed", async () => {
    const environments = environmentsSeam();
    const config = parsedConfig({
      environments: [{ name: "Daytona", provider: "daytona" }],
    });

    const { handle } = recoveryHandle();
    // Down at the gate check, already back up by the time the listener is
    // registered — the `ready` event has been missed.
    const workerManager = {
      isRunning: vi
        .fn()
        .mockReturnValueOnce(false)
        .mockReturnValue(true),
      getWorker: vi.fn(() => handle),
    };
    const result = await applyManagedEnvironments(noDb, config, {
      env: {},
      workerManager,
      environments,
      resolveSandboxProviderDriver: readyDriverResolver(),
    });
    await tick();

    expect(result).toMatchObject({ ensured: 0, failed: 1 });
    expect(environments.ensureManagedSandboxEnvironment).toHaveBeenCalledTimes(1);
  });

  it("does not subscribe for recovery when the plugin record is missing or not ready", async () => {
    const config = parsedConfig({
      environments: [{ name: "Daytona", provider: "daytona" }],
    });

    for (const resolveSandboxProviderDriver of [
      vi.fn(async () => null),
      readyDriverResolver("disabled"),
    ]) {
      const workerManager = runningWorkerManager(false);
      await applyManagedEnvironments(noDb, config, {
        env: {},
        workerManager,
        instanceSettings: instanceSettingsSeam(),
      environments: environmentsSeam(),
        resolveSandboxProviderDriver,
      });
      expect(workerManager.getWorker).not.toHaveBeenCalled();
    }
  });

  it("logs, not throws, when the recovery re-ensure fails", async () => {
    const environments = environmentsSeam({
      ensureManagedSandboxEnvironment: vi.fn().mockRejectedValue(new Error("db exploded")),
    });
    const config = parsedConfig({
      environments: [{ name: "Daytona", provider: "daytona" }],
    });

    const { handle, fireReady } = recoveryHandle();
    const workerManager = {
      isRunning: vi.fn(() => false),
      getWorker: vi.fn(() => handle),
    };
    await applyManagedEnvironments(noDb, config, {
      env: {},
      workerManager,
      environments,
      resolveSandboxProviderDriver: readyDriverResolver(),
    });

    fireReady();
    await tick();
    // The rejection is swallowed into a log line; reaching this point without
    // an unhandled rejection is the assertion.
    expect(environments.ensureManagedSandboxEnvironment).toHaveBeenCalledTimes(1);
  });

  it("fails closed when no worker manager is provided", async () => {
    const environments = environmentsSeam();
    const config = parsedConfig({
      environments: [{ name: "Daytona", provider: "daytona" }],
    });

    const result = await applyManagedEnvironments(noDb, config, {
      env: {},
      environments,
      resolveSandboxProviderDriver: readyDriverResolver(),
    });

    expect(result).toMatchObject({ ensured: 0, failed: 1 });
    expect(environments.ensureManagedSandboxEnvironment).not.toHaveBeenCalled();
  });

  it("counts a skipped entry once even when archiving its stale row fails", async () => {
    const environments = environmentsSeam({
      archiveManagedSandboxEnvironment: vi.fn().mockRejectedValue(new Error("db exploded")),
    });
    const config = parsedConfig({
      environments: [{ name: "Daytona", provider: "daytona" }],
    });

    const result = await applyManagedEnvironments(noDb, config, {
      env: {},
      workerManager: runningWorkerManager(),
      environments,
      resolveSandboxProviderDriver: vi.fn(async () => null),
    });

    expect(result).toMatchObject({ ensured: 0, failed: 1 });
    expect(environments.archiveManagedSandboxEnvironment).toHaveBeenCalledTimes(1);
  });

  it("is fail-safe per entry: an ensure failure is counted, not thrown", async () => {
    const environments = environmentsSeam({
      ensureManagedSandboxEnvironment: vi.fn().mockRejectedValue(new Error("db exploded")),
    });
    const config = parsedConfig({
      environments: [{ name: "Daytona", provider: "daytona" }],
    });

    const result = await applyManagedEnvironments(noDb, config, {
      env: {},
      workerManager: runningWorkerManager(),
      environments,
      resolveSandboxProviderDriver: readyDriverResolver(),
    });

    expect(result).toMatchObject({ ensured: 0, failed: 1 });
    expect(environments.archiveManagedSandboxEnvironment).not.toHaveBeenCalled();
  });

  it("points an unset instance default at the managed sandbox environment", async () => {
    const instanceSettings = instanceSettingsSeam();
    const config = parsedConfig({
      features: { enableManagedSandboxOnly: true },
      environments: [{ name: "Daytona", provider: "daytona" }],
    });

    await applyManagedEnvironments(noDb, config, {
      env: {},
      workerManager: runningWorkerManager(),
      instanceSettings,
      environments: environmentsSeam(),
      resolveSandboxProviderDriver: readyDriverResolver(),
    });

    expect(instanceSettings.update).toHaveBeenCalledWith({ defaultEnvironmentId: "env-1" });
  });

  it("records the stamp marker on the managed row so a revert is attributable", async () => {
    const instanceSettings = instanceSettingsSeam();
    const environments = environmentsSeam();
    const config = parsedConfig({
      features: { enableManagedSandboxOnly: true },
      environments: [{ name: "Daytona", provider: "daytona" }],
    });

    await applyManagedEnvironments(noDb, config, {
      env: {},
      workerManager: runningWorkerManager(),
      instanceSettings,
      environments,
      resolveSandboxProviderDriver: readyDriverResolver(),
    });

    expect(environments.update).toHaveBeenCalledWith("env-1", {
      metadata: expect.objectContaining({ managedDefaultStamped: true }),
    });
  });

  it("moves a local (or dangling) instance default onto the managed sandbox environment", async () => {
    const localDefault = instanceSettingsSeam({
      get: vi.fn().mockResolvedValue({ defaultEnvironmentId: "env-local" }) as InstanceSettingsSeam["get"],
    });
    const config = parsedConfig({
      features: { enableManagedSandboxOnly: true },
      environments: [{ name: "Daytona", provider: "daytona" }],
    });

    await applyManagedEnvironments(noDb, config, {
      env: {},
      workerManager: runningWorkerManager(),
      instanceSettings: localDefault,
      environments: environmentsSeam({
        getById: vi.fn().mockResolvedValue(environmentRow({ id: "env-local", driver: "local" })),
      }),
      resolveSandboxProviderDriver: readyDriverResolver(),
    });
    expect(localDefault.update).toHaveBeenCalledWith({ defaultEnvironmentId: "env-1" });

    // A default pointing at a deleted row is repaired the same way.
    const danglingDefault = instanceSettingsSeam({
      get: vi.fn().mockResolvedValue({ defaultEnvironmentId: "env-gone" }) as InstanceSettingsSeam["get"],
    });
    await applyManagedEnvironments(noDb, config, {
      env: {},
      workerManager: runningWorkerManager(),
      instanceSettings: danglingDefault,
      environments: environmentsSeam({ getById: vi.fn().mockResolvedValue(null) }),
      resolveSandboxProviderDriver: readyDriverResolver(),
    });
    expect(danglingDefault.update).toHaveBeenCalledWith({ defaultEnvironmentId: "env-1" });
  });

  it("leaves the instance default alone while managed-sandbox-only is not declared", async () => {
    // Without the mode, local execution is a legitimate default; provisioning
    // the managed environment must not silently move runs into the sandbox.
    const instanceSettings = instanceSettingsSeam();
    const config = parsedConfig({
      environments: [{ name: "Daytona", provider: "daytona" }],
    });

    await applyManagedEnvironments(noDb, config, {
      env: {},
      workerManager: runningWorkerManager(),
      instanceSettings,
      environments: environmentsSeam(),
      resolveSandboxProviderDriver: readyDriverResolver(),
    });

    expect(instanceSettings.update).not.toHaveBeenCalled();
  });

  it("reverts a stamped managed default when managed-sandbox-only turns off", async () => {
    // Turning the mode off must not keep routing default-following runs
    // into the sandbox off the stale stamp — even when the document no
    // longer declares any environments or the row was archived, which
    // skip per-entry reconciliation entirely. Only a default pointing at
    // the managed row AND carrying the reconciliation stamp reverts.
    const stampedRow = environmentRow({
      status: "archived",
      metadata: { managedByPaperclip: true, managedDefaultStamped: true },
    });
    const stamped = instanceSettingsSeam({
      get: vi.fn().mockResolvedValue({ defaultEnvironmentId: "env-1" }) as InstanceSettingsSeam["get"],
    });
    const stampedEnvironments = environmentsSeam({
      findManagedSandboxEnvironment: vi.fn().mockResolvedValue(stampedRow),
    });
    // No environments declaration at all: the cleanup must still run.
    const config = parsedConfig({});

    await applyManagedEnvironments(noDb, config, {
      env: {},
      workerManager: runningWorkerManager(),
      instanceSettings: stamped,
      environments: stampedEnvironments,
      resolveSandboxProviderDriver: readyDriverResolver(),
    });
    expect(stampedEnvironments.findManagedSandboxEnvironment).toHaveBeenCalledWith(undefined, {
      includeArchived: true,
    });
    expect(stamped.update).toHaveBeenCalledWith({ defaultEnvironmentId: null });
    // The marker clears with the revert so a later deliberate tenant
    // selection of the managed row is never mistaken for a stamp.
    expect(stampedEnvironments.update).toHaveBeenCalledWith("env-1", {
      metadata: { managedByPaperclip: true },
    });

    // The tenant's own deliberate managed-row default (no stamp marker)
    // survives the mode turning off.
    const tenantManagedDefault = instanceSettingsSeam({
      get: vi.fn().mockResolvedValue({ defaultEnvironmentId: "env-1" }) as InstanceSettingsSeam["get"],
    });
    const unmarkedEnvironments = environmentsSeam({
      findManagedSandboxEnvironment: vi.fn().mockResolvedValue(
        environmentRow({ metadata: { managedByPaperclip: true } }),
      ),
    });
    await applyManagedEnvironments(noDb, config, {
      env: {},
      workerManager: runningWorkerManager(),
      instanceSettings: tenantManagedDefault,
      environments: unmarkedEnvironments,
      resolveSandboxProviderDriver: readyDriverResolver(),
    });
    expect(tenantManagedDefault.update).not.toHaveBeenCalled();
  });

  it("never overrides a tenant-chosen custom default environment", async () => {
    const instanceSettings = instanceSettingsSeam({
      get: vi.fn().mockResolvedValue({ defaultEnvironmentId: "env-ssh" }) as InstanceSettingsSeam["get"],
    });
    const config = parsedConfig({
      features: { enableManagedSandboxOnly: true },
      environments: [{ name: "Daytona", provider: "daytona" }],
    });

    await applyManagedEnvironments(noDb, config, {
      env: {},
      workerManager: runningWorkerManager(),
      instanceSettings,
      environments: environmentsSeam({
        getById: vi.fn().mockResolvedValue(environmentRow({ id: "env-ssh", driver: "ssh" })),
      }),
      resolveSandboxProviderDriver: readyDriverResolver(),
    });

    expect(instanceSettings.update).not.toHaveBeenCalled();
  });
});
