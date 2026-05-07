import { describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { createPluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";

describe("plugin tool dispatcher", () => {
  it("routes manifest-key namespaced tools to the installed plugin worker UUID", async () => {
    const calls: Array<{ pluginId: string; method: string; params: unknown }> = [];
    const workerManager = {
      isRunning(pluginId: string) {
        return pluginId === "plugin-db-id";
      },
      async call(pluginId: string, method: string, params: unknown) {
        calls.push({ pluginId, method, params });
        return { content: "ok" };
      },
    } as unknown as PluginWorkerManager;

    const dispatcher = createPluginToolDispatcher({ workerManager });
    const manifest = {
      id: "acme.example",
      name: "Example",
      version: "1.0.0",
      tools: [
        {
          name: "lookup",
          displayName: "Lookup",
          description: "Look up a record",
          parametersSchema: { type: "object", properties: {} },
        },
      ],
    } as unknown as PaperclipPluginManifestV1;

    dispatcher.registerPluginTools("acme.example", manifest, "plugin-db-id");

    expect(dispatcher.listToolsForAgent()).toMatchObject([
      {
        name: "acme.example:lookup",
        pluginId: "plugin-db-id",
      },
    ]);

    await expect(
      dispatcher.executeTool(
        "acme.example:lookup",
        { query: "customer" },
        { agentId: "agent-1", runId: "run-1", companyId: "company-1" },
      ),
    ).resolves.toMatchObject({
      pluginId: "acme.example",
      toolName: "lookup",
      result: { content: "ok" },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      pluginId: "plugin-db-id",
      method: "executeTool",
    });
  });
});
