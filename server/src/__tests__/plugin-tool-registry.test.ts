import { describe, expect, it, vi } from "vitest";
import { createPluginToolRegistry } from "../services/plugin-tool-registry.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

function makeManifest(): PaperclipPluginManifestV1 {
  return {
    id: "acme.test",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Acme Test",
    description: "Test plugin",
    author: "Acme",
    categories: ["developer_tools"],
    capabilities: ["agent.tools.register"],
    entrypoints: {
      worker: "dist/worker.js",
    },
    tools: [
      {
        name: "echo",
        displayName: "Echo",
        description: "Echo input",
        parametersSchema: {
          type: "object",
          properties: {
            value: { type: "string" },
          },
        },
      },
    ],
  };
}

describe("plugin-tool-registry", () => {
  it("does not force infinite timeout for tool execution RPCs", async () => {
    const call = vi.fn(async () => ({ content: [], data: null, error: null }));
    const workerManager: PluginWorkerManager = {
      startWorker: vi.fn(async () => {
        throw new Error("not implemented");
      }),
      stopWorker: vi.fn(async () => undefined),
      getWorker: vi.fn(() => undefined),
      isRunning: vi.fn(() => true),
      stopAll: vi.fn(async () => undefined),
      diagnostics: vi.fn(() => []),
      call,
    };
    const registry = createPluginToolRegistry(workerManager);
    registry.registerPlugin("acme.test", makeManifest(), "plugin-db-1");

    await registry.executeTool(
      "acme.test:echo",
      { value: "hello" },
      {
        agentId: "agent-1",
        runId: "run-1",
        companyId: "company-1",
        projectId: null,
      },
    );

    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith(
      "plugin-db-1",
      "executeTool",
      expect.objectContaining({
        toolName: "echo",
        parameters: { value: "hello" },
      }),
    );
    expect(call.mock.calls[0]).toHaveLength(3);
  });
});
