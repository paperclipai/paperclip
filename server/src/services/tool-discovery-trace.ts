/**
 * ToolDiscoveryTrace — structured observability for agent tool selection.
 *
 * Every tool-call decision made by an agent (MCP plugin → fallback web search
 * → none available) is logged with a Trace entry so operators can inspect why
 * a particular pathway was chosen and whether MCP servers were reachable.
 *
 * Design:
 * - The trace is built *before* tool execution and finalized *after*.
 * - Resolution order is always: (1) MCP plugin tools → (2) fallback web search.
 * - Traces are emitted to the structured logger under service "tool-discovery".
 */

import { logger } from "../middleware/logger.js";
import type { PluginToolDispatcher, AgentToolDescriptor } from "./plugin-tool-dispatcher.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToolDiscoveryResolution =
  | "mcp_plugin"
  | "fallback_web_search"
  | "none_available"
  | "parametrized_unknown";

export interface ToolDiscoveryTrace {
  /** Unique trace id — one per agent tool-call decision. */
  traceId: string;
  /** The agent run that initiated the call. */
  runId: string;
  agentId: string;
  /** Timestamp when the tool discovery attempt started. */
  startedAt: string;
  /** The raw tool name the agent requested (may be namespaced). */
  requestedTool: string;
  /** How the tool was resolved. */
  resolution: ToolDiscoveryResolution;
  /** MCP tools that were considered (empty if none registered). */
  mcpCandidates: string[];
  /** Whether MCP server was reachable / tools were queried. */
  mcpQueried: boolean;
  /** If MCP was skipped, why. */
  mcpSkipReason: string | null;
  /** Final tool that was executed (namespaced for MCP, or fallback name). */
  resolvedTool: string | null;
  /** Duration of the discovery + execution phase in ms. */
  durationMs: number;
  /** Error message if tool execution failed. */
  error: string | null;
}

export interface ToolDiscoveryOptions {
  /** The plugin tool dispatcher (can be null if no plugins configured). */
  dispatcher: PluginToolDispatcher | null;
}

// ---------------------------------------------------------------------------
// ToolDiscoveryLogger
// ---------------------------------------------------------------------------

export interface ToolDiscoveryLogger {
  /**
   * Build a trace entry by querying the MCP registry first, then falling
   * back to web search if no MCP tool matches.
   *
   * Resolution order:
   *   1. Direct namespaced match (e.g. "acme.linear:search-issues")
   *   2. Suffix match: search MCP tools whose bare name contains the
   *      requested tool string
   *   3. Fallback web search (if no MCP candidates found)
   *   4. `none_available` if neither MCP nor fallback applies
   */
  resolveTool(requestedTool: string, runContext: {
    runId: string;
    agentId: string;
    companyId: string;
    projectId: string;
  }): Promise<{
    trace: ToolDiscoveryTrace;
    resolvedTool: string | null;
    resolution: ToolDiscoveryResolution;
  }>;

  /** Finalize and emit a trace (call once tool execution completes). */
  finalizeTrace(
    trace: ToolDiscoveryTrace,
    outcome: { durationMs: number; error: string | null },
  ): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createToolDiscoveryLogger(
  options: ToolDiscoveryOptions,
): ToolDiscoveryLogger {
  const log = logger.child({ service: "tool-discovery" });
  const { dispatcher } = options;

  function formatTimestamp(): string {
    return new Date().toISOString();
  }

  function findMcpCandidates(requestedTool: string): string[] {
    if (!dispatcher) return [];
    const allTools = dispatcher.listToolsForAgent();
    return allTools
      .filter(
        (t) =>
          t.name === requestedTool ||
          t.name.endsWith(`:${requestedTool}`) ||
          t.name.includes(requestedTool),
      )
      .map((t) => t.name);
  }

  return {
    async resolveTool(requestedTool, runContext) {
      const startedAt = formatTimestamp();
      const traceId = `td-${runContext.runId}-${Date.now().toString(36)}`;

      // If the tool name already has a namespace prefix, try exact match first.
      if (requestedTool.includes(":")) {
        const exact = dispatcher?.getTool(requestedTool) ?? null;

        if (exact) {
          const trace: ToolDiscoveryTrace = {
            traceId,
            runId: runContext.runId,
            agentId: runContext.agentId,
            startedAt,
            requestedTool,
            resolution: "mcp_plugin",
            mcpCandidates: [requestedTool],
            mcpQueried: true,
            mcpSkipReason: null,
            resolvedTool: exact.namespacedName,
            durationMs: 0,
            error: null,
          };

          log.info(
            {
              traceId,
              agentId: runContext.agentId,
              tool: requestedTool,
              resolution: "mcp_plugin",
            },
            "Tool resolved via MCP (exact match)",
          );

          return { trace, resolvedTool: exact.namespacedName, resolution: "mcp_plugin" as const };
        }

        // Namespaced but not found — log and fall through to candidate search.
        log.warn(
          {
            traceId,
            agentId: runContext.agentId,
            tool: requestedTool,
          },
          "Namespaced tool not found in registry, searching candidates",
        );
      }

      // Search for MCP candidates by partial name match.
      const mcpCandidates = findMcpCandidates(requestedTool);
      const mcpQueried = dispatcher !== null;

      if (mcpCandidates.length > 0) {
        const bestMatch = mcpCandidates[0];
        const trace: ToolDiscoveryTrace = {
          traceId,
          runId: runContext.runId,
          agentId: runContext.agentId,
          startedAt,
          requestedTool,
          resolution: "mcp_plugin",
          mcpCandidates,
          mcpQueried,
          mcpSkipReason: null,
          resolvedTool: bestMatch,
          durationMs: 0,
          error: null,
        };

        log.info(
          {
            traceId,
            agentId: runContext.agentId,
            tool: requestedTool,
            resolution: "mcp_plugin",
            candidates: mcpCandidates,
            chosen: bestMatch,
          },
          "Tool resolved via MCP (candidate match)",
        );

        return { trace, resolvedTool: bestMatch, resolution: "mcp_plugin" as const };
      }

      // No MCP match — fall back to web search.
      const trace: ToolDiscoveryTrace = {
        traceId,
        runId: runContext.runId,
        agentId: runContext.agentId,
        startedAt,
        requestedTool,
        resolution: "fallback_web_search",
        mcpCandidates: [],
        mcpQueried,
        mcpSkipReason:
          dispatcher === null
            ? "no dispatcher configured"
            : "no matching MCP tools registered",
        resolvedTool: "web_search",
        durationMs: 0,
        error: null,
      };

      log.info(
        {
          traceId,
          agentId: runContext.agentId,
          tool: requestedTool,
          resolution: "fallback_web_search",
          mcpQueried,
          reason: trace.mcpSkipReason,
        },
        "Tool not found in MCP — falling back to web search",
      );

      return { trace, resolvedTool: "web_search", resolution: "fallback_web_search" as const };
    },

    finalizeTrace(trace, outcome) {
      trace.durationMs = outcome.durationMs;
      trace.error = outcome.error;

      const level = outcome.error ? "error" : "debug";
      log[level](
        {
          traceId: trace.traceId,
          agentId: trace.agentId,
          runId: trace.runId,
          tool: trace.requestedTool,
          resolution: trace.resolution,
          resolvedTool: trace.resolvedTool,
          durationMs: outcome.durationMs,
          mcpQueried: trace.mcpQueried,
          error: outcome.error,
        },
        outcome.error
          ? `Tool call failed: ${outcome.error}`
          : "Tool call completed",
      );
    },
  };
}
