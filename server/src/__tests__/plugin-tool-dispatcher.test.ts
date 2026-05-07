import { describe, expect, it, vi } from "vitest";
import { createPluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

describe("plugin tool dispatcher", () => {
  it("routes tool execution using the plugin database id when provided", async () => {
    const call = vi.fn(async () => ({
      content: [{ type: "text", text: "ok" }],
    }));

    const workerManager = {
      startWorker: vi.fn(),
      stopWorker: vi.fn(),
      getWorker: vi.fn(),
      isRunning: vi.fn((pluginId: string) => pluginId === "plugin-db-id"),
      stopAll: vi.fn(),
      diagnostics: vi.fn(() => []),
      call,
    } satisfies PluginWorkerManager;

    const dispatcher = createPluginToolDispatcher({ workerManager });
    dispatcher.registerPluginTools(
      "acme.example",
      {
        apiVersion: 1,
        name: "acme.example",
        version: "1.0.0",
        tools: [
          {
            name: "search",
            description: "Search",
            parametersSchema: { type: "object" },
          },
        ],
      },
      "plugin-db-id",
    );

    const result = await dispatcher.executeTool(
      "acme.example:search",
      { query: "bug" },
      {
        agentId: "agent-1",
        runId: "run-1",
        companyId: "company-1",
        projectId: "project-1",
      },
    );

    expect(workerManager.isRunning).toHaveBeenCalledWith("plugin-db-id");
    expect(call).toHaveBeenCalledWith(
      "plugin-db-id",
      "executeTool",
      expect.objectContaining({
        toolName: "search",
        parameters: { query: "bug" },
      }),
    );
    expect(result.pluginId).toBe("acme.example");
    expect(result.toolName).toBe("search");
  });
});
