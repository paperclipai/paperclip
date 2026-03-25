/**
 * PluginToolRegistry — host-side registry for plugin-contributed agent tools.
 *
 * Responsibilities:
 * - Store tool declarations (from plugin manifests) alongside routing metadata
 *   so the host can resolve namespaced tool names to the owning plugin worker.
 * - Namespace tools automatically: a tool `"search-issues"` from plugin
 *   `"acme.linear"` is exposed to agents as `"acme.linear:search-issues"`.
 * - Route `executeTool` calls to the correct plugin worker via the
 *   `PluginWorkerManager`.
 * - Provide tool discovery queries so agents can list available tools.
 * - Clean up tool registrations when a plugin is unloaded or its worker stops.
 *
 * The registry is an in-memory structure — tool declarations are derived from
 * the plugin manifest at load time and do not need persistence. When a plugin
 * worker restarts, the host re-registers its manifest tools.
 *
 * @see PLUGIN_SPEC.md §11 — Agent Tools
 * @see PLUGIN_SPEC.md §13.10 — `executeTool`
 */

import type {
  PaperclipPluginManifestV1,
  PluginToolDeclaration,
} from "@paperclipai/shared";
import type { ToolRunContext, ToolResult, ExecuteToolParams } from "@paperclipai/plugin-sdk";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Separator between plugin ID and tool name in the namespaced tool identifier.
 *
 * Example: `"acme.linear:search-issues"`
 */
export const TOOL_NAMESPACE_SEPARATOR = ":";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A registered tool entry stored in the registry.
 *
 * Combines the manifest-level declaration with routing metadata so the host
 * can resolve a namespaced tool name → plugin worker in O(1).
 */
export interface RegisteredTool {
  /** The plugin key used for namespacing (e.g. `"acme.linear"`). */
  pluginId: string;
  /**
   * The plugin's database UUID, used for worker routing and availability
   * checks. Falls back to `pluginId` when not provided (e.g. in tests
   * where `id === pluginKey`).
   */
  pluginDbId: string;
  /** The tool's bare name (without namespace prefix). */
  name: string;
  /** Fully namespaced identifier: `"<pluginId>:<toolName>"`. */
  namespacedName: string;
  /** Human-readable display name. */
  displayName: string;
  /** Description provided to the agent so it knows when to use this tool. */
  description: string;
  /** JSON Schema describing the tool's input parameters. */
  parametersSchema: Record<string, unknown>;
}

/**
 * Filter criteria for listing available tools.
 */
export interface ToolListFilter {
  /** Only return tools owned by this plugin. */
  pluginId?: string;
}

/**
 * Result of executing a tool, extending `ToolResult` with routing metadata.
 */
export interface ToolExecutionResult {
  /** The plugin that handled the tool call. */
  pluginId: string;
  /** The bare tool name that was executed. */
  toolName: string;
  /** The result returned by the plugin's tool handler. */
  result: ToolResult;
}

// ---------------------------------------------------------------------------
// PluginToolRegistry interface
// ---------------------------------------------------------------------------

/**
 * The host-side tool registry — held by the host process.
 *
 * Created once at server startup and shared across the application. Plugins
 * register their tools when their worker starts, and unregister when the
 * worker stops or the plugin is uninstalled.
 */
export interface PluginToolRegistry {
  /**
   * Register all tools declared in a plugin's manifest.
   *
   * Called when a plugin worker starts and its manifest is loaded. Any
   * previously registered tools for the same plugin are replaced (idempotent).
   *
   * @param pluginId - The plugin's unique identifier (e.g. `"acme.linear"`)
   * @param manifest - The plugin manifest containing the `tools` array
   * @param pluginDbId - The plugin's database UUID, used for worker routing
   *   and availability checks. If omitted, `pluginId` is used (backwards-compat).
   */
  registerPlugin(pluginId: string, manifest: PaperclipPluginManifestV1, pluginDbId?: string): void;

  /**
   * Remove all tool registrations for a plugin.
   *
   * Called when a plugin worker stops, crashes, or is uninstalled.
   *
   * @param pluginId - The plugin to clear
   */
  unregisterPlugin(pluginId: string): void;

  /**
   * Look up a registered tool by its namespaced name.
   *
   * @param namespacedName - Fully qualified name, e.g. `"acme.linear:search-issues"`
   * @returns The registered tool entry, or `null` if not found
   */
  getTool(namespacedName: string): RegisteredTool | null;

  /**
   * Look up a registered tool by plugin ID and bare tool name.
   *
   * @param pluginId - The owning plugin
   * @param toolName - The bare tool name (without namespace prefix)
   * @returns The registered tool entry, or `null` if not found
   */
  getToolByPlugin(pluginId: string, toolName: string): RegisteredTool | null;

  /**
   * List all registered tools, optionally filtered.
   *
   * @param filter - Optional filter criteria
   * @returns Array of registered tool entries
   */
  listTools(filter?: ToolListFilter): RegisteredTool[];

  /**
   * Parse a namespaced tool name into plugin ID and bare tool name.
   *
   * @param namespacedName - e.g. `"acme.linear:search-issues"`
   * @returns `{ pluginId, toolName }` or `null` if the format is invalid
   */
  parseNamespacedName(namespacedName: string): { pluginId: string; toolName: string } | null;

  /**
   * Build a namespaced tool name from a plugin ID and bare tool name.
   *
   * @param pluginId - e.g. `"acme.linear"`
   * @param toolName - e.g. `"search-issues"`
   * @returns The namespaced name, e.g. `"acme.linear:search-issues"`
   */
  buildNamespacedName(pluginId: string, toolName: string): string;

  /**
   * Execute a tool by its namespaced name, routing to the correct plugin worker.
   *
   * Resolves the namespaced name to the owning plugin, validates the tool
   * exists, and dispatches the `executeTool` RPC call to the worker.
   *
   * @param namespacedName - Fully qualified tool name (e.g. `"acme.linear:search-issues"`)
   * @param parameters - The parsed parameters matching the tool's schema
   * @param runContext - Agent run context
   * @returns The execution result with routing metadata
   * @throws {Error} if the tool is not found or the worker is not running
   */
  executeTool(
    namespacedName: string,
    parameters: unknown,
    runContext: ToolRunContext,
  ): Promise<ToolExecutionResult>;

  /**
   * Get the number of registered tools, optionally scoped to a plugin.
   *
   * @param pluginId - If provided, count only this plugin's tools
   */
  toolCount(pluginId?: string): number;
}

// ---------------------------------------------------------------------------
// Factory: createPluginToolRegistry
// ---------------------------------------------------------------------------

/**
 * Create a new `PluginToolRegistry`.
 *
 * The registry is backed by two in-memory maps:
 * - `byNamespace`: namespaced name → `RegisteredTool` for O(1) lookups.
 * - `byPlugin`: pluginId → Set of namespaced names for efficient per-plugin ops.
 *
 * @param workerManager - The worker manager used to dispatch `executeTool` RPC
 *   calls to plugin workers. If not provided, `executeTool` will throw.
 *
 * @example
 * ```ts
 * const toolRegistry = createPluginToolRegistry(workerManager);
 *
 * // Register tools from a plugin manifest
 * toolRegistry.registerPlugin("acme.linear", linearManifest);
 *
 * // List all available tools for agents
 * const tools = toolRegistry.listTools();
 * // → [{ namespacedName: "acme.linear:search-issues", ... }]
 *
 * // Execute a tool
 * const result = await toolRegistry.executeTool(
 *   "acme.linear:search-issues",
 *   { query: "auth bug" },
 *   { agentId: "agent-1", runId: "run-1", companyId: "co-1", projectId: "proj-1" },
 * );
 * ```
 */
export function createPluginToolRegistry(
  workerManager?: PluginWorkerManager,
): PluginToolRegistry {
  const log = logger.child({ service: "plugin-tool-registry" });

  // Primary index: namespaced name → tool entry
  const byNamespace = new Map<string, RegisteredTool>();

  // Secondary index: pluginId → set of namespaced names (for bulk operations)
  const byPlugin = new Map<string, Set<string>>();

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  function buildName(pluginId: string, toolName: string): string {
    return `${pluginId}${TOOL_NAMESPACE_SEPARATOR}${toolName}`;
  }

  function parseName(namespacedName: string): { pluginId: string; toolName: string } | null {
    const sepIndex = namespacedName.lastIndexOf(TOOL_NAMESPACE_SEPARATOR);
    if (sepIndex <= 0 || sepIndex >= namespacedName.length - 1) {
      return null;
    }
    return {
      pluginId: namespacedName.slice(0, sepIndex),
      toolName: namespacedName.slice(sepIndex + 1),
    };
  }

  function addTool(pluginId: string, decl: PluginToolDeclaration, pluginDbId: string): void {
    const namespacedName = buildName(pluginId, decl.name);

    const entry: RegisteredTool = {
      pluginId,
      pluginDbId,
      name: decl.name,
      namespacedName,
      displayName: decl.displayName,
      description: decl.description,
      parametersSchema: decl.parametersSchema,
    };

    byNamespace.set(namespacedName, entry);

    let pluginTools = byPlugin.get(pluginId);
    if (!pluginTools) {
      pluginTools = new Set();
      byPlugin.set(pluginId, pluginTools);
    }
    pluginTools.add(namespacedName);
  }

  function removePluginTools(pluginId: string): number {
    const pluginTools = byPlugin.get(pluginId);
    if (!pluginTools) return 0;

    const count = pluginTools.size;
    for (const name of pluginTools) {
      byNamespace.delete(name);
    }
    byPlugin.delete(pluginId);

    return count;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    registerPlugin(pluginId: string, manifest: PaperclipPluginManifestV1, pluginDbId?: string): void {
      const dbId = pluginDbId ?? pluginId;

      // Remove any previously registered tools for this plugin (idempotent)
      const previousCount = removePluginTools(pluginId);
      if (previousCount > 0) {
        log.debug(
          { pluginId, previousCount },
          "cleared previous tool registrations before re-registering",
        );
      }

      const tools = manifest.tools ?? [];
      if (tools.length === 0) {
        log.debug({ pluginId }, "plugin declares no tools");
        return;
      }

      for (const decl of tools) {
        addTool(pluginId, decl, dbId);
      }

      log.info(
        {
          pluginId,
          toolCount: tools.length,
          tools: tools.map((t) => buildName(pluginId, t.name)),
        },
        `registered ${tools.length} tool(s) for plugin`,
      );
    },

    unregisterPlugin(pluginId: string): void {
      const removed = removePluginTools(pluginId);
      if (removed > 0) {
        log.info(
          { pluginId, removedCount: removed },
          `unregistered ${removed} tool(s) for plugin`,
        );
      }
    },

    getTool(namespacedName: string): RegisteredTool | null {
      return byNamespace.get(namespacedName) ?? null;
    },

    getToolByPlugin(pluginId: string, toolName: string): RegisteredTool | null {
      const namespacedName = buildName(pluginId, toolName);
      return byNamespace.get(namespacedName) ?? null;
    },

    listTools(filter?: ToolListFilter): RegisteredTool[] {
      if (filter?.pluginId) {
        const pluginTools = byPlugin.get(filter.pluginId);
        if (!pluginTools) return [];
        const result: RegisteredTool[] = [];
        for (const name of pluginTools) {
          const tool = byNamespace.get(name);
          if (tool) result.push(tool);
        }
        return result;
      }

      return Array.from(byNamespace.values());
    },

    parseNamespacedName(namespacedName: string): { pluginId: string; toolName: string } | null {
      return parseName(namespacedName);
    },

    buildNamespacedName(pluginId: string, toolName: string): string {
      return buildName(pluginId, toolName);
    },

    async executeTool(
      namespacedName: string,
      parameters: unknown,
      runContext: ToolRunContext,
    ): Promise<ToolExecutionResult> {
      // 1. Resolve the namespaced name
      const parsed = parseName(namespacedName);
      if (!parsed) {
        throw new Error(
          `Invalid tool name "${namespacedName}". Expected format: "<pluginId>${TOOL_NAMESPACE_SEPARATOR}<toolName>"`,
        );
      }

      const { pluginId, toolName } = parsed;

      // 2. Verify the tool is registered
      const tool = byNamespace.get(namespacedName);
      if (!tool) {
        throw new Error(
          `Tool "${namespacedName}" is not registered. ` +
          `The plugin may not be installed or its worker may not be running.`,
        );
      }

      // 3. Verify the worker manager is available
      if (!workerManager) {
        throw new Error(
          `Cannot execute tool "${namespacedName}" — no worker manager configured. ` +
          `Tool execution requires a PluginWorkerManager.`,
        );
      }

      // 4. Verify the plugin worker is running (use DB UUID for worker lookup)
      const dbId = tool.pluginDbId;
      if (!workerManager.isRunning(dbId)) {
        throw new Error(
          `Cannot execute tool "${namespacedName}" — ` +
          `worker for plugin "${pluginId}" is not running.`,
        );
      }

      // 5. Dispatch the executeTool RPC call to the worker
      log.debug(
        { pluginId, pluginDbId: dbId, toolName, namespacedName, agentId: runContext.agentId, runId: runContext.runId },
        "executing tool via plugin worker",
      );

      const rpcParams: ExecuteToolParams = {
        toolName,
        parameters,
        runContext,
      };

      const result = await workerManager.call(dbId, "executeTool", rpcParams);

      log.debug(
        {
          pluginId,
          toolName,
          namespacedName,
          hasContent: !!result.content,
          hasData: result.data !== undefined,
          hasError: !!result.error,
        },
        "tool execution completed",
      );

      return { pluginId, toolName, result };
    },

    toolCount(pluginId?: string): number {
      if (pluginId !== undefined) {
        return byPlugin.get(pluginId)?.size ?? 0;
      }
      return byNamespace.size;
    },
  };
}
