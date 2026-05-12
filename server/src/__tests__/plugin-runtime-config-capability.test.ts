/**
 * Tier 1 unit tests: capability gating for ctx.config.runtime.* methods.
 *
 * RBAC matrix — plugin.config.write capability × {get, set, unset}:
 *
 *   Method                  | capability present | capability absent
 *   ----------------------- | ------------------ | -----------------
 *   config.runtime.get      | allowed            | CapabilityDeniedError
 *   config.runtime.set      | allowed            | CapabilityDeniedError
 *   config.runtime.unset    | allowed            | CapabilityDeniedError
 */

import { describe, expect, it, vi } from "vitest";
import {
  CapabilityDeniedError,
  createHostClientHandlers,
} from "../../../packages/plugins/sdk/src/host-client-factory.js";

const PLUGIN_ID = "plugin-capability-test";

function makeServices() {
  return {
    config: {
      async get() { return {}; },
      runtime: {
        async get() { return { values: { k: "v" }, revision: "1" }; },
        async set(_p: { patch: Record<string, unknown> }) { return { revision: "2" }; },
        async unset(_p: { key: string }) { return { revision: "2" }; },
      },
    },
    state: {
      async get(_p: unknown) { return null; },
      async set(_p: unknown) { return undefined; },
      async delete(_p: unknown) { return undefined; },
    },
    db: {
      async query(_p: unknown) { return { rows: [] }; },
      async exec(_p: unknown) { return undefined; },
      getRuntimeNamespace: (_pluginId: string) => (_pluginId as string),
    },
    tool: {
      async run(_p: unknown) { return { output: "" }; },
    },
    log: {
      async write(_p: unknown) { return undefined; },
    },
    // minimal stubs for all required HostServices fields
  } as never;
}

describe("config.runtime capability gating — plugin.config.write PRESENT", () => {
  const handlers = createHostClientHandlers({
    pluginId: PLUGIN_ID,
    capabilities: ["plugin.config.write"],
    services: makeServices(),
  });

  it("config.runtime.get is allowed", async () => {
    const result = await handlers["config.runtime.get"]({} as never);
    expect(result).toEqual({ values: { k: "v" }, revision: "1" });
  });

  it("config.runtime.set is allowed", async () => {
    const result = await handlers["config.runtime.set"]({ patch: { x: 1 } });
    expect(result).toEqual({ revision: "2" });
  });

  it("config.runtime.unset is allowed", async () => {
    const result = await handlers["config.runtime.unset"]({ key: "x" });
    expect(result).toEqual({ revision: "2" });
  });
});

describe("config.runtime capability gating — plugin.config.write ABSENT", () => {
  const handlers = createHostClientHandlers({
    pluginId: PLUGIN_ID,
    capabilities: [],
    services: makeServices(),
  });

  it("config.runtime.get throws CapabilityDeniedError", async () => {
    await expect(handlers["config.runtime.get"]({} as never)).rejects.toBeInstanceOf(
      CapabilityDeniedError,
    );
  });

  it("config.runtime.set throws CapabilityDeniedError", async () => {
    await expect(
      handlers["config.runtime.set"]({ patch: { x: 1 } }),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
  });

  it("config.runtime.unset throws CapabilityDeniedError", async () => {
    await expect(
      handlers["config.runtime.unset"]({ key: "x" }),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
  });

  it("CapabilityDeniedError message names the missing capability", async () => {
    const err = await handlers["config.runtime.set"]({ patch: { x: 1 } }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CapabilityDeniedError);
    expect((err as Error).message).toMatch("plugin.config.write");
  });
});

describe("config.runtime capability gating — unrelated capability only", () => {
  const handlers = createHostClientHandlers({
    pluginId: PLUGIN_ID,
    capabilities: ["plugin.db.read"],
    services: makeServices(),
  });

  it("config.runtime.set throws CapabilityDeniedError when only plugin.db.read granted", async () => {
    await expect(
      handlers["config.runtime.set"]({ patch: { x: 1 } }),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
  });
});
