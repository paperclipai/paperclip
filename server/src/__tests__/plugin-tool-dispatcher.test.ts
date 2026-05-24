import { describe, expect, it, vi } from "vitest";
import { createPluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

describe("plugin tool dispatcher", () => {
  it("keeps plugin-key tool names while routing execution to the plugin DB id", async () => {
    const workerManager = {
      isRunning: vi.fn((pluginId: string) => pluginId === "plugin-db-1"),
      call: vi.fn(async () => ({ content: "ok" })),
    };
    const dispatcher = createPluginToolDispatcher({ workerManager: workerManager as never });
    const manifest: PaperclipPluginManifestV1 = {
      id: "paperclip.example",
      apiVersion: 1,
      version: "1.0.0",
      displayName: "Example",
      description: "Example plugin",
      author: "Paperclip",
      categories: ["automation"],
      capabilities: ["agent.tools.register"],
      entrypoints: { worker: "./worker.js" },
      tools: [{
        name: "search",
        displayName: "Search",
        description: "Search examples",
        parametersSchema: { type: "object" },
      }],
    };

    dispatcher.registerPluginTools("paperclip.example", manifest, "plugin-db-1");

    expect(dispatcher.getTool("paperclip.example:search")).toMatchObject({
      pluginId: "paperclip.example",
      pluginDbId: "plugin-db-1",
    });

    const result = await dispatcher.executeTool(
      "paperclip.example:search",
      { q: "briefs" },
      {
        agentId: "agent-1",
        runId: "run-1",
        companyId: "company-1",
        projectId: "project-1",
      },
    );

    expect(result).toMatchObject({
      pluginId: "paperclip.example",
      toolName: "search",
      result: { content: "ok" },
    });
    expect(workerManager.isRunning).toHaveBeenCalledWith("plugin-db-1");
    expect(workerManager.call).toHaveBeenCalledWith("plugin-db-1", "executeTool", expect.objectContaining({
      toolName: "search",
      parameters: { q: "briefs" },
    }));
  });
});
