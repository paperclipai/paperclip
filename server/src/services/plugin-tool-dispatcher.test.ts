import { describe, expect, it, vi } from "vitest";
import { createPluginToolDispatcher } from "./plugin-tool-dispatcher.js";

describe("createPluginToolDispatcher", () => {
  it("routes tool execution through the plugin database id when manually registering tools", async () => {
    const workerManager = {
      isRunning: vi.fn((pluginId: string) => pluginId === "plugin-db-id"),
      call: vi.fn().mockResolvedValue({ content: "ok" }),
    };

    const dispatcher = createPluginToolDispatcher({
      workerManager: workerManager as never,
    });

    dispatcher.registerPluginTools(
      "paperclip-plugin-hindsight",
      {
        apiVersion: 1,
        id: "paperclip-plugin-hindsight",
        displayName: "Hindsight",
        version: "0.2.0",
        description: "Hindsight memory plugin",
        author: "Paperclip",
        categories: ["automation"],
        entrypoints: { worker: "dist/worker.js" },
        capabilities: [],
        tools: [
          {
            name: "hindsight_recall",
            displayName: "Hindsight Recall",
            description: "Recall memory",
            parametersSchema: {
              type: "object",
              properties: {
                query: { type: "string" },
              },
              required: ["query"],
            },
          },
        ],
      },
      "plugin-db-id",
    );

    const result = await dispatcher.executeTool(
      "paperclip-plugin-hindsight:hindsight_recall",
      { query: "test" },
      {
        agentId: "agent-1",
        runId: "run-1",
        companyId: "company-1",
        projectId: "project-1",
      },
    );

    expect(workerManager.isRunning).toHaveBeenCalledWith("plugin-db-id");
    expect(workerManager.call).toHaveBeenCalledWith(
      "plugin-db-id",
      "executeTool",
      {
        toolName: "hindsight_recall",
        parameters: { query: "test" },
        runContext: {
          agentId: "agent-1",
          runId: "run-1",
          companyId: "company-1",
          projectId: "project-1",
        },
      },
    );
    expect(result).toEqual({
      pluginId: "paperclip-plugin-hindsight",
      toolName: "hindsight_recall",
      result: { content: "ok" },
    });
  });
});
