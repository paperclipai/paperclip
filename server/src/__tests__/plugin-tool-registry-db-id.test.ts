import { describe, expect, it, vi } from "vitest";

import { createPluginToolRegistry } from "../services/plugin-tool-registry.js";

describe("plugin tool registry", () => {
  it("routes tool execution through the plugin database id when provided", async () => {
    const workerManager = {
      isRunning: vi.fn((pluginId: string) => pluginId === "plugin-db-id"),
      call: vi.fn(async (pluginId: string, method: string, params: unknown) => ({
        content: `called ${pluginId}:${method}`,
        data: params,
      })),
    } as any;

    const registry = createPluginToolRegistry(workerManager);
    registry.registerPlugin(
      "blueprint.automation",
      {
        id: "blueprint.automation",
        displayName: "Blueprint Automation",
        version: "0.1.0",
        apiVersion: 1,
        tools: [
          {
            name: "blueprint-manager-state",
            displayName: "Blueprint Manager State",
            description: "Read the current operating snapshot.",
            parametersSchema: { type: "object", properties: {} },
          },
        ],
      },
      "plugin-db-id",
    );

    const result = await registry.executeTool(
      "blueprint.automation:blueprint-manager-state",
      { companyName: "Blueprint Autonomous Operations" },
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
        toolName: "blueprint-manager-state",
        parameters: { companyName: "Blueprint Autonomous Operations" },
        runContext: {
          agentId: "agent-1",
          runId: "run-1",
          companyId: "company-1",
          projectId: "project-1",
        },
      },
    );
    expect(result.pluginId).toBe("blueprint.automation");
    expect(result.toolName).toBe("blueprint-manager-state");
  });
});
