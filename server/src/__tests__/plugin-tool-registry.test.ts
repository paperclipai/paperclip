import { describe, it, expect, beforeEach } from "vitest";
import {
  createPluginToolRegistry,
  TOOL_NAMESPACE_SEPARATOR,
} from "../services/plugin-tool-registry.js";
import { pluginManifestValidator } from "../services/plugin-manifest-validator.js";
import { PLUGIN_API_VERSION } from "@paperclipai/shared";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import type { PluginToolRegistry } from "../services/plugin-tool-registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mv = pluginManifestValidator();

function makeTool(name: string, displayName?: string) {
  return {
    name,
    displayName: displayName ?? name,
    description: `Description for ${name}`,
    parametersSchema: { type: "object" as const, properties: {}, required: [] },
  };
}

function makeManifest(
  pluginId: string,
  toolNames: string[],
  overrides: Record<string, unknown> = {},
): PaperclipPluginManifestV1 {
  return mv.parseOrThrow({
    id: pluginId,
    apiVersion: PLUGIN_API_VERSION,
    version: "1.0.0",
    displayName: `Plugin ${pluginId}`,
    description: "Test plugin",
    author: "Acme",
    categories: ["connector"],
    capabilities: toolNames.length > 0 ? ["agent.tools.register"] : ["issues.read"],
    entrypoints: { worker: "dist/worker.js" },
    tools: toolNames.map((name) => makeTool(name)),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// TOOL_NAMESPACE_SEPARATOR
// ---------------------------------------------------------------------------

describe("TOOL_NAMESPACE_SEPARATOR", () => {
  it("is a colon", () => {
    expect(TOOL_NAMESPACE_SEPARATOR).toBe(":");
  });
});

// ---------------------------------------------------------------------------
// createPluginToolRegistry — registration
// ---------------------------------------------------------------------------

describe("registerPlugin", () => {
  let registry: PluginToolRegistry;

  beforeEach(() => {
    registry = createPluginToolRegistry();
  });

  it("registers tools from a manifest with tools", () => {
    const m = makeManifest("acme.linear", ["search-issues"]);
    registry.registerPlugin("acme.linear", m);
    expect(registry.toolCount()).toBe(1);
  });

  it("registers multiple tools from the same manifest", () => {
    const m = makeManifest("acme.linear", ["search-issues", "create-issue"]);
    registry.registerPlugin("acme.linear", m);
    expect(registry.toolCount()).toBe(2);
  });

  it("namespaces tools as pluginId:toolName", () => {
    const m = makeManifest("acme.linear", ["search-issues"]);
    registry.registerPlugin("acme.linear", m);
    const tool = registry.getTool("acme.linear:search-issues");
    expect(tool).not.toBeNull();
    expect(tool!.namespacedName).toBe("acme.linear:search-issues");
  });

  it("replaces previously registered tools on re-registration (idempotent)", () => {
    const m1 = makeManifest("acme.linear", ["tool-a", "tool-b"]);
    registry.registerPlugin("acme.linear", m1);
    const m2 = makeManifest("acme.linear", ["tool-c"]);
    registry.registerPlugin("acme.linear", m2);
    expect(registry.toolCount()).toBe(1);
    expect(registry.getTool("acme.linear:tool-a")).toBeNull();
    expect(registry.getTool("acme.linear:tool-c")).not.toBeNull();
  });

  it("stores pluginDbId separately from pluginId", () => {
    const m = makeManifest("acme.linear", ["search-issues"]);
    registry.registerPlugin("acme.linear", m, "db-uuid-123");
    const tool = registry.getTool("acme.linear:search-issues");
    expect(tool!.pluginDbId).toBe("db-uuid-123");
    expect(tool!.pluginId).toBe("acme.linear");
  });

  it("falls back to pluginId for pluginDbId when not provided", () => {
    const m = makeManifest("acme.linear", ["search-issues"]);
    registry.registerPlugin("acme.linear", m);
    expect(registry.getTool("acme.linear:search-issues")!.pluginDbId).toBe("acme.linear");
  });

  it("does nothing (no-op) when manifest has no tools", () => {
    const m = makeManifest("acme.linear", []);
    registry.registerPlugin("acme.linear", m);
    expect(registry.toolCount()).toBe(0);
  });

  it("supports multiple plugins registered independently", () => {
    registry.registerPlugin("plugin-a", makeManifest("plugin-a", ["tool-1"]));
    registry.registerPlugin("plugin-b", makeManifest("plugin-b", ["tool-2"]));
    expect(registry.toolCount()).toBe(2);
    expect(registry.toolCount("plugin-a")).toBe(1);
    expect(registry.toolCount("plugin-b")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// unregisterPlugin
// ---------------------------------------------------------------------------

describe("unregisterPlugin", () => {
  let registry: PluginToolRegistry;

  beforeEach(() => {
    registry = createPluginToolRegistry();
  });

  it("removes all tools for the specified plugin", () => {
    registry.registerPlugin("acme.linear", makeManifest("acme.linear", ["a", "b"]));
    registry.unregisterPlugin("acme.linear");
    expect(registry.toolCount()).toBe(0);
  });

  it("does not affect tools from other plugins", () => {
    registry.registerPlugin("plugin-a", makeManifest("plugin-a", ["tool-a"]));
    registry.registerPlugin("plugin-b", makeManifest("plugin-b", ["tool-b"]));
    registry.unregisterPlugin("plugin-a");
    expect(registry.toolCount()).toBe(1);
    expect(registry.getTool("plugin-b:tool-b")).not.toBeNull();
  });

  it("is a no-op for a plugin that was never registered", () => {
    expect(() => registry.unregisterPlugin("unknown-plugin")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// getTool / getToolByPlugin
// ---------------------------------------------------------------------------

describe("getTool", () => {
  let registry: PluginToolRegistry;

  beforeEach(() => {
    registry = createPluginToolRegistry();
    registry.registerPlugin("acme.linear", makeManifest("acme.linear", ["search-issues"]));
  });

  it("returns the tool for a valid namespaced name", () => {
    const tool = registry.getTool("acme.linear:search-issues");
    expect(tool).not.toBeNull();
    expect(tool!.name).toBe("search-issues");
  });

  it("returns null for an unregistered tool", () => {
    expect(registry.getTool("acme.linear:unknown-tool")).toBeNull();
  });

  it("returns null for a completely different plugin", () => {
    expect(registry.getTool("other.plugin:search-issues")).toBeNull();
  });
});

describe("getToolByPlugin", () => {
  let registry: PluginToolRegistry;

  beforeEach(() => {
    registry = createPluginToolRegistry();
    registry.registerPlugin("acme.linear", makeManifest("acme.linear", ["search-issues"]));
  });

  it("returns the tool when pluginId and toolName are both correct", () => {
    const tool = registry.getToolByPlugin("acme.linear", "search-issues");
    expect(tool).not.toBeNull();
    expect(tool!.namespacedName).toBe("acme.linear:search-issues");
  });

  it("returns null when toolName is not registered for the plugin", () => {
    expect(registry.getToolByPlugin("acme.linear", "unknown")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listTools
// ---------------------------------------------------------------------------

describe("listTools", () => {
  let registry: PluginToolRegistry;

  beforeEach(() => {
    registry = createPluginToolRegistry();
    registry.registerPlugin("plugin-a", makeManifest("plugin-a", ["a1", "a2"]));
    registry.registerPlugin("plugin-b", makeManifest("plugin-b", ["b1"]));
  });

  it("returns all tools when no filter is provided", () => {
    const tools = registry.listTools();
    expect(tools).toHaveLength(3);
  });

  it("returns only tools for the specified plugin when filtered", () => {
    const tools = registry.listTools({ pluginId: "plugin-a" });
    expect(tools).toHaveLength(2);
    expect(tools.every((t) => t.pluginId === "plugin-a")).toBe(true);
  });

  it("returns an empty array when filtering for an unregistered plugin", () => {
    expect(registry.listTools({ pluginId: "unknown-plugin" })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseNamespacedName
// ---------------------------------------------------------------------------

describe("parseNamespacedName", () => {
  const registry = createPluginToolRegistry();

  it("parses a valid namespaced name", () => {
    const result = registry.parseNamespacedName("acme.linear:search-issues");
    expect(result).toEqual({ pluginId: "acme.linear", toolName: "search-issues" });
  });

  it("returns null when there is no colon separator", () => {
    expect(registry.parseNamespacedName("no-separator")).toBeNull();
  });

  it("returns null when the colon is at the start (empty pluginId)", () => {
    expect(registry.parseNamespacedName(":tool-name")).toBeNull();
  });

  it("returns null when the colon is at the end (empty toolName)", () => {
    expect(registry.parseNamespacedName("plugin-id:")).toBeNull();
  });

  it("uses the last colon as separator when the pluginId contains colons", () => {
    // edge case: "a:b:c" → pluginId="a:b", toolName="c"
    const result = registry.parseNamespacedName("a:b:c");
    expect(result).not.toBeNull();
    expect(result!.toolName).toBe("c");
  });
});

// ---------------------------------------------------------------------------
// buildNamespacedName
// ---------------------------------------------------------------------------

describe("buildNamespacedName", () => {
  const registry = createPluginToolRegistry();

  it("combines pluginId and toolName with the colon separator", () => {
    expect(registry.buildNamespacedName("acme.linear", "search-issues"))
      .toBe("acme.linear:search-issues");
  });
});

// ---------------------------------------------------------------------------
// toolCount
// ---------------------------------------------------------------------------

describe("toolCount", () => {
  let registry: PluginToolRegistry;

  beforeEach(() => {
    registry = createPluginToolRegistry();
  });

  it("returns 0 when no plugins are registered", () => {
    expect(registry.toolCount()).toBe(0);
  });

  it("returns the correct total after registrations", () => {
    registry.registerPlugin("a", makeManifest("a", ["t1", "t2"]));
    registry.registerPlugin("b", makeManifest("b", ["t3"]));
    expect(registry.toolCount()).toBe(3);
  });

  it("returns the count scoped to a specific plugin", () => {
    registry.registerPlugin("a", makeManifest("a", ["t1", "t2"]));
    registry.registerPlugin("b", makeManifest("b", ["t3"]));
    expect(registry.toolCount("a")).toBe(2);
    expect(registry.toolCount("b")).toBe(1);
  });

  it("returns 0 for a plugin that was unregistered", () => {
    registry.registerPlugin("a", makeManifest("a", ["t1"]));
    registry.unregisterPlugin("a");
    expect(registry.toolCount("a")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// executeTool — error paths (no workerManager)
// ---------------------------------------------------------------------------

describe("executeTool (no workerManager)", () => {
  it("throws for an invalid tool name format", async () => {
    const registry = createPluginToolRegistry();
    await expect(registry.executeTool("no-separator", {}, {} as never)).rejects.toThrow(
      /Invalid tool name/,
    );
  });

  it("throws when the tool is not registered", async () => {
    const registry = createPluginToolRegistry();
    await expect(
      registry.executeTool("plugin:unknown-tool", {}, {} as never),
    ).rejects.toThrow();
  });

  it("throws 'no worker manager' when tool exists but no workerManager is configured", async () => {
    const registry = createPluginToolRegistry();
    registry.registerPlugin("my-plugin", makeManifest("my-plugin", ["do-thing"]));
    await expect(
      registry.executeTool("my-plugin:do-thing", {}, {} as never),
    ).rejects.toThrow(/no worker manager/i);
  });
});
