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

    const result = await applyManagedEnvironments(noDb, config, {
      env: {},
      environments: { ensureManagedSandboxEnvironment },
    });

    expect(result).toEqual({ ensured: 1, failed: 0 });
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
    });

    expect(result).toEqual({ ensured: 0, failed: 1 });
  });
});
