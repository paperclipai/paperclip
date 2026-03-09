import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import type { ToolRunContext, ToolResult } from "@paperclipai/plugin-sdk";
import {
  createPluginToolRegistry,
  TOOL_NAMESPACE_SEPARATOR,
} from "../services/plugin-tool-registry.js";
import type {
  PluginToolRegistry,
  RegisteredTool,
} from "../services/plugin-tool-registry.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManifest(
  overrides: Partial<PaperclipPluginManifestV1> = {},
): PaperclipPluginManifestV1 {
  return {
    id: "acme.test-plugin",
    name: "Test Plugin",
    version: "1.0.0",
    apiVersion: 1,
    description: "A test plugin",
    capabilities: ["agent.tools.register"],
    tools: [],
    ...overrides,
  } as PaperclipPluginManifestV1;
}

function makeToolDecl(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    displayName: `${name} tool`,
    description: `Description for ${name}`,
    parametersSchema: { type: "object", properties: {} },
    ...overrides,
  };
}

function makeRunContext(overrides: Partial<ToolRunContext> = {}): ToolRunContext {
  return {
    agentId: "agent-1",
    runId: "run-1",
    companyId: "company-1",
    projectId: "project-1",
    ...overrides,
  };
}

function createMockWorkerManager(
  overrides: Partial<PluginWorkerManager> = {},
): PluginWorkerManager {
  return {
    startWorker: vi.fn(),
    stopWorker: vi.fn(),
    getWorker: vi.fn(),
    isRunning: vi.fn().mockReturnValue(true),
    stopAll: vi.fn(),
    diagnostics: vi.fn().mockReturnValue([]),
    call: vi.fn().mockResolvedValue({ content: "ok" } as ToolResult),
    ...overrides,
  } as unknown as PluginWorkerManager;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createPluginToolRegistry", () => {
  let registry: PluginToolRegistry;

  beforeEach(() => {
    registry = createPluginToolRegistry();
  });

  // -----------------------------------------------------------------------
  // registerPlugin
  // -----------------------------------------------------------------------

  describe("registerPlugin", () => {
    it("registers tools declared in a manifest", () => {
      const manifest = makeManifest({
        id: "acme.linear",
        tools: [
          makeToolDecl("search-issues"),
          makeToolDecl("create-issue"),
        ],
      });

      registry.registerPlugin("acme.linear", manifest);

      expect(registry.toolCount()).toBe(2);
      expect(registry.toolCount("acme.linear")).toBe(2);
    });

    it("registers no tools when manifest has no tools array", () => {
      const manifest = makeManifest({ id: "acme.empty", tools: undefined });

      registry.registerPlugin("acme.empty", manifest);

      expect(registry.toolCount()).toBe(0);
      expect(registry.toolCount("acme.empty")).toBe(0);
    });

    it("registers no tools when manifest has an empty tools array", () => {
      const manifest = makeManifest({ id: "acme.empty", tools: [] });

      registry.registerPlugin("acme.empty", manifest);

      expect(registry.toolCount()).toBe(0);
    });

    it("replaces previously registered tools for the same plugin (idempotent)", () => {
      const manifest1 = makeManifest({
        id: "acme.linear",
        tools: [makeToolDecl("search-issues"), makeToolDecl("create-issue")],
      });
      const manifest2 = makeManifest({
        id: "acme.linear",
        tools: [makeToolDecl("list-issues")],
      });

      registry.registerPlugin("acme.linear", manifest1);
      expect(registry.toolCount("acme.linear")).toBe(2);

      // Re-register with a different manifest
      registry.registerPlugin("acme.linear", manifest2);
      expect(registry.toolCount("acme.linear")).toBe(1);
      expect(registry.getTool("acme.linear:list-issues")).not.toBeNull();
      expect(registry.getTool("acme.linear:search-issues")).toBeNull();
      expect(registry.getTool("acme.linear:create-issue")).toBeNull();
    });

    it("does not interfere with other plugins when re-registering", () => {
      registry.registerPlugin(
        "acme.linear",
        makeManifest({ id: "acme.linear", tools: [makeToolDecl("search")] }),
      );
      registry.registerPlugin(
        "acme.github",
        makeManifest({ id: "acme.github", tools: [makeToolDecl("lookup")] }),
      );

      expect(registry.toolCount()).toBe(2);

      // Re-register linear with zero tools
      registry.registerPlugin(
        "acme.linear",
        makeManifest({ id: "acme.linear", tools: [] }),
      );

      expect(registry.toolCount()).toBe(1);
      expect(registry.getTool("acme.github:lookup")).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // unregisterPlugin
  // -----------------------------------------------------------------------

  describe("unregisterPlugin", () => {
    it("removes all tools for a plugin", () => {
      registry.registerPlugin(
        "acme.linear",
        makeManifest({
          id: "acme.linear",
          tools: [makeToolDecl("search-issues"), makeToolDecl("create-issue")],
        }),
      );

      expect(registry.toolCount("acme.linear")).toBe(2);

      registry.unregisterPlugin("acme.linear");

      expect(registry.toolCount("acme.linear")).toBe(0);
      expect(registry.toolCount()).toBe(0);
      expect(registry.getTool("acme.linear:search-issues")).toBeNull();
    });

    it("is a no-op for an unregistered plugin", () => {
      registry.unregisterPlugin("nonexistent");
      expect(registry.toolCount()).toBe(0);
    });

    it("does not affect other plugins", () => {
      registry.registerPlugin(
        "acme.linear",
        makeManifest({ id: "acme.linear", tools: [makeToolDecl("search")] }),
      );
      registry.registerPlugin(
        "acme.github",
        makeManifest({ id: "acme.github", tools: [makeToolDecl("lookup")] }),
      );

      registry.unregisterPlugin("acme.linear");

      expect(registry.toolCount()).toBe(1);
      expect(registry.getTool("acme.github:lookup")).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // getTool
  // -----------------------------------------------------------------------

  describe("getTool", () => {
    it("returns the tool by namespaced name", () => {
      registry.registerPlugin(
        "acme.linear",
        makeManifest({
          id: "acme.linear",
          tools: [
            makeToolDecl("search-issues", {
              displayName: "Search Linear Issues",
              description: "Search issues in Linear",
              parametersSchema: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
              },
            }),
          ],
        }),
      );

      const tool = registry.getTool("acme.linear:search-issues");

      expect(tool).not.toBeNull();
      expect(tool!.pluginId).toBe("acme.linear");
      expect(tool!.name).toBe("search-issues");
      expect(tool!.namespacedName).toBe("acme.linear:search-issues");
      expect(tool!.displayName).toBe("Search Linear Issues");
      expect(tool!.description).toBe("Search issues in Linear");
      expect(tool!.parametersSchema).toEqual({
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      });
    });

    it("returns null for a non-existent tool", () => {
      expect(registry.getTool("acme.linear:nonexistent")).toBeNull();
    });

    it("returns null for an invalid namespaced name", () => {
      expect(registry.getTool("invalid-name")).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // getToolByPlugin
  // -----------------------------------------------------------------------

  describe("getToolByPlugin", () => {
    it("returns the tool by plugin ID and bare name", () => {
      registry.registerPlugin(
        "acme.linear",
        makeManifest({
          id: "acme.linear",
          tools: [makeToolDecl("search-issues")],
        }),
      );

      const tool = registry.getToolByPlugin("acme.linear", "search-issues");

      expect(tool).not.toBeNull();
      expect(tool!.pluginId).toBe("acme.linear");
      expect(tool!.name).toBe("search-issues");
    });

    it("returns null for a non-existent tool", () => {
      expect(registry.getToolByPlugin("acme.linear", "nonexistent")).toBeNull();
    });

    it("returns null for a non-existent plugin", () => {
      expect(registry.getToolByPlugin("nonexistent", "search")).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // listTools
  // -----------------------------------------------------------------------

  describe("listTools", () => {
    it("returns all registered tools when no filter is specified", () => {
      registry.registerPlugin(
        "acme.linear",
        makeManifest({ id: "acme.linear", tools: [makeToolDecl("search")] }),
      );
      registry.registerPlugin(
        "acme.github",
        makeManifest({ id: "acme.github", tools: [makeToolDecl("lookup"), makeToolDecl("pr-status")] }),
      );

      const tools = registry.listTools();

      expect(tools).toHaveLength(3);
      const names = tools.map((t) => t.namespacedName).sort();
      expect(names).toEqual([
        "acme.github:lookup",
        "acme.github:pr-status",
        "acme.linear:search",
      ]);
    });

    it("returns only tools for the specified plugin when filtered", () => {
      registry.registerPlugin(
        "acme.linear",
        makeManifest({ id: "acme.linear", tools: [makeToolDecl("search")] }),
      );
      registry.registerPlugin(
        "acme.github",
        makeManifest({ id: "acme.github", tools: [makeToolDecl("lookup")] }),
      );

      const tools = registry.listTools({ pluginId: "acme.github" });

      expect(tools).toHaveLength(1);
      expect(tools[0].namespacedName).toBe("acme.github:lookup");
    });

    it("returns empty array when no tools match the filter", () => {
      registry.registerPlugin(
        "acme.linear",
        makeManifest({ id: "acme.linear", tools: [makeToolDecl("search")] }),
      );

      const tools = registry.listTools({ pluginId: "acme.nonexistent" });

      expect(tools).toHaveLength(0);
    });

    it("returns empty array when no tools are registered", () => {
      const tools = registry.listTools();
      expect(tools).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // parseNamespacedName / buildNamespacedName
  // -----------------------------------------------------------------------

  describe("parseNamespacedName", () => {
    it("parses a valid namespaced name", () => {
      const result = registry.parseNamespacedName("acme.linear:search-issues");

      expect(result).toEqual({
        pluginId: "acme.linear",
        toolName: "search-issues",
      });
    });

    it("handles plugin IDs with dots", () => {
      const result = registry.parseNamespacedName("com.example.deep.plugin:my-tool");

      expect(result).toEqual({
        pluginId: "com.example.deep.plugin",
        toolName: "my-tool",
      });
    });

    it("returns null for a name without separator", () => {
      expect(registry.parseNamespacedName("invalid")).toBeNull();
    });

    it("returns null for a name ending with separator", () => {
      expect(registry.parseNamespacedName("acme.linear:")).toBeNull();
    });

    it("returns null for a name starting with separator", () => {
      expect(registry.parseNamespacedName(":search")).toBeNull();
    });
  });

  describe("buildNamespacedName", () => {
    it("builds a namespaced name from plugin ID and tool name", () => {
      const result = registry.buildNamespacedName("acme.linear", "search-issues");
      expect(result).toBe("acme.linear:search-issues");
    });
  });

  // -----------------------------------------------------------------------
  // TOOL_NAMESPACE_SEPARATOR
  // -----------------------------------------------------------------------

  describe("TOOL_NAMESPACE_SEPARATOR", () => {
    it("is a colon", () => {
      expect(TOOL_NAMESPACE_SEPARATOR).toBe(":");
    });
  });

  // -----------------------------------------------------------------------
  // toolCount
  // -----------------------------------------------------------------------

  describe("toolCount", () => {
    it("returns total count when no plugin specified", () => {
      registry.registerPlugin(
        "acme.linear",
        makeManifest({ id: "acme.linear", tools: [makeToolDecl("a"), makeToolDecl("b")] }),
      );
      registry.registerPlugin(
        "acme.github",
        makeManifest({ id: "acme.github", tools: [makeToolDecl("c")] }),
      );

      expect(registry.toolCount()).toBe(3);
    });

    it("returns per-plugin count when plugin specified", () => {
      registry.registerPlugin(
        "acme.linear",
        makeManifest({ id: "acme.linear", tools: [makeToolDecl("a"), makeToolDecl("b")] }),
      );

      expect(registry.toolCount("acme.linear")).toBe(2);
    });

    it("returns 0 for an unregistered plugin", () => {
      expect(registry.toolCount("nonexistent")).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // executeTool
  // -----------------------------------------------------------------------

  describe("executeTool", () => {
    let mockManager: PluginWorkerManager;

    beforeEach(() => {
      mockManager = createMockWorkerManager();
      registry = createPluginToolRegistry(mockManager);
    });

    it("routes tool execution to the correct plugin worker", async () => {
      registry.registerPlugin(
        "acme.linear",
        makeManifest({
          id: "acme.linear",
          tools: [makeToolDecl("search-issues")],
        }),
      );

      const expectedResult: ToolResult = {
        content: "Found 3 issues",
        data: { count: 3 },
      };
      (mockManager.call as ReturnType<typeof vi.fn>).mockResolvedValue(expectedResult);

      const params = { query: "auth bug" };
      const runCtx = makeRunContext();

      const execResult = await registry.executeTool(
        "acme.linear:search-issues",
        params,
        runCtx,
      );

      expect(execResult.pluginId).toBe("acme.linear");
      expect(execResult.toolName).toBe("search-issues");
      expect(execResult.result).toEqual(expectedResult);

      expect(mockManager.call).toHaveBeenCalledWith(
        "acme.linear",
        "executeTool",
        {
          toolName: "search-issues",
          parameters: params,
          runContext: runCtx,
        },
      );
    });

    it("throws for an invalid namespaced name format", async () => {
      await expect(
        registry.executeTool("invalid-name", {}, makeRunContext()),
      ).rejects.toThrow('Invalid tool name "invalid-name"');
    });

    it("throws when the tool is not registered", async () => {
      await expect(
        registry.executeTool("acme.linear:nonexistent", {}, makeRunContext()),
      ).rejects.toThrow('Tool "acme.linear:nonexistent" is not registered');
    });

    it("throws when no worker manager is configured", async () => {
      const noManagerRegistry = createPluginToolRegistry();
      noManagerRegistry.registerPlugin(
        "acme.linear",
        makeManifest({
          id: "acme.linear",
          tools: [makeToolDecl("search")],
        }),
      );

      await expect(
        noManagerRegistry.executeTool("acme.linear:search", {}, makeRunContext()),
      ).rejects.toThrow("no worker manager configured");
    });

    it("throws when the plugin worker is not running", async () => {
      (mockManager.isRunning as ReturnType<typeof vi.fn>).mockReturnValue(false);
      registry.registerPlugin(
        "acme.linear",
        makeManifest({
          id: "acme.linear",
          tools: [makeToolDecl("search")],
        }),
      );

      await expect(
        registry.executeTool("acme.linear:search", {}, makeRunContext()),
      ).rejects.toThrow('worker for plugin "acme.linear" is not running');
    });

    it("returns error results from the worker without throwing", async () => {
      registry.registerPlugin(
        "acme.linear",
        makeManifest({
          id: "acme.linear",
          tools: [makeToolDecl("search")],
        }),
      );

      const errorResult: ToolResult = { error: "API rate limited" };
      (mockManager.call as ReturnType<typeof vi.fn>).mockResolvedValue(errorResult);

      const execResult = await registry.executeTool(
        "acme.linear:search",
        {},
        makeRunContext(),
      );

      expect(execResult.result.error).toBe("API rate limited");
    });

    it("propagates worker RPC errors as thrown errors", async () => {
      registry.registerPlugin(
        "acme.linear",
        makeManifest({
          id: "acme.linear",
          tools: [makeToolDecl("search")],
        }),
      );

      (mockManager.call as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("RPC call timed out"),
      );

      await expect(
        registry.executeTool("acme.linear:search", {}, makeRunContext()),
      ).rejects.toThrow("RPC call timed out");
    });

    it("passes the correct run context to the worker", async () => {
      registry.registerPlugin(
        "acme.linear",
        makeManifest({
          id: "acme.linear",
          tools: [makeToolDecl("search")],
        }),
      );

      const runCtx = makeRunContext({
        agentId: "agent-42",
        runId: "run-99",
        companyId: "co-abc",
        projectId: "proj-xyz",
      });

      await registry.executeTool("acme.linear:search", { q: "test" }, runCtx);

      expect(mockManager.call).toHaveBeenCalledWith(
        "acme.linear",
        "executeTool",
        expect.objectContaining({
          runContext: {
            agentId: "agent-42",
            runId: "run-99",
            companyId: "co-abc",
            projectId: "proj-xyz",
          },
        }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // Multi-plugin scenarios
  // -----------------------------------------------------------------------

  describe("multi-plugin scenarios", () => {
    it("supports tools with the same name from different plugins", () => {
      registry.registerPlugin(
        "acme.linear",
        makeManifest({ id: "acme.linear", tools: [makeToolDecl("search")] }),
      );
      registry.registerPlugin(
        "acme.github",
        makeManifest({ id: "acme.github", tools: [makeToolDecl("search")] }),
      );

      expect(registry.toolCount()).toBe(2);

      const linearTool = registry.getTool("acme.linear:search");
      const githubTool = registry.getTool("acme.github:search");

      expect(linearTool).not.toBeNull();
      expect(githubTool).not.toBeNull();
      expect(linearTool!.pluginId).toBe("acme.linear");
      expect(githubTool!.pluginId).toBe("acme.github");
    });

    it("unregistering one plugin leaves others intact", () => {
      registry.registerPlugin(
        "acme.linear",
        makeManifest({ id: "acme.linear", tools: [makeToolDecl("search"), makeToolDecl("create")] }),
      );
      registry.registerPlugin(
        "acme.github",
        makeManifest({ id: "acme.github", tools: [makeToolDecl("lookup")] }),
      );
      registry.registerPlugin(
        "acme.jira",
        makeManifest({ id: "acme.jira", tools: [makeToolDecl("get-ticket")] }),
      );

      expect(registry.toolCount()).toBe(4);

      registry.unregisterPlugin("acme.linear");

      expect(registry.toolCount()).toBe(2);
      expect(registry.getTool("acme.github:lookup")).not.toBeNull();
      expect(registry.getTool("acme.jira:get-ticket")).not.toBeNull();
      expect(registry.getTool("acme.linear:search")).toBeNull();
      expect(registry.getTool("acme.linear:create")).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // RegisteredTool shape
  // -----------------------------------------------------------------------

  describe("RegisteredTool shape", () => {
    it("contains all expected fields", () => {
      registry.registerPlugin(
        "acme.linear",
        makeManifest({
          id: "acme.linear",
          tools: [
            {
              name: "search-issues",
              displayName: "Search Issues",
              description: "Search for issues in Linear",
              parametersSchema: {
                type: "object",
                properties: {
                  query: { type: "string", description: "Search query" },
                  limit: { type: "number", default: 10 },
                },
                required: ["query"],
              },
            },
          ],
        }),
      );

      const tool = registry.getTool("acme.linear:search-issues") as RegisteredTool;

      expect(tool).toMatchObject({
        pluginId: "acme.linear",
        name: "search-issues",
        namespacedName: "acme.linear:search-issues",
        displayName: "Search Issues",
        description: "Search for issues in Linear",
        parametersSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            limit: { type: "number", default: 10 },
          },
          required: ["query"],
        },
      });
    });
  });
});
