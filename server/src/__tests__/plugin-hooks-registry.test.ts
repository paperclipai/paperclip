import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  createPluginHookRegistry,
  type PluginLifecycleSubset,
} from "../services/plugin-hooks/registry.js";

const noopHandler = (payload: Record<string, unknown>) => payload;

function makeLifecycle(): PluginLifecycleSubset & {
  emit: (event: "plugin.disabled" | "plugin.unloaded" | "plugin.error", payload: { pluginId: string }) => void;
} {
  const ee = new EventEmitter();
  return {
    on: ee.on.bind(ee) as PluginLifecycleSubset["on"],
    off: ee.off.bind(ee) as NonNullable<PluginLifecycleSubset["off"]>,
    emit: ee.emit.bind(ee),
  };
}

describe("createPluginHookRegistry", () => {
  it("registers and lists hook entries sorted by priority then insertion order", async () => {
    const registry = createPluginHookRegistry();
    registry.register({
      kind: "wakePayloadTransformer",
      pluginId: "p-mid",
      pluginKey: "mid",
      priority: 50,
      handler: noopHandler,
    });
    registry.register({
      kind: "wakePayloadTransformer",
      pluginId: "p-low",
      pluginKey: "low",
      priority: 10,
      handler: noopHandler,
    });
    registry.register({
      kind: "wakePayloadTransformer",
      pluginId: "p-high",
      pluginKey: "high",
      priority: 200,
      handler: noopHandler,
    });
    registry.register({
      kind: "wakePayloadTransformer",
      pluginId: "p-mid-2",
      pluginKey: "mid-2",
      priority: 50,
      handler: noopHandler,
    });

    const list = await registry.list("wakePayloadTransformer", { companyId: "c-1" });
    expect(list.map((e) => e.pluginId)).toEqual(["p-low", "p-mid", "p-mid-2", "p-high"]);
  });

  it("falls back to default priority when not provided or invalid", async () => {
    const registry = createPluginHookRegistry();
    registry.register({
      kind: "wakePayloadTransformer",
      pluginId: "p-default",
      pluginKey: "default",
      handler: noopHandler,
    });
    registry.register({
      kind: "wakePayloadTransformer",
      pluginId: "p-explicit",
      pluginKey: "explicit",
      priority: 5,
      handler: noopHandler,
    });
    const list = await registry.list("wakePayloadTransformer", { companyId: "c-1" });
    expect(list.map((e) => e.pluginId)).toEqual(["p-explicit", "p-default"]);
    expect(list.find((e) => e.pluginId === "p-default")?.priority).toBe(100);
  });

  it("filters out plugins not enabled for the company", async () => {
    const registry = createPluginHookRegistry({
      isPluginEnabledForCompany: (pluginId) => pluginId !== "p-blocked",
    });
    registry.register({
      kind: "skillResolverTransformer",
      pluginId: "p-allowed",
      pluginKey: "allowed",
      handler: (skills) => skills,
    });
    registry.register({
      kind: "skillResolverTransformer",
      pluginId: "p-blocked",
      pluginKey: "blocked",
      handler: (skills) => skills,
    });
    const list = await registry.list("skillResolverTransformer", { companyId: "c-1" });
    expect(list.map((e) => e.pluginId)).toEqual(["p-allowed"]);
  });

  it("returns an empty list when the per-company feature flag is off", async () => {
    const registry = createPluginHookRegistry({
      isHooksEnabledForCompany: () => false,
    });
    registry.register({
      kind: "wakePayloadTransformer",
      pluginId: "p-1",
      pluginKey: "p-1",
      handler: noopHandler,
    });
    const list = await registry.list("wakePayloadTransformer", { companyId: "c-1" });
    expect(list).toHaveLength(0);
  });

  it("becomes a no-op when the registry-level kill switch is off", async () => {
    const registry = createPluginHookRegistry({ enabled: false });
    registry.register({
      kind: "wakePayloadTransformer",
      pluginId: "p-1",
      pluginKey: "p-1",
      handler: noopHandler,
    });
    expect(registry.size()).toBe(0);
    expect(await registry.list("wakePayloadTransformer", { companyId: "c-1" })).toHaveLength(0);
  });

  it("registers manifest-declared hooks when a paired handler is provided", async () => {
    const registry = createPluginHookRegistry();
    const accepted = registry.registerManifestEntries({
      pluginId: "p-decl",
      pluginKey: "decl",
      declarations: {
        wakePayloadTransformer: { priority: 25, when: { issueHasField: "fastAction" } },
        skillResolverTransformer: { priority: 5 },
      },
      handlers: {
        wakePayloadTransformer: noopHandler,
        // skillResolverTransformer handler intentionally omitted
      },
    });
    expect(accepted.map((e) => e.kind)).toEqual(["wakePayloadTransformer"]);
    const list = await registry.list("wakePayloadTransformer", { companyId: "c-1" });
    expect(list).toHaveLength(1);
    expect(list[0]!.priority).toBe(25);
    expect(list[0]!.when).toEqual({ issueHasField: "fastAction" });
  });

  it("removes all of a plugin's hooks on unregisterPlugin", async () => {
    const registry = createPluginHookRegistry();
    registry.register({
      kind: "wakePayloadTransformer",
      pluginId: "p-1",
      pluginKey: "p-1",
      handler: noopHandler,
    });
    registry.register({
      kind: "skillResolverTransformer",
      pluginId: "p-1",
      pluginKey: "p-1",
      handler: (skills) => skills,
    });
    registry.register({
      kind: "skillResolverTransformer",
      pluginId: "p-2",
      pluginKey: "p-2",
      handler: (skills) => skills,
    });
    expect(registry.size()).toBe(3);
    registry.unregisterPlugin("p-1");
    expect(registry.size()).toBe(1);
    expect(
      (await registry.list("skillResolverTransformer", { companyId: "c-1" })).map((e) => e.pluginId),
    ).toEqual(["p-2"]);
  });

  it("unregisters hooks when a lifecycle event fires", async () => {
    const lifecycle = makeLifecycle();
    const registry = createPluginHookRegistry();
    registry.attachLifecycle(lifecycle);
    registry.register({
      kind: "wakePayloadTransformer",
      pluginId: "p-1",
      pluginKey: "p-1",
      handler: noopHandler,
    });
    lifecycle.emit("plugin.disabled", { pluginId: "p-1" });
    expect(registry.size()).toBe(0);

    registry.register({
      kind: "wakePayloadTransformer",
      pluginId: "p-2",
      pluginKey: "p-2",
      handler: noopHandler,
    });
    lifecycle.emit("plugin.unloaded", { pluginId: "p-2" });
    expect(registry.size()).toBe(0);

    registry.register({
      kind: "wakePayloadTransformer",
      pluginId: "p-3",
      pluginKey: "p-3",
      handler: noopHandler,
    });
    lifecycle.emit("plugin.error", { pluginId: "p-3" });
    expect(registry.size()).toBe(0);
  });

  it("reset() clears entries and detaches lifecycle listeners", async () => {
    const lifecycle = makeLifecycle();
    const registry = createPluginHookRegistry();
    registry.attachLifecycle(lifecycle);
    registry.register({
      kind: "wakePayloadTransformer",
      pluginId: "p-1",
      pluginKey: "p-1",
      handler: noopHandler,
    });
    registry.reset();
    expect(registry.size()).toBe(0);

    // After reset, lifecycle events must not affect newly registered hooks.
    registry.register({
      kind: "wakePayloadTransformer",
      pluginId: "p-1",
      pluginKey: "p-1",
      handler: noopHandler,
    });
    lifecycle.emit("plugin.disabled", { pluginId: "p-1" });
    expect(registry.size()).toBe(1);
  });

  it("keeps lookup with an empty registry under 1 ms", () => {
    const registry = createPluginHookRegistry();
    const iterations = 10_000;
    const start = performance.now();
    for (let i = 0; i < iterations; i += 1) {
      registry.listUnfiltered("wakePayloadTransformer");
      registry.listUnfiltered("skillResolverTransformer");
      registry.listUnfiltered("runtimeEnvProvider");
    }
    const elapsedNs = (performance.now() - start) * 1_000_000;
    const perCallNs = elapsedNs / iterations;
    // Documented exit criterion: lookup with no hooks installed < 1 ms.
    expect(perCallNs).toBeLessThan(1_000_000);
  });

  it("supports the runtimeEnvProvider kind end-to-end (register / list / manifest / lifecycle)", async () => {
    const lifecycle = makeLifecycle();
    const registry = createPluginHookRegistry();
    registry.attachLifecycle(lifecycle);

    const accepted = registry.registerManifestEntries({
      pluginId: "gh-identity-provider",
      pluginKey: "gh-identity",
      declarations: {
        runtimeEnvProvider: { priority: 25, when: { issueHasField: "adapterType" } },
      },
      handlers: {
        runtimeEnvProvider: (current) => current,
      },
    });
    expect(accepted.map((e) => e.kind)).toEqual(["runtimeEnvProvider"]);

    registry.register({
      kind: "runtimeEnvProvider",
      pluginId: "p-second",
      pluginKey: "second",
      priority: 5,
      handler: (current) => current,
    });

    const list = await registry.list("runtimeEnvProvider", { companyId: "c-1" });
    expect(list.map((e) => e.pluginId)).toEqual(["p-second", "gh-identity-provider"]);

    lifecycle.emit("plugin.unloaded", { pluginId: "gh-identity-provider" });
    expect(
      (await registry.list("runtimeEnvProvider", { companyId: "c-1" })).map((e) => e.pluginId),
    ).toEqual(["p-second"]);
  });
});
