import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getPluginBuilderTools,
  setBuilderPluginBridge,
} from "../services/builder/plugin-bridge.js";

describe("builder plugin bridge", () => {
  afterEach(() => {
    setBuilderPluginBridge(null);
  });
  it("omits plugin tools that declare requiresApproval", () => {
    setBuilderPluginBridge({
      getRegistry: () => ({
        listTools: () => [
          {
            pluginId: "example",
            namespacedName: "example:read_only",
            name: "read_only",
            description: "",
            parametersSchema: { type: "object" },
            surfaces: ["builder"],
            requiresApproval: false,
          },
          {
            pluginId: "example",
            namespacedName: "example:dangerous_write",
            name: "dangerous_write",
            description: "",
            parametersSchema: { type: "object" },
            surfaces: ["builder"],
            requiresApproval: true,
          },
        ],
      }),
      executeTool: vi.fn(),
    } as never);

    const tools = getPluginBuilderTools({} as never);
    expect(tools.map((tool) => tool.name)).toEqual(["read_only"]);
  });

  it("blocks runtime execution when registry now marks tool requiresApproval", async () => {
    const executeTool = vi.fn(async () => ({
      result: { data: { ok: true }, content: null, error: null },
    }));

    const registry = {
      listTools: () => [
        {
          pluginId: "example",
          namespacedName: "example:write_maybe",
          name: "write_maybe",
          description: "",
          parametersSchema: { type: "object" },
          surfaces: ["builder"],
          requiresApproval: false,
        },
      ],
      getTool: () => ({ requiresApproval: true }),
    };

    setBuilderPluginBridge({
      getRegistry: () => registry,
      executeTool,
    } as never);

    const [tool] = getPluginBuilderTools({} as never);
    const result = await tool.run(
      {},
      {
        companyId: "company-1",
        sessionId: "session-1",
        messageId: "message-1",
        db: {} as never,
        actor: { type: "user", id: "user-1" },
        proposalStore: {} as never,
      },
    );

    expect(result).toEqual({
      ok: false,
      error:
        "Plugin builder tools that require approval cannot run directly. Expose them through the agent surface or remove requiresApproval.",
    });
    expect(executeTool).not.toHaveBeenCalled();
  });
});
