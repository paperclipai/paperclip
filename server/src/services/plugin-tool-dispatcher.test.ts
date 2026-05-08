import { describe, expect, it } from "vitest";

import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

import { createPluginToolDispatcher } from "./plugin-tool-dispatcher.js";

/**
 * PLA-323 regression: the dispatcher's `registerPluginTools(...)` must thread
 * an optional `pluginDbId` (the plugin row's DB UUID) through to the registry
 * so that each registered tool's `tool.pluginDbId` is the UUID, not the plugin
 * key.
 *
 * Why this matters: `executeTool` in `plugin-tool-registry.ts` checks
 * `workerManager.isRunning(tool.pluginDbId)` to decide whether to dispatch.
 * The worker manager is keyed by DB UUID. If `pluginDbId` is left to default
 * to the plugin key (e.g. `"platform.cad"`), every dispatch fails closed with
 * `502 "worker for plugin '<key>' is not running"` even when the worker is
 * running. PLA-308 hit this path for `cad:run_script` / `cad:export`.
 */
describe("PluginToolDispatcher.registerPluginTools — pluginDbId threading (PLA-323)", () => {
  function makeManifest(pluginKey: string): PaperclipPluginManifestV1 {
    return {
      id: pluginKey,
      apiVersion: 1,
      version: "1.0.0",
      displayName: "Test plugin",
      description: "fixture for PLA-323",
      author: "test",
      categories: ["automation"],
      capabilities: ["agent.tools.register"],
      entrypoints: { worker: "dist/worker.js" },
      tools: [
        {
          name: "run_script",
          displayName: "Run Script",
          description: "Run a script",
          parametersSchema: { type: "object", properties: {} },
        },
      ],
    } as PaperclipPluginManifestV1;
  }

  it("stamps the DB UUID onto registered tools when pluginDbId is provided", () => {
    const dispatcher = createPluginToolDispatcher();
    const pluginKey = "platform.cad";
    const pluginDbId = "1f8d7b6c-0a2e-4f1c-9b3d-2c4f5e6a7b8d";

    dispatcher.registerPluginTools(pluginKey, makeManifest(pluginKey), pluginDbId);

    const tool = dispatcher.getTool(`${pluginKey}:run_script`);
    expect(tool, "tool should be registered under namespaced name").not.toBeNull();
    expect(tool!.pluginId).toBe(pluginKey);
    // The fix under test: pluginDbId is the UUID, not the plugin key.
    expect(tool!.pluginDbId).toBe(pluginDbId);
    expect(tool!.pluginDbId).not.toBe(pluginKey);
  });

  it("falls back to pluginId when pluginDbId is omitted (backwards-compat)", () => {
    const dispatcher = createPluginToolDispatcher();
    const pluginKey = "platform.cad";

    dispatcher.registerPluginTools(pluginKey, makeManifest(pluginKey));

    const tool = dispatcher.getTool(`${pluginKey}:run_script`);
    expect(tool).not.toBeNull();
    // Without a UUID, the registry stamps pluginId itself onto pluginDbId so
    // pre-PLA-323 callers continue to work (used in tests where id === key).
    expect(tool!.pluginDbId).toBe(pluginKey);
  });
});
