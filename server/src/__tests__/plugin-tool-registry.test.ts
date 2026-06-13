/**
 * @fileoverview MO-070 — TDD coverage for plugin-tool-registry.
 *
 * Surfaced by Vexion MO-068 + MO-069 discovery: the tool registration path
 * has two distinct code paths that must propagate the plugin DB UUID
 * (`pluginDbId`) correctly to enable worker lookup via `workerManager.call(dbId, ...)`.
 *
 * - Path A (lifecycle event → registerFromDb): passes dbId correctly.
 * - Path B (plugin-loader activation → toolDispatcher.registerPluginTools): drops dbId.
 *
 * This file pins down the registry-level contract; the dispatcher-level
 * contract is covered in plugin-tool-dispatcher.test.ts.
 *
 * MO-070 Phase B — Bug class targeted: BUG-CORE-001 (dbId propagation).
 */

import { describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createPluginToolRegistry } from "../services/plugin-tool-registry.js";

function makeManifest(overrides: Partial<PaperclipPluginManifestV1> = {}): PaperclipPluginManifestV1 {
  return {
    apiVersion: "paperclip.dev/v1",
    pluginKey: "test.example",
    version: "0.1.0",
    displayName: "Test Example",
    author: "tester",
    license: "MIT",
    categories: ["productivity"],
    capabilities: {},
    entrypoints: {},
    tools: [
      {
        name: "search",
        displayName: "Search",
        description: "Find things",
        parametersSchema: { type: "object", properties: { q: { type: "string" } } },
      },
    ],
    ...overrides,
  } as unknown as PaperclipPluginManifestV1;
}

describe("plugin-tool-registry — registration", () => {
  it("registers a tool under its namespaced name", () => {
    const registry = createPluginToolRegistry();
    registry.registerPlugin("acme.linear", makeManifest({ pluginKey: "acme.linear" }));

    const tool = registry.getTool("acme.linear:search");
    expect(tool).not.toBeNull();
    expect(tool?.name).toBe("search");
    expect(tool?.pluginId).toBe("acme.linear");
  });

  it("uses pluginId as dbId fallback when dbId is omitted (BUG-CORE-001 regression)", () => {
    // This is the bug surfaced by MO-068+069. When activation passes only
    // (pluginKey, manifest) the registry stores dbId = pluginKey. Worker lookup
    // by DB UUID later FAILS. Test pins the current (broken) behavior so a fix
    // PR must update this expectation.
    const registry = createPluginToolRegistry();
    registry.registerPlugin("acme.linear", makeManifest({ pluginKey: "acme.linear" }));

    const tool = registry.getTool("acme.linear:search");
    expect(tool?.pluginDbId).toBe("acme.linear"); // CURRENT BROKEN BEHAVIOR — pluginId used as dbId
  });

  it("stores explicit dbId separately from pluginId when both are given", () => {
    const registry = createPluginToolRegistry();
    const dbUuid = "e8cedbb3-e718-4cb1-bab9-3db2025e8dc4";
    registry.registerPlugin("acme.linear", makeManifest({ pluginKey: "acme.linear" }), dbUuid);

    const tool = registry.getTool("acme.linear:search");
    expect(tool?.pluginId).toBe("acme.linear");
    expect(tool?.pluginDbId).toBe(dbUuid);
  });

  it("is idempotent — re-registering replaces previous tools", () => {
    const registry = createPluginToolRegistry();
    registry.registerPlugin("acme.linear", makeManifest({
      tools: [{ name: "v1", displayName: "v1", description: "old", parametersSchema: {} }],
    } as Partial<PaperclipPluginManifestV1>));

    registry.registerPlugin("acme.linear", makeManifest({
      tools: [{ name: "v2", displayName: "v2", description: "new", parametersSchema: {} }],
    } as Partial<PaperclipPluginManifestV1>));

    expect(registry.getTool("acme.linear:v1")).toBeNull();
    expect(registry.getTool("acme.linear:v2")).not.toBeNull();
    expect(registry.toolCount("acme.linear")).toBe(1);
  });

  it("handles plugins that declare no tools without throwing", () => {
    const registry = createPluginToolRegistry();
    expect(() => registry.registerPlugin("acme.minimal", makeManifest({ tools: [] }))).not.toThrow();
    expect(registry.toolCount("acme.minimal")).toBe(0);
  });

  it("isolates tools across plugins (no cross-pollution)", () => {
    const registry = createPluginToolRegistry();
    registry.registerPlugin("acme.a", makeManifest({ pluginKey: "acme.a" }));
    registry.registerPlugin("acme.b", makeManifest({
      pluginKey: "acme.b",
      tools: [{ name: "other", displayName: "Other", description: "x", parametersSchema: {} }],
    } as Partial<PaperclipPluginManifestV1>));

    expect(registry.getToolByPlugin("acme.a", "search")).not.toBeNull();
    expect(registry.getToolByPlugin("acme.a", "other")).toBeNull();
    expect(registry.getToolByPlugin("acme.b", "other")).not.toBeNull();
    expect(registry.getToolByPlugin("acme.b", "search")).toBeNull();
  });
});

describe("plugin-tool-registry — namespaced names", () => {
  it("buildNamespacedName uses ':' separator", () => {
    const registry = createPluginToolRegistry();
    expect(registry.buildNamespacedName("acme.linear", "search-issues")).toBe("acme.linear:search-issues");
  });

  it("parseNamespacedName splits on the LAST ':' (pluginId may contain dots, not colons)", () => {
    const registry = createPluginToolRegistry();
    const parsed = registry.parseNamespacedName("vexion.council-chat:open-room");
    expect(parsed).toEqual({ pluginId: "vexion.council-chat", toolName: "open-room" });
  });

  it("parseNamespacedName returns null for malformed names", () => {
    const registry = createPluginToolRegistry();
    expect(registry.parseNamespacedName("no-colon")).toBeNull();
    expect(registry.parseNamespacedName(":leading-colon")).toBeNull();
    expect(registry.parseNamespacedName("trailing-colon:")).toBeNull();
  });
});

describe("plugin-tool-registry — unregister", () => {
  it("removes all tools for a plugin", () => {
    const registry = createPluginToolRegistry();
    registry.registerPlugin("acme.linear", makeManifest({
      tools: [
        { name: "a", displayName: "a", description: "x", parametersSchema: {} },
        { name: "b", displayName: "b", description: "x", parametersSchema: {} },
      ],
    } as Partial<PaperclipPluginManifestV1>));
    expect(registry.toolCount("acme.linear")).toBe(2);

    registry.unregisterPlugin("acme.linear");
    expect(registry.toolCount("acme.linear")).toBe(0);
    expect(registry.getTool("acme.linear:a")).toBeNull();
  });

  it("unregister on unknown plugin is a no-op (doesn't throw)", () => {
    const registry = createPluginToolRegistry();
    expect(() => registry.unregisterPlugin("never.installed")).not.toThrow();
  });
});

describe("plugin-tool-registry — executeTool", () => {
  it("throws when tool name is malformed", async () => {
    const registry = createPluginToolRegistry();
    await expect(
      registry.executeTool("not-namespaced", {}, {
        agentId: "a-1",
        runId: "r-1",
        companyId: "c-1",
      } as any),
    ).rejects.toThrow(/Invalid tool name/i);
  });

  it("throws when tool is not registered", async () => {
    const registry = createPluginToolRegistry();
    await expect(
      registry.executeTool("acme.unknown:tool", {}, {
        agentId: "a-1",
        runId: "r-1",
        companyId: "c-1",
      } as any),
    ).rejects.toThrow(/not registered/i);
  });

  it("throws when no worker manager is configured", async () => {
    const registry = createPluginToolRegistry();
    registry.registerPlugin("acme.linear", makeManifest({ pluginKey: "acme.linear" }), "db-uuid-1");

    await expect(
      registry.executeTool("acme.linear:search", { q: "x" }, {
        agentId: "a-1",
        runId: "r-1",
        companyId: "c-1",
      } as any),
    ).rejects.toThrow(/no worker manager/i);
  });

  it("looks up worker by pluginDbId, not pluginId — uses the DB UUID for routing", async () => {
    // This is the load-bearing assertion: workerManager.isRunning + .call MUST
    // be invoked with the DB UUID (not the pluginKey). MO-069 monkey-patch
    // showed this is exactly where the lookup-by-key path fails.
    const isRunning = vi.fn().mockReturnValue(true);
    const call = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const workerManager = { isRunning, call } as any;

    const registry = createPluginToolRegistry(workerManager);
    const dbUuid = "e8cedbb3-e718-4cb1-bab9-3db2025e8dc4";
    registry.registerPlugin("vexion.council-chat", makeManifest({ pluginKey: "vexion.council-chat" }), dbUuid);

    await registry.executeTool("vexion.council-chat:search", { q: "x" }, {
      agentId: "a-1",
      runId: "r-1",
      companyId: "c-1",
    } as any);

    expect(isRunning).toHaveBeenCalledWith(dbUuid);
    expect(call).toHaveBeenCalledWith(dbUuid, "executeTool", expect.objectContaining({ toolName: "search" }));
    // Strong assertion: dbId is NOT the pluginKey
    expect(isRunning).not.toHaveBeenCalledWith("vexion.council-chat");
  });

  it("throws when worker is not running (worker-not-ready path)", async () => {
    const isRunning = vi.fn().mockReturnValue(false);
    const workerManager = { isRunning, call: vi.fn() } as any;

    const registry = createPluginToolRegistry(workerManager);
    registry.registerPlugin("acme.linear", makeManifest({ pluginKey: "acme.linear" }), "db-uuid-1");

    await expect(
      registry.executeTool("acme.linear:search", {}, {
        agentId: "a-1",
        runId: "r-1",
        companyId: "c-1",
      } as any),
    ).rejects.toThrow(/worker.*not running/i);
  });
});
