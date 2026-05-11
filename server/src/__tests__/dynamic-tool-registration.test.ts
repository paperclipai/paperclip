import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildHostServices } from "../services/plugin-host-services.js";
import type { PluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";

describe("Dynamic Tool Registration", () => {
  let mockDispatcher: PluginToolDispatcher;
  const pluginId = "test-plugin-id";
  const pluginDbId = "test-plugin-uuid";

  beforeEach(() => {
    mockDispatcher = {
      registerDynamicTool: vi.fn(),
    } as unknown as PluginToolDispatcher;
  });

  it("should register a dynamic tool via host services", async () => {
    const hostServices = buildHostServices(
      {} as any, // db
      pluginId,
      pluginDbId,
      { toolDispatcher: mockDispatcher } as any
    );

    const toolDeclaration = {
      name: "dynamic-tool",
      displayName: "Dynamic Tool",
      description: "A tool registered at runtime",
      parametersSchema: { type: "object", properties: {} },
    };

    await hostServices.tools.register({
      name: toolDeclaration.name,
      declaration: toolDeclaration,
    });

    expect(mockDispatcher.registerDynamicTool).toHaveBeenCalledWith(
      pluginId,
      toolDeclaration.name,
      toolDeclaration,
      pluginDbId
    );
  });

  it("should throw error if tool dispatcher is not provided", async () => {
    const hostServices = buildHostServices(
      {} as any,
      pluginId,
      pluginDbId,
      {} as any // No toolDispatcher
    );

    await expect(
      hostServices.tools.register({
        name: "test",
        declaration: {} as any,
      })
    ).rejects.toThrow("Tool dispatcher not available");
  });
});
