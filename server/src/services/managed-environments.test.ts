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

function environmentsSeam(overrides: Partial<EnvironmentsSeam> = {}): EnvironmentsSeam {
  return {
    ensureManagedSandboxEnvironment:
      overrides.ensureManagedSandboxEnvironment ?? vi.fn().mockResolvedValue(environmentRow()),
    archiveManagedSandboxEnvironment:
      overrides.archiveManagedSandboxEnvironment ?? vi.fn().mockResolvedValue(null),
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
      .mockResolvedValue(environmentRow());
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
      environments: environmentsSeam({ ensureManagedSandboxEnvironment }),
      resolveSandboxProviderDriver,
    });

    expect(result).toEqual({ ensured: 1, failed: 0 });
    expect(resolveSandboxProviderDriver).toHaveBeenCalledWith({ db: noDb, driverKey: "daytona" });
    expect(workerManager.isRunning).toHaveBeenCalledWith("plugin-1");
    expect(ensureManagedSandboxEnvironment).toHaveBeenCalledTimes(1);
    expect(ensureManagedSandboxEnvironment).toHaveBeenCalledWith({
      name: "Daytona",
      description: "Managed Daytona sandbox.",
      provider: "daytona",
      config: { target: "us" },
    });
    // The frozen parsed config must not leak into the service (the row's
    // config is mutated downstream when the provider key is forced in).
    const passedConfig = ensureManagedSandboxEnvironment.mock.calls[0]?.[0]?.config;
    expect(Object.isFrozen(passedConfig)).toBe(false);
  });

  it("waits for the bundled-plugin startup pass before ensuring anything", async () => {
    const ensureManagedSandboxEnvironment = vi
      .fn()
      .mockResolvedValue(environmentRow());
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
      environments: environmentsSeam({ ensureManagedSandboxEnvironment }),
      resolveSandboxProviderDriver: readyDriverResolver(),
    });

    // Give the ensure every chance to (incorrectly) run early.
    await new Promise((resolve) => setImmediate(resolve));
    expect(ensureManagedSandboxEnvironment).not.toHaveBeenCalled();

    releasePlugins();
    expect(await pending).toEqual({ ensured: 1, failed: 0 });
    expect(ensureManagedSandboxEnvironment).toHaveBeenCalledTimes(1);
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

    expect(result).toEqual({ ensured: 0, failed: 1 });
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

    expect(result).toEqual({ ensured: 0, failed: 1 });
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

    expect(result).toEqual({ ensured: 0, failed: 1 });
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
    expect(result).toEqual({ ensured: 0, failed: 1 });
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

    expect(result).toEqual({ ensured: 0, failed: 1 });
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

    expect(result).toEqual({ ensured: 0, failed: 1 });
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

    expect(result).toEqual({ ensured: 0, failed: 1 });
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

    expect(result).toEqual({ ensured: 0, failed: 1 });
    expect(environments.archiveManagedSandboxEnvironment).not.toHaveBeenCalled();
  });
});
