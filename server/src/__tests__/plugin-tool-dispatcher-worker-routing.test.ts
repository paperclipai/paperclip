/**
 * Regression: plugin tool execution must route to the worker by the plugin's
 * DATABASE UUID, not by its manifest key.
 *
 * The worker manager indexes running workers by DB UUID (see
 * `plugin-worker-manager.ts`, `workers.set(pluginId, handle)` where pluginId is
 * the DB id). `registerPluginTools()` used to forward only (pluginKey, manifest)
 * to the registry, so the registry's `pluginDbId ?? pluginId` fallback stored the
 * manifest key. Every subsequent `isRunning(pluginDbId)` lookup then missed, and
 * tool execution failed with "worker for plugin X is not running" even though the
 * worker was alive — which is exactly how the brain plugin's vault tools behaved.
 */
import { describe, it, expect, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createPluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

const PLUGIN_KEY = "whitestag.brain";
const PLUGIN_DB_ID = "aeff1be7-f0fd-4ab3-a768-7cce0271299b";

function buildManifest(): PaperclipPluginManifestV1 {
  return {
    id: PLUGIN_KEY,
    version: "0.2.0",
    apiVersion: 1,
    author: "WHITESTAG.AI",
    description: "Vault lookup connector",
    categories: ["connector"],
    capabilities: [],
    tools: [
      {
        name: "vault.search",
        displayName: "Vault durchsuchen",
        description: "Sucht Notizen im Obsidian-Vault",
        parametersSchema: { type: "object", properties: { query: { type: "string" } } },
      },
    ],
  } as unknown as PaperclipPluginManifestV1;
}

/**
 * Worker manager stub that mirrors production indexing: only the DB UUID counts
 * as a running worker. A lookup by manifest key must miss.
 */
function buildWorkerManager() {
  const call = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
  const isRunning = vi.fn((id: string) => id === PLUGIN_DB_ID);
  return {
    manager: { isRunning, call } as unknown as PluginWorkerManager,
    call,
    isRunning,
  };
}

const runContext = {
  agentId: "c73aceb3-63a5-4927-bff4-c595b408cd83",
  runId: "b23f9ccd-682b-47a2-a114-8b1764f64df3",
  companyId: "9cebf3cf-efe8-4597-a400-f06488900a87",
  projectId: "5b5687bd-d8a0-4685-9be5-cde5bfcff6d1",
} as never;

describe("plugin tool dispatcher — worker routing key", () => {
  it("routes execution to the worker registered under the plugin's DB UUID", async () => {
    const { manager, call } = buildWorkerManager();
    const dispatcher = createPluginToolDispatcher({ workerManager: manager });

    dispatcher.registerPluginTools(PLUGIN_KEY, buildManifest(), PLUGIN_DB_ID);

    await expect(
      dispatcher.executeTool(`${PLUGIN_KEY}:vault.search`, { query: "WHITESTAG" }, runContext),
    ).resolves.toBeDefined();

    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]?.[0]).toBe(PLUGIN_DB_ID);
  });

  it("looks the worker up by DB UUID, never by the manifest key", async () => {
    const { manager, isRunning } = buildWorkerManager();
    const dispatcher = createPluginToolDispatcher({ workerManager: manager });

    dispatcher.registerPluginTools(PLUGIN_KEY, buildManifest(), PLUGIN_DB_ID);
    await dispatcher.executeTool(`${PLUGIN_KEY}:vault.search`, {}, runContext);

    const probedKeys = isRunning.mock.calls.map((c) => c[0]);
    expect(probedKeys).toContain(PLUGIN_DB_ID);
    expect(probedKeys).not.toContain(PLUGIN_KEY);
  });
});
