/**
 * @fileoverview MO-070 — TDD coverage for plugin-tool-dispatcher.
 *
 * Companion to plugin-tool-registry.test.ts. The dispatcher is the orchestration
 * layer that ties together the registry, worker manager, and lifecycle events.
 *
 * BUG-CORE-001 lives here at line 433 of plugin-tool-dispatcher.ts:
 *   `registerPluginTools(pluginId, manifest)` does NOT forward pluginDbId to
 *   registry.registerPlugin — so when plugin-loader.ts line 1907 calls this
 *   from the activation path, the dbId becomes the pluginKey and worker
 *   lookup by UUID fails.
 *
 * Compare with handlePluginEnabled (line 289) → registerFromDb (line 246-269)
 * which DOES pass plugin.id (the dbUuid).
 *
 * MO-070 Phase B — Bug class targeted: BUG-CORE-001 + drift between code paths.
 */

import { describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createPluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";

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
        parametersSchema: { type: "object", properties: {} },
      },
    ],
    ...overrides,
  } as unknown as PaperclipPluginManifestV1;
}

describe("plugin-tool-dispatcher — registerPluginTools (BUG-CORE-001)", () => {
  it("registers tools when called with just (pluginKey, manifest) — but stores wrong dbId", () => {
    // Mirrors plugin-loader.ts line 1907: registerPluginTools(pluginKey, manifest).
    // Tools register, but the registry stores dbId = pluginKey (BUG).
    const dispatcher = createPluginToolDispatcher();
    dispatcher.registerPluginTools("vexion.council-chat", makeManifest({
      pluginKey: "vexion.council-chat",
      tools: [{
        name: "open-room", displayName: "Open Room", description: "x", parametersSchema: {},
      }],
    } as Partial<PaperclipPluginManifestV1>));

    const tool = dispatcher.getTool("vexion.council-chat:open-room");
    expect(tool).not.toBeNull();
    // EXPECTED-WRONG: bug means pluginDbId === pluginKey (no UUID propagation)
    expect(tool?.pluginDbId).toBe("vexion.council-chat");
  });

  it("unregisters all tools for a plugin", () => {
    const dispatcher = createPluginToolDispatcher();
    dispatcher.registerPluginTools("acme.linear", makeManifest({
      tools: [
        { name: "a", displayName: "a", description: "x", parametersSchema: {} },
        { name: "b", displayName: "b", description: "x", parametersSchema: {} },
      ],
    } as Partial<PaperclipPluginManifestV1>));
    expect(dispatcher.toolCount("acme.linear")).toBe(2);

    dispatcher.unregisterPluginTools("acme.linear");
    expect(dispatcher.toolCount("acme.linear")).toBe(0);
  });

  it("toolCount aggregates across plugins", () => {
    const dispatcher = createPluginToolDispatcher();
    dispatcher.registerPluginTools("acme.a", makeManifest({ pluginKey: "acme.a" }));
    dispatcher.registerPluginTools("acme.b", makeManifest({
      pluginKey: "acme.b",
      tools: [
        { name: "x", displayName: "x", description: "x", parametersSchema: {} },
        { name: "y", displayName: "y", description: "y", parametersSchema: {} },
      ],
    } as Partial<PaperclipPluginManifestV1>));

    expect(dispatcher.toolCount("acme.a")).toBe(1);
    expect(dispatcher.toolCount("acme.b")).toBe(2);
    expect(dispatcher.toolCount()).toBe(3);
  });
});

describe("plugin-tool-dispatcher — listToolsForAgent", () => {
  it("returns AgentToolDescriptor shape (name/displayName/description/parametersSchema/pluginId)", () => {
    const dispatcher = createPluginToolDispatcher();
    dispatcher.registerPluginTools("acme.linear", makeManifest({
      pluginKey: "acme.linear",
      tools: [{
        name: "search",
        displayName: "Search Linear",
        description: "Find tickets",
        parametersSchema: { type: "object" },
      }],
    } as Partial<PaperclipPluginManifestV1>));

    const tools = dispatcher.listToolsForAgent();
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: "acme.linear:search",
      displayName: "Search Linear",
      description: "Find tickets",
    });
    expect(tools[0]?.parametersSchema).toBeDefined();
  });

  it("filters by pluginId", () => {
    const dispatcher = createPluginToolDispatcher();
    dispatcher.registerPluginTools("acme.a", makeManifest({ pluginKey: "acme.a" }));
    dispatcher.registerPluginTools("acme.b", makeManifest({
      pluginKey: "acme.b",
      tools: [{ name: "other", displayName: "other", description: "x", parametersSchema: {} }],
    } as Partial<PaperclipPluginManifestV1>));

    const onlyA = dispatcher.listToolsForAgent({ pluginId: "acme.a" });
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0]?.name).toBe("acme.a:search");
  });
});

describe("plugin-tool-dispatcher — executeTool", () => {
  it("dispatches to worker via the configured workerManager", async () => {
    const isRunning = vi.fn().mockReturnValue(true);
    const call = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "result" }] });
    const workerManager = { isRunning, call } as any;

    const dispatcher = createPluginToolDispatcher({ workerManager });
    // Use the lifecycle-event path's signature (with explicit dbId) — works correctly
    dispatcher.getRegistry().registerPlugin(
      "acme.linear",
      makeManifest({ pluginKey: "acme.linear" }),
      "uuid-1234",
    );

    const result = await dispatcher.executeTool("acme.linear:search", { q: "x" }, {
      agentId: "a-1",
      runId: "r-1",
      companyId: "c-1",
    } as any);

    expect(call).toHaveBeenCalledWith("uuid-1234", "executeTool", expect.objectContaining({
      toolName: "search",
      parameters: { q: "x" },
    }));
    expect(result.pluginId).toBe("acme.linear");
    expect(result.toolName).toBe("search");
  });

  it("propagates worker errors as tool execution errors (does not crash)", async () => {
    const isRunning = vi.fn().mockReturnValue(true);
    const call = vi.fn().mockRejectedValue(new Error("worker exploded"));
    const workerManager = { isRunning, call } as any;

    const dispatcher = createPluginToolDispatcher({ workerManager });
    dispatcher.getRegistry().registerPlugin(
      "acme.linear",
      makeManifest({ pluginKey: "acme.linear" }),
      "uuid-1234",
    );

    await expect(
      dispatcher.executeTool("acme.linear:search", {}, {
        agentId: "a-1", runId: "r-1", companyId: "c-1",
      } as any),
    ).rejects.toThrow(/worker exploded/);
  });
});
