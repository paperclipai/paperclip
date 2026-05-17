import { describe, expect, it, vi } from "vitest";
import { createPluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import type { ToolRunContext } from "@paperclipai/plugin-sdk";

const PLUGIN_KEY = "test.plugin";
const PLUGIN_DB_ID = "9c1b8f25-1cee-4f0c-8c39-7f1ed27e1234";

function makeManifest(): PaperclipPluginManifestV1 {
  return {
    id: PLUGIN_KEY,
    apiVersion: 1,
    version: "0.0.1",
    displayName: "Test Plugin",
    description: "Test plugin for dispatcher unit tests",
    author: "tests",
    categories: ["automation"],
    capabilities: ["agent.tools.register"],
    entrypoints: { worker: "./worker.js" },
    tools: [
      {
        name: "do-thing",
        displayName: "Do Thing",
        description: "Does a thing",
        parametersSchema: { type: "object", properties: {} },
      },
    ],
  } as PaperclipPluginManifestV1;
}

function makeRunContext(): ToolRunContext {
  return {
    agentId: "agent-a",
    runId: "run-r",
    companyId: "company-c",
    projectId: "project-p",
  };
}

describe("plugin-tool-dispatcher", () => {
  it("routes workerManager.isRunning by the plugin DB id, not the package key", async () => {
    // Stub that "recognizes" the worker ONLY when looked up by DB UUID,
    // mirroring plugin-worker-manager's behavior where the workers Map is
    // keyed by the DB UUID (set in plugin-loader's activatePlugin via
    // `workerManager.startWorker(plugin.id, ...)`).
    const isRunning = vi.fn((id: string) => id === PLUGIN_DB_ID);
    const call = vi.fn(async (_id: string, _method: string, _params: unknown) => ({
      content: "ok",
    }));

    const workerManager = {
      isRunning,
      call,
      // Other methods unused by this code path; type-cast away the mismatch.
    } as unknown as Parameters<typeof createPluginToolDispatcher>[0]["workerManager"];

    const dispatcher = createPluginToolDispatcher({ workerManager });

    // Mimic the plugin-loader call site: caller has both package key AND DB UUID.
    // The dispatcher MUST persist the DB UUID so executeTool can later look up
    // the worker correctly.
    dispatcher.registerPluginTools(PLUGIN_KEY, makeManifest(), PLUGIN_DB_ID);

    const result = await dispatcher.executeTool(
      `${PLUGIN_KEY}:do-thing`,
      { foo: "bar" },
      makeRunContext(),
    );

    expect(result.pluginId).toBe(PLUGIN_KEY);
    expect(result.toolName).toBe("do-thing");

    expect(isRunning).toHaveBeenCalledWith(PLUGIN_DB_ID);
    expect(isRunning).not.toHaveBeenCalledWith(PLUGIN_KEY);

    expect(call).toHaveBeenCalledWith(PLUGIN_DB_ID, "executeTool", expect.objectContaining({
      toolName: "do-thing",
      parameters: { foo: "bar" },
    }));
  });

  it("listTools exposes the plugin DB id, not the package key, as the descriptor pluginId", () => {
    const workerManager = {
      isRunning: () => true,
      call: async () => ({ content: "ok" }),
    } as unknown as Parameters<typeof createPluginToolDispatcher>[0]["workerManager"];

    const dispatcher = createPluginToolDispatcher({ workerManager });
    dispatcher.registerPluginTools(PLUGIN_KEY, makeManifest(), PLUGIN_DB_ID);

    const descriptors = dispatcher.listToolsForAgent();
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0].pluginId).toBe(PLUGIN_DB_ID);
    expect(descriptors[0].name).toBe(`${PLUGIN_KEY}:do-thing`);
  });
});
