/**
 * Shared fixtures and service seams for the `applyManagedEnvironments` tests
 * (`managed-environments.test.ts` for the sandbox entry and instance default,
 * `managed-environments-plugin-entries.test.ts` for plugin entries).
 */
import { vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { MANAGED_CONFIG_ENV_KEY, parseManagedConfigEnv } from "./managed-config.js";
import type { ApplyManagedEnvironmentsOptions } from "./managed-environments.js";

export const noDb = null as unknown as Db;

export function parsedConfig(overrides: Record<string, unknown> = {}) {
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

export function environmentRow(overrides: Record<string, unknown> = {}) {
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

export function reconciliationResult(
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

export function readyDriverResolver(status = "ready") {
  return vi.fn(async () => ({
    plugin: { id: "plugin-1", pluginKey: "sandbox-providers/daytona", status },
  }));
}

export function runningWorkerManager(running = true) {
  return { isRunning: vi.fn(() => running), getWorker: vi.fn(() => undefined) };
}

export type WorkerManagerSeam = NonNullable<ApplyManagedEnvironmentsOptions["workerManager"]>;
export type RecoveryHandle = NonNullable<ReturnType<WorkerManagerSeam["getWorker"]>>;

/** A worker handle fake that records `ready` listeners so tests can fire them. */
export function recoveryHandle() {
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
export function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

export type EnvironmentsSeam = NonNullable<ApplyManagedEnvironmentsOptions["environments"]>;
export type InstanceSettingsSeam = NonNullable<ApplyManagedEnvironmentsOptions["instanceSettings"]>;

export function environmentsSeam(overrides: Partial<EnvironmentsSeam> = {}): EnvironmentsSeam {
  return {
    ensureManagedSandboxEnvironment:
      overrides.ensureManagedSandboxEnvironment ?? vi.fn().mockResolvedValue(reconciliationResult()),
    archiveManagedSandboxEnvironment:
      overrides.archiveManagedSandboxEnvironment ?? vi.fn().mockResolvedValue(null),
    getById: overrides.getById ?? vi.fn().mockResolvedValue(null),
    update: overrides.update ?? vi.fn().mockResolvedValue(environmentRow()),
    findManagedSandboxEnvironment:
      overrides.findManagedSandboxEnvironment ?? vi.fn().mockResolvedValue(null),
    ensureManagedPluginEnvironment:
      overrides.ensureManagedPluginEnvironment
      ?? vi.fn().mockResolvedValue({ environment: pluginEnvironmentRow(), action: "added" }),
    archiveManagedPluginEnvironment:
      overrides.archiveManagedPluginEnvironment ?? vi.fn().mockResolvedValue(null),
  };
}

export const PLUGIN_KEY = "example.remote-host-plugin";

export function pluginEnvironmentRow(overrides: Record<string, unknown> = {}) {
  return environmentRow({
    id: "plugin-env",
    name: "Remote Host",
    driver: "plugin",
    config: { pluginKey: PLUGIN_KEY, driverKey: "tasks", driverConfig: {} },
    metadata: { managedByPaperclip: true, managedPluginEnvironment: `${PLUGIN_KEY}:tasks` },
    ...overrides,
  }) as never;
}

export function instanceSettingsSeam(overrides: Partial<InstanceSettingsSeam> = {}): InstanceSettingsSeam {
  return {
    get:
      overrides.get ??
      (vi.fn().mockResolvedValue({ defaultEnvironmentId: null }) as InstanceSettingsSeam["get"]),
    update:
      overrides.update ??
      (vi.fn().mockResolvedValue({ defaultEnvironmentId: "env-1" }) as InstanceSettingsSeam["update"]),
  };
}
