import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createPluginToolRegistry,
  TOOL_NAMESPACE_SEPARATOR,
  type RegisteredTool,
} from "./plugin-tool-registry.js";
import type { PaperclipPluginManifestV1, PluginToolDeclaration } from "@paperclipai/shared";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import type { ToolRunContext } from "@paperclipai/plugin-sdk";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTool(name: string, overrides: Partial<PluginToolDeclaration> = {}): PluginToolDeclaration {
  return {
    name,
    displayName: `Display ${name}`,
    description: `Description for ${name}`,
    parametersSchema: { type: "object", properties: {} },
    ...overrides,
  };
}

function makeManifest(
  id: string,
  tools: PluginToolDeclaration[] = [],
): PaperclipPluginManifestV1 {
  return {
    id,
    apiVersion: 1,
    version: "1.0.0",
    displayName: `Plugin ${id}`,
    description: "Test plugin",
    author: "Test Author",
    categories: [],
    capabilities: [],
    entrypoints: { worker: "dist/worker.js" },
    tools,
  } as unknown as PaperclipPluginManifestV1;
}

const runContext: ToolRunContext = {
  agentId: "agent-1",
  runId: "run-1",
  companyId: "co-1",
  projectId: "proj-1",
};

// ---------------------------------------------------------------------------
// parseNamespacedName / buildNamespacedName
// ---------------------------------------------------------------------------

describe("parseNamespacedName", () => {
  const registry = createPluginToolRegistry();

  it("parses valid namespaced names", () => {
    expect(registry.parseNamespacedName("acme.linear:search-issues")).toEqual({
      pluginId: "acme.linear",
      toolName: "search-issues",
    });
  });

  it("handles single-segment plugin id", () => {
    expect(registry.parseNamespacedName("myplugin:do-thing")).toEqual({
      pluginId: "myplugin",
      toolName: "do-thing",
    });
  });

  it("uses lastIndexOf — tool name containing colon returns last segment as toolName", () => {
    // "a:b:c" → pluginId="a:b", toolName="c"
    const result = registry.parseNamespacedName("a:b:c");
    expect(result).toEqual({ pluginId: "a:b", toolName: "c" });
  });

  it("returns null when separator is missing", () => {
    expect(registry.parseNamespacedName("no-separator")).toBeNull();
  });

  it("returns null when separator is at position 0 (empty pluginId)", () => {
    expect(registry.parseNamespacedName(":tool-name")).toBeNull();
  });

  it("returns null when separator is at last position (empty toolName)", () => {
    expect(registry.parseNamespacedName("plugin:")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(registry.parseNamespacedName("")).toBeNull();
  });
});

describe("buildNamespacedName", () => {
  const registry = createPluginToolRegistry();

  it("joins pluginId and toolName with the separator", () => {
    expect(registry.buildNamespacedName("acme.linear", "search-issues")).toBe(
      `acme.linear${TOOL_NAMESPACE_SEPARATOR}search-issues`,
    );
  });

  it("TOOL_NAMESPACE_SEPARATOR constant is colon", () => {
    expect(TOOL_NAMESPACE_SEPARATOR).toBe(":");
  });
});

// ---------------------------------------------------------------------------
// registerPlugin / toolCount / listTools
// ---------------------------------------------------------------------------

describe("registerPlugin", () => {
  it("registers tools from manifest and makes them discoverable", () => {
    const registry = createPluginToolRegistry();
    registry.registerPlugin("myplugin", makeManifest("myplugin", [makeTool("foo"), makeTool("bar")]));

    expect(registry.toolCount()).toBe(2);
    expect(registry.listTools()).toHaveLength(2);
  });

  it("stores correct RegisteredTool fields", () => {
    const registry = createPluginToolRegistry();
    const tool = makeTool("search", { description: "Search for things", parametersSchema: { type: "object" } });
    registry.registerPlugin("acme.linear", makeManifest("acme.linear", [tool]), "db-uuid-123");

    const registered = registry.getTool("acme.linear:search");
    expect(registered).not.toBeNull();
    expect(registered!.pluginId).toBe("acme.linear");
    expect(registered!.pluginDbId).toBe("db-uuid-123");
    expect(registered!.name).toBe("search");
    expect(registered!.namespacedName).toBe("acme.linear:search");
    expect(registered!.displayName).toBe("Display search");
    expect(registered!.description).toBe("Search for things");
    expect(registered!.parametersSchema).toEqual({ type: "object" });
  });

  it("falls back to pluginId as pluginDbId when not provided", () => {
    const registry = createPluginToolRegistry();
    registry.registerPlugin("myplugin", makeManifest("myplugin", [makeTool("foo")]));

    const registered = registry.getTool("myplugin:foo");
    expect(registered!.pluginDbId).toBe("myplugin");
  });

  it("is idempotent — re-registering replaces previous tools", () => {
    const registry = createPluginToolRegistry();
    registry.registerPlugin("p", makeManifest("p", [makeTool("a"), makeTool("b")]));
    expect(registry.toolCount()).toBe(2);

    // Re-register with different tool set
    registry.registerPlugin("p", makeManifest("p", [makeTool("c")]));
    expect(registry.toolCount()).toBe(1);
    expect(registry.getTool("p:c")).not.toBeNull();
    expect(registry.getTool("p:a")).toBeNull();
    expect(registry.getTool("p:b")).toBeNull();
  });

  it("handles manifest with no tools (tools undefined)", () => {
    const registry = createPluginToolRegistry();
    const manifest = makeManifest("empty-plugin");
    delete (manifest as any).tools;
    registry.registerPlugin("empty-plugin", manifest);

    expect(registry.toolCount()).toBe(0);
    expect(registry.listTools()).toEqual([]);
  });

  it("handles manifest with empty tools array", () => {
    const registry = createPluginToolRegistry();
    registry.registerPlugin("empty-plugin", makeManifest("empty-plugin", []));

    expect(registry.toolCount()).toBe(0);
  });

  it("multiple plugins coexist independently", () => {
    const registry = createPluginToolRegistry();
    registry.registerPlugin("plugin-a", makeManifest("plugin-a", [makeTool("x"), makeTool("y")]));
    registry.registerPlugin("plugin-b", makeManifest("plugin-b", [makeTool("z")]));

    expect(registry.toolCount()).toBe(3);
    expect(registry.toolCount("plugin-a")).toBe(2);
    expect(registry.toolCount("plugin-b")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// unregisterPlugin
// ---------------------------------------------------------------------------

describe("unregisterPlugin", () => {
  it("removes all tools for the given plugin", () => {
    const registry = createPluginToolRegistry();
    registry.registerPlugin("p", makeManifest("p", [makeTool("a"), makeTool("b")]));
    registry.unregisterPlugin("p");

    expect(registry.toolCount()).toBe(0);
    expect(registry.getTool("p:a")).toBeNull();
    expect(registry.getTool("p:b")).toBeNull();
  });

  it("does not affect other plugins", () => {
    const registry = createPluginToolRegistry();
    registry.registerPlugin("plugin-a", makeManifest("plugin-a", [makeTool("x")]));
    registry.registerPlugin("plugin-b", makeManifest("plugin-b", [makeTool("y")]));

    registry.unregisterPlugin("plugin-a");

    expect(registry.toolCount()).toBe(1);
    expect(registry.getTool("plugin-b:y")).not.toBeNull();
  });

  it("is a no-op for unknown plugin", () => {
    const registry = createPluginToolRegistry();
    // Should not throw
    expect(() => registry.unregisterPlugin("nonexistent")).not.toThrow();
    expect(registry.toolCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getTool / getToolByPlugin
// ---------------------------------------------------------------------------

describe("getTool", () => {
  it("returns registered tool by namespaced name", () => {
    const registry = createPluginToolRegistry();
    registry.registerPlugin("myplugin", makeManifest("myplugin", [makeTool("foo")]));

    const tool = registry.getTool("myplugin:foo");
    expect(tool).not.toBeNull();
    expect(tool!.namespacedName).toBe("myplugin:foo");
  });

  it("returns null for unknown tool", () => {
    const registry = createPluginToolRegistry();
    expect(registry.getTool("myplugin:nonexistent")).toBeNull();
  });

  it("returns null after plugin is unregistered", () => {
    const registry = createPluginToolRegistry();
    registry.registerPlugin("myplugin", makeManifest("myplugin", [makeTool("foo")]));
    registry.unregisterPlugin("myplugin");
    expect(registry.getTool("myplugin:foo")).toBeNull();
  });
});

describe("getToolByPlugin", () => {
  it("returns registered tool by plugin + bare name", () => {
    const registry = createPluginToolRegistry();
    registry.registerPlugin("acme.linear", makeManifest("acme.linear", [makeTool("search-issues")]));

    const tool = registry.getToolByPlugin("acme.linear", "search-issues");
    expect(tool).not.toBeNull();
    expect(tool!.name).toBe("search-issues");
  });

  it("returns null for unknown plugin", () => {
    const registry = createPluginToolRegistry();
    expect(registry.getToolByPlugin("nonexistent", "foo")).toBeNull();
  });

  it("returns null for unknown tool within a registered plugin", () => {
    const registry = createPluginToolRegistry();
    registry.registerPlugin("myplugin", makeManifest("myplugin", [makeTool("foo")]));
    expect(registry.getToolByPlugin("myplugin", "bar")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listTools
// ---------------------------------------------------------------------------

describe("listTools", () => {
  it("returns all tools when no filter is provided", () => {
    const registry = createPluginToolRegistry();
    registry.registerPlugin("plugin-a", makeManifest("plugin-a", [makeTool("x"), makeTool("y")]));
    registry.registerPlugin("plugin-b", makeManifest("plugin-b", [makeTool("z")]));

    const all = registry.listTools();
    expect(all).toHaveLength(3);
    const names = all.map((t) => t.namespacedName).sort();
    expect(names).toEqual(["plugin-a:x", "plugin-a:y", "plugin-b:z"]);
  });

  it("filters by pluginId when filter.pluginId is provided", () => {
    const registry = createPluginToolRegistry();
    registry.registerPlugin("plugin-a", makeManifest("plugin-a", [makeTool("x"), makeTool("y")]));
    registry.registerPlugin("plugin-b", makeManifest("plugin-b", [makeTool("z")]));

    const aTools = registry.listTools({ pluginId: "plugin-a" });
    expect(aTools).toHaveLength(2);
    expect(aTools.every((t) => t.pluginId === "plugin-a")).toBe(true);
  });

  it("returns empty array for unknown plugin in filter", () => {
    const registry = createPluginToolRegistry();
    registry.registerPlugin("plugin-a", makeManifest("plugin-a", [makeTool("x")]));

    expect(registry.listTools({ pluginId: "nonexistent" })).toEqual([]);
  });

  it("returns empty array when no tools are registered", () => {
    const registry = createPluginToolRegistry();
    expect(registry.listTools()).toEqual([]);
  });

  it("returns empty array for a plugin filter with empty tool set after unregister", () => {
    const registry = createPluginToolRegistry();
    registry.registerPlugin("p", makeManifest("p", [makeTool("a")]));
    registry.unregisterPlugin("p");
    expect(registry.listTools({ pluginId: "p" })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// toolCount
// ---------------------------------------------------------------------------

describe("toolCount", () => {
  it("returns total count when no pluginId given", () => {
    const registry = createPluginToolRegistry();
    registry.registerPlugin("a", makeManifest("a", [makeTool("x"), makeTool("y")]));
    registry.registerPlugin("b", makeManifest("b", [makeTool("z")]));
    expect(registry.toolCount()).toBe(3);
  });

  it("returns per-plugin count when pluginId is given", () => {
    const registry = createPluginToolRegistry();
    registry.registerPlugin("a", makeManifest("a", [makeTool("x"), makeTool("y")]));
    registry.registerPlugin("b", makeManifest("b", [makeTool("z")]));
    expect(registry.toolCount("a")).toBe(2);
    expect(registry.toolCount("b")).toBe(1);
  });

  it("returns 0 for unknown plugin", () => {
    const registry = createPluginToolRegistry();
    expect(registry.toolCount("nonexistent")).toBe(0);
  });

  it("decrements after unregisterPlugin", () => {
    const registry = createPluginToolRegistry();
    registry.registerPlugin("a", makeManifest("a", [makeTool("x"), makeTool("y")]));
    registry.unregisterPlugin("a");
    expect(registry.toolCount()).toBe(0);
    expect(registry.toolCount("a")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// executeTool
// ---------------------------------------------------------------------------

describe("executeTool", () => {
  it("throws when no workerManager is configured", async () => {
    const registry = createPluginToolRegistry(); // no workerManager
    registry.registerPlugin("myplugin", makeManifest("myplugin", [makeTool("foo")]));

    await expect(registry.executeTool("myplugin:foo", {}, runContext)).rejects.toThrow(
      "no worker manager configured",
    );
  });

  it("throws for invalid (unparseable) namespaced name", async () => {
    const registry = createPluginToolRegistry();

    await expect(registry.executeTool("invalid-no-colon", {}, runContext)).rejects.toThrow(
      "Invalid tool name",
    );
  });

  it("throws when tool is not registered", async () => {
    const mockWorkerManager = { isRunning: vi.fn(), call: vi.fn() } as unknown as PluginWorkerManager;
    const registry = createPluginToolRegistry(mockWorkerManager);

    await expect(registry.executeTool("myplugin:unknown", {}, runContext)).rejects.toThrow(
      'Tool "myplugin:unknown" is not registered',
    );
  });

  it("throws when worker is not running", async () => {
    const mockWorkerManager = {
      isRunning: vi.fn().mockReturnValue(false),
      call: vi.fn(),
    } as unknown as PluginWorkerManager;
    const registry = createPluginToolRegistry(mockWorkerManager);
    registry.registerPlugin("myplugin", makeManifest("myplugin", [makeTool("foo")]), "db-uuid-1");

    await expect(registry.executeTool("myplugin:foo", {}, runContext)).rejects.toThrow(
      "worker for plugin",
    );
    expect(mockWorkerManager.isRunning).toHaveBeenCalledWith("db-uuid-1");
  });

  it("dispatches to workerManager.call and returns execution result", async () => {
    const fakeResult = { content: "search results", data: undefined, error: undefined };
    const mockWorkerManager = {
      isRunning: vi.fn().mockReturnValue(true),
      call: vi.fn().mockResolvedValue(fakeResult),
    } as unknown as PluginWorkerManager;
    const registry = createPluginToolRegistry(mockWorkerManager);
    registry.registerPlugin("acme.linear", makeManifest("acme.linear", [makeTool("search-issues")]), "db-uuid-linear");

    const result = await registry.executeTool("acme.linear:search-issues", { query: "auth" }, runContext);

    expect(result.pluginId).toBe("acme.linear");
    expect(result.toolName).toBe("search-issues");
    expect(result.result).toBe(fakeResult);

    expect(mockWorkerManager.call).toHaveBeenCalledWith("db-uuid-linear", "executeTool", {
      toolName: "search-issues",
      parameters: { query: "auth" },
      runContext,
    });
  });

  it("uses pluginId as dbId when pluginDbId was not provided during registerPlugin", async () => {
    const mockWorkerManager = {
      isRunning: vi.fn().mockReturnValue(true),
      call: vi.fn().mockResolvedValue({ content: "ok" }),
    } as unknown as PluginWorkerManager;
    const registry = createPluginToolRegistry(mockWorkerManager);
    registry.registerPlugin("myplugin", makeManifest("myplugin", [makeTool("run")]));

    await registry.executeTool("myplugin:run", {}, runContext);

    expect(mockWorkerManager.isRunning).toHaveBeenCalledWith("myplugin");
    expect(mockWorkerManager.call).toHaveBeenCalledWith("myplugin", "executeTool", expect.any(Object));
  });
});
