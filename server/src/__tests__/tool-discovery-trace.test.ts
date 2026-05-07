/**
 * Tests for ToolDiscoveryLogger — MCP-first resolution order and
 * fallback to web search.
 *
 * Covers scope #2 and #4 from KIN-617:
 * - MCP tool discovery is attempted before fallback pathways
 * - Selection decisions are logged for observability
 * - Fallback web search when no MCP tools match
 */

import { describe, expect, it } from "vitest";
import {
  createToolDiscoveryLogger,
} from "../services/tool-discovery-trace.js";
import type {
  PluginToolDispatcher,
  AgentToolDescriptor,
  RegisteredTool,
} from "../services/plugin-tool-dispatcher.js";

// ---------------------------------------------------------------------------
// Stub dispatcher helpers
// ---------------------------------------------------------------------------

function stubDispatcher(tools: AgentToolDescriptor[]): PluginToolDispatcher {
  const registryTools = tools.map((t) => ({
    pluginId: t.pluginId,
    pluginDbId: t.pluginId,
    name: t.name.split(":").pop() ?? t.name,
    namespacedName: t.name,
    displayName: t.displayName,
    description: t.description,
    parametersSchema: t.parametersSchema,
  } satisfies RegisteredTool));

  return {
    listToolsForAgent: () => tools,
    getTool: (name: string) => registryTools.find((r) => r.namespacedName === name) ?? null,
    executeTool: async () => {
      throw new Error("not implemented in stub");
    },
  } as unknown as PluginToolDispatcher;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ToolDiscoveryLogger — MCP-first resolution", () => {
  const runContext = {
    runId: "run-1",
    agentId: "agent-1",
    companyId: "co-1",
    projectId: "proj-1",
  };

  it("resolves exact namespaced tool via MCP", async () => {
    const dispatcher = stubDispatcher([
      {
        name: "acme.linear:search-issues",
        displayName: "Search Issues",
        description: "Search Linear issues",
        parametersSchema: {},
        pluginId: "acme.linear",
      },
    ]);

    const logger = createToolDiscoveryLogger({ dispatcher });
    const { trace, resolvedTool, resolution } = await logger.resolveTool(
      "acme.linear:search-issues",
      runContext,
    );

    expect(resolution).toBe("mcp_plugin");
    expect(resolvedTool).toBe("acme.linear:search-issues");
    expect(trace.mcpQueried).toBe(true);
    expect(trace.mcpCandidates).toContain("acme.linear:search-issues");
  });

  it("resolves via candidate match when bare name used", async () => {
    const dispatcher = stubDispatcher([
      {
        name: "kinetica-rag:search_code",
        displayName: "Search Code",
        description: "Search codebase",
        parametersSchema: {},
        pluginId: "kinetica-rag",
      },
    ]);

    const logger = createToolDiscoveryLogger({ dispatcher });
    const { trace, resolution } = await logger.resolveTool(
      "search_code",
      runContext,
    );

    expect(resolution).toBe("mcp_plugin");
    expect(trace.mcpCandidates).toContain("kinetica-rag:search_code");
  });

  it("resolves namespaced name from multiple MCP candidates", async () => {
    const dispatcher = stubDispatcher([
      {
        name: "acme.linear:search-issues",
        displayName: "Search Issues",
        description: "Search Linear",
        parametersSchema: {},
        pluginId: "acme.linear",
      },
      {
        name: "acme.jira:search-issues",
        displayName: "Search Jira",
        description: "Search Jira issues",
        parametersSchema: {},
        pluginId: "acme.jira",
      },
    ]);

    const logger = createToolDiscoveryLogger({ dispatcher });
    const { trace, resolvedTool, resolution } = await logger.resolveTool(
      "search-issues",
      runContext,
    );

    expect(resolution).toBe("mcp_plugin");
    expect(trace.mcpCandidates.length).toBeGreaterThanOrEqual(2);
    // First candidate is chosen.
    expect(resolvedTool).toBe(trace.mcpCandidates[0]);
  });

  it("falls back to web search when no MCP candidates", async () => {
    const dispatcher = stubDispatcher([
      {
        name: "acme.linear:search-issues",
        displayName: "Search Issues",
        description: "Search",
        parametersSchema: {},
        pluginId: "acme.linear",
      },
    ]);

    const logger = createToolDiscoveryLogger({ dispatcher });
    const { trace, resolvedTool, resolution } = await logger.resolveTool(
      "web_search",
      runContext,
    );

    expect(resolution).toBe("fallback_web_search");
    expect(resolvedTool).toBe("web_search");
    expect(trace.mcpQueried).toBe(true);
    expect(trace.mcpSkipReason).toContain("no matching MCP tools");
  });

  it("reports no dispatcher when dispatcher is null", async () => {
    const logger = createToolDiscoveryLogger({ dispatcher: null });
    const { trace, resolution } = await logger.resolveTool(
      "some-tool",
      runContext,
    );

    expect(resolution).toBe("fallback_web_search");
    expect(trace.mcpQueried).toBe(false);
    expect(trace.mcpSkipReason).toBe("no dispatcher configured");
  });

  it("finalizeTrace updates duration and error", () => {
    const logger = createToolDiscoveryLogger({ dispatcher: null });
    const trace = {
      traceId: "td-test",
      runId: "run-1",
      agentId: "agent-1",
      startedAt: new Date().toISOString(),
      requestedTool: "test",
      resolution: "mcp_plugin" as const,
      mcpCandidates: [],
      mcpQueried: true,
      mcpSkipReason: null,
      resolvedTool: "test:tool",
      durationMs: 0,
      error: null,
    };

    // Should not throw.
    logger.finalizeTrace(trace, { durationMs: 1250, error: null });
    expect(trace.durationMs).toBe(1250);
    expect(trace.error).toBeNull();

    logger.finalizeTrace(trace, { durationMs: 500, error: "Connection refused" });
    expect(trace.durationMs).toBe(500);
    expect(trace.error).toBe("Connection refused");
  });
});

describe("ToolDiscoveryLogger — resolution order", () => {
  const runContext = {
    runId: "run-2",
    agentId: "agent-2",
    companyId: "co-2",
    projectId: "proj-2",
  };

  it("MCP exact match takes priority over candidate match", async () => {
    const dispatcher = stubDispatcher([
      {
        name: "plugin-a:exact",
        displayName: "Exact",
        description: "Exact match",
        parametersSchema: {},
        pluginId: "plugin-a",
      },
      {
        name: "plugin-b:exact-ish",
        displayName: "Ish",
        description: "Partial match",
        parametersSchema: {},
        pluginId: "plugin-b",
      },
    ]);

    const logger = createToolDiscoveryLogger({ dispatcher });
    const { resolvedTool, resolution } = await logger.resolveTool(
      "plugin-a:exact",
      runContext,
    );

    expect(resolution).toBe("mcp_plugin");
    expect(resolvedTool).toBe("plugin-a:exact");
  });

  it("fallback is always last resort", async () => {
    const dispatcher = stubDispatcher([]);
    const logger = createToolDiscoveryLogger({ dispatcher });
    const { resolution, resolvedTool } = await logger.resolveTool(
      "anything",
      runContext,
    );

    expect(resolution).toBe("fallback_web_search");
    expect(resolvedTool).toBe("web_search");
  });
});
