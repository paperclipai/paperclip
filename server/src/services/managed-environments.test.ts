import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { MANAGED_CONFIG_ENV_KEY, parseManagedConfigEnv } from "./managed-config.js";
import { applyManagedEnvironments } from "./managed-environments.js";

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
    plugin: { pluginKey: "sandbox-providers/daytona", status },
  }));
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
    const result = await applyManagedEnvironments(noDb, config, {
      env: {},
      environments: { ensureManagedSandboxEnvironment },
      resolveSandboxProviderDriver,
    });

    expect(result).toEqual({ ensured: 1, failed: 0 });
    expect(resolveSandboxProviderDriver).toHaveBeenCalledWith({ db: noDb, driverKey: "daytona" });
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
      environments: { ensureManagedSandboxEnvironment },
      resolveSandboxProviderDriver: readyDriverResolver(),
    });

    // Give the ensure every chance to (incorrectly) run early.
    await new Promise((resolve) => setImmediate(resolve));
    expect(ensureManagedSandboxEnvironment).not.toHaveBeenCalled();

    releasePlugins();
    expect(await pending).toEqual({ ensured: 1, failed: 0 });
    expect(ensureManagedSandboxEnvironment).toHaveBeenCalledTimes(1);
  });

  it("skips (and counts failed) an entry whose provider plugin is missing", async () => {
    const ensureManagedSandboxEnvironment = vi
      .fn()
      .mockResolvedValue(environmentRow());
    const config = parsedConfig({
      environments: [{ name: "Daytona", provider: "daytona" }],
    });

    const result = await applyManagedEnvironments(noDb, config, {
      env: {},
      environments: { ensureManagedSandboxEnvironment },
      resolveSandboxProviderDriver: vi.fn(async () => null),
    });

    expect(result).toEqual({ ensured: 0, failed: 1 });
    expect(ensureManagedSandboxEnvironment).not.toHaveBeenCalled();
  });

  it("skips (and counts failed) an entry whose provider plugin is not ready", async () => {
    const ensureManagedSandboxEnvironment = vi
      .fn()
      .mockResolvedValue(environmentRow());
    const config = parsedConfig({
      environments: [{ name: "Daytona", provider: "daytona" }],
    });

    const result = await applyManagedEnvironments(noDb, config, {
      env: {},
      environments: { ensureManagedSandboxEnvironment },
      resolveSandboxProviderDriver: readyDriverResolver("disabled"),
    });

    expect(result).toEqual({ ensured: 0, failed: 1 });
    expect(ensureManagedSandboxEnvironment).not.toHaveBeenCalled();
  });

  it("is fail-safe per entry: an ensure failure is counted, not thrown", async () => {
    const ensureManagedSandboxEnvironment = vi
      .fn()
      .mockRejectedValue(new Error("db exploded"));
    const config = parsedConfig({
      environments: [{ name: "Daytona", provider: "daytona" }],
    });

    const result = await applyManagedEnvironments(noDb, config, {
      env: {},
      environments: { ensureManagedSandboxEnvironment },
      resolveSandboxProviderDriver: readyDriverResolver(),
    });

    expect(result).toEqual({ ensured: 0, failed: 1 });
  });
});
