import { describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { createPluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const PLUGIN_KEY = "acme.linear";
const PLUGIN_DB_ID = "00000000-0000-0000-0000-0000000000aa";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_KEY,
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Acme Linear",
  description: "Test manifest for plugin-tool-dispatcher regression tests.",
  author: "Paperclip Tests",
  categories: ["connector"],
  capabilities: ["agent.tools.register"],
  entrypoints: {
    worker: "worker.js",
  },
  tools: [
    {
      name: "search-issues",
      displayName: "Search issues",
      description: "Search Linear issues.",
      parametersSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
    },
  ],
};

function makeWorkerManagerStub(runningDbIds: ReadonlySet<string>): PluginWorkerManager {
  const call = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
  const isRunning = vi.fn((pluginId: string) => runningDbIds.has(pluginId));

  return {
    startWorker: vi.fn(),
    stopWorker: vi.fn(),
    getWorker: vi.fn(),
    isRunning,
    stopAll: vi.fn(),
    diagnostics: vi.fn().mockReturnValue([]),
    call,
  } as unknown as PluginWorkerManager;
}

// ---------------------------------------------------------------------------
// Regression: registerPluginTools must forward pluginDbId
// ---------------------------------------------------------------------------

describe("plugin-tool-dispatcher — pluginDbId routing", () => {
  it("routes executeTool to the DB UUID when registerPluginTools was called with pluginDbId", async () => {
    // Worker is "running" under the DB UUID only.
    const workerManager = makeWorkerManagerStub(new Set([PLUGIN_DB_ID]));

    const dispatcher = createPluginToolDispatcher({ workerManager });
    dispatcher.registerPluginTools(PLUGIN_KEY, manifest, PLUGIN_DB_ID);

    const result = await dispatcher.executeTool(
      `${PLUGIN_KEY}:search-issues`,
      { query: "auth bug" },
      { agentId: "a1", runId: "r1", companyId: "c1", projectId: "p1" },
    );

    expect(result.pluginId).toBe(PLUGIN_KEY);
    expect(workerManager.isRunning).toHaveBeenCalledWith(PLUGIN_DB_ID);
    expect(workerManager.isRunning).not.toHaveBeenCalledWith(PLUGIN_KEY);
    expect(workerManager.call).toHaveBeenCalledWith(
      PLUGIN_DB_ID,
      "executeTool",
      expect.objectContaining({ toolName: "search-issues" }),
    );
  });

  it("fails with 'worker is not running' when pluginDbId is omitted and worker is keyed by DB UUID", async () => {
    // Regression guard: the old bug was that plugin-loader forgot to pass
    // the DB UUID, so the registry fell back to pluginId (= manifest key)
    // and isRunning(...) always missed.
    const workerManager = makeWorkerManagerStub(new Set([PLUGIN_DB_ID]));

    const dispatcher = createPluginToolDispatcher({ workerManager });
    // Intentionally omit the 3rd arg — reproduces the bug shape.
    dispatcher.registerPluginTools(PLUGIN_KEY, manifest);

    await expect(
      dispatcher.executeTool(
        `${PLUGIN_KEY}:search-issues`,
        { query: "auth bug" },
        { agentId: "a1", runId: "r1", companyId: "c1", projectId: "p1" },
      ),
    ).rejects.toThrow(/worker for plugin .* is not running/);

    expect(workerManager.isRunning).toHaveBeenCalledWith(PLUGIN_KEY);
    expect(workerManager.call).not.toHaveBeenCalled();
  });
});
