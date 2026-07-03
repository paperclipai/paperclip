import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { projects } from "@paperclipai/db";
import type {
  AgentMcpToolDescriptor,
  AgentMcpToolListResponse,
  ExecuteMergedAgentToolRequest,
  ExecuteMergedAgentToolResponse,
  MergedAgentToolIndexEntry,
  MergedAgentToolIndexResponse,
  MergedAgentToolSchemaResponse,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { agentMcpToolService } from "./agent-mcp-tools.js";
import type { AgentToolDescriptor, PluginToolDispatcher } from "./plugin-tool-dispatcher.js";
import { secretService } from "./secrets.js";

// Merged plugin + MCP tool catalog for one agent (NEO-286 D2-4, plan §5).
//
// This is the single data path agents use to learn their tool surface at
// init: a compact index (no inline JSON schemas), an on-demand schema
// endpoint, and one execute endpoint that routes MCP tools through the
// company-scoped client manager and plugin tools through the dispatcher.

/**
 * Qualified-name prefix for MCP tools in the merged index. Plugin tools keep
 * their dispatcher names (`"<pluginKey>:<toolName>"`); a plugin key equal to
 * "mcp" would be shadowed here, so the prefix is effectively reserved.
 */
export const MCP_TOOL_NAME_PREFIX = "mcp";

/** Compact-index descriptions are trimmed to this many characters. */
export const COMPACT_DESCRIPTION_MAX_CHARS = 240;

export function mcpQualifiedToolName(serverSlug: string, toolName: string): string {
  return `${MCP_TOOL_NAME_PREFIX}:${serverSlug}:${toolName}`;
}

export function parseMcpQualifiedToolName(
  name: string,
): { serverSlug: string; toolName: string } | null {
  if (!name.startsWith(`${MCP_TOOL_NAME_PREFIX}:`)) return null;
  const rest = name.slice(MCP_TOOL_NAME_PREFIX.length + 1);
  const separator = rest.indexOf(":");
  if (separator <= 0 || separator === rest.length - 1) return null;
  return {
    serverSlug: rest.slice(0, separator),
    toolName: rest.slice(separator + 1),
  };
}

function compactDescription(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length === 0) return null;
  if (trimmed.length <= COMPACT_DESCRIPTION_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, COMPACT_DESCRIPTION_MAX_CHARS - 1)}…`;
}

function hasSchemaProperties(schema: Record<string, unknown> | null | undefined): boolean {
  if (!schema) return false;
  return Object.keys(schema).length > 0;
}

function pluginIndexEntry(tool: AgentToolDescriptor): MergedAgentToolIndexEntry {
  return {
    source: "plugin",
    name: tool.name,
    displayName: tool.displayName || null,
    description: compactDescription(tool.description),
    hasInputSchema: hasSchemaProperties(tool.parametersSchema),
    pluginId: tool.pluginId,
  };
}

function mcpIndexEntry(tool: AgentMcpToolDescriptor): MergedAgentToolIndexEntry {
  return {
    source: "mcp",
    name: mcpQualifiedToolName(tool.serverSlug, tool.toolName),
    displayName: tool.title,
    description: compactDescription(tool.description),
    hasInputSchema: hasSchemaProperties(tool.inputSchema),
    serverId: tool.serverId,
    serverSlug: tool.serverSlug,
    serverName: tool.serverName,
    bindingMode: tool.bindingMode,
  };
}

/**
 * Compact run-context projection of an agent's MCP tool catalog (plan §5
 * context-bloat control): no inline input schemas, trimmed descriptions,
 * per-server summaries without tool arrays. The full schemas stay behind the
 * on-demand schema endpoint; the prompt layer only needs names + summaries.
 */
export function buildCompactMcpRunContext(catalog: AgentMcpToolListResponse): {
  servers: Array<{
    serverId: string;
    serverName: string;
    serverSlug: string;
    bindingMode: string;
    toolCount: number;
  }>;
  tools: Array<{
    serverId: string;
    serverName: string;
    serverSlug: string;
    toolName: string;
    name: string;
    description: string | null;
  }>;
} {
  return {
    servers: catalog.servers.map((server) => ({
      serverId: server.serverId,
      serverName: server.serverName,
      serverSlug: server.serverSlug,
      bindingMode: server.bindingMode,
      toolCount: server.toolCount,
    })),
    tools: catalog.tools.map((tool) => ({
      serverId: tool.serverId,
      serverName: tool.serverName,
      serverSlug: tool.serverSlug,
      toolName: tool.toolName,
      name: mcpQualifiedToolName(tool.serverSlug, tool.toolName),
      description: compactDescription(tool.description),
    })),
  };
}

export interface AgentToolCatalogDeps {
  /** Required unless `mcpTools` is injected (tests). */
  secrets?: ReturnType<typeof secretService>;
  /** Absent (null) when plugin tool dispatch is not enabled on this host. */
  toolDispatcher?: Pick<PluginToolDispatcher, "listToolsForAgent" | "getTool" | "executeTool"> | null;
  /** Injectable for tests; defaults to the real db-backed service. */
  mcpTools?: Pick<ReturnType<typeof agentMcpToolService>, "listForAgent" | "executeForRun">;
  /** Injectable for tests; defaults to a db lookup on `projects`. */
  resolveProjectCompanyId?: (projectId: string) => Promise<string | null>;
}

export function agentToolCatalogService(db: Db, deps: AgentToolCatalogDeps) {
  const mcpTools =
    deps.mcpTools ??
    agentMcpToolService(db, { secrets: deps.secrets ?? secretService(db) });
  const toolDispatcher = deps.toolDispatcher ?? null;
  const resolveProjectCompanyId =
    deps.resolveProjectCompanyId ??
    (async (projectId: string) => {
      const [project] = await db
        .select({ companyId: projects.companyId })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      return project?.companyId ?? null;
    });

  function listPluginTools(): AgentToolDescriptor[] {
    // Plugin tools are instance-global today (no per-agent plugin scoping);
    // the merged index simply includes all dispatchable plugin tools.
    return toolDispatcher ? toolDispatcher.listToolsForAgent() : [];
  }

  async function listMergedIndex(
    companyId: string,
    agentId: string,
  ): Promise<MergedAgentToolIndexResponse> {
    const mcpCatalog = await mcpTools.listForAgent(agentId, { companyId });
    const pluginEntries = listPluginTools().map(pluginIndexEntry);
    const mcpEntries = mcpCatalog.tools.map(mcpIndexEntry);
    const tools = [...pluginEntries, ...mcpEntries].sort((a, b) =>
      a.name.localeCompare(b.name),
    );

    return {
      companyId,
      agentId,
      counts: {
        plugin: pluginEntries.length,
        mcp: mcpEntries.length,
        total: tools.length,
      },
      tools,
      schemaPath: `/api/companies/${companyId}/agents/${agentId}/tools/schema`,
      executePath: `/api/companies/${companyId}/agents/${agentId}/tools/execute`,
    };
  }

  async function getToolSchema(
    companyId: string,
    agentId: string,
    name: string,
  ): Promise<MergedAgentToolSchemaResponse> {
    const mcpName = parseMcpQualifiedToolName(name);
    if (mcpName) {
      const catalog = await mcpTools.listForAgent(agentId, { companyId });
      const tool = catalog.tools.find(
        (candidate) =>
          candidate.serverSlug === mcpName.serverSlug &&
          candidate.toolName === mcpName.toolName,
      );
      if (tool) {
        return {
          source: "mcp",
          name,
          displayName: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          serverId: tool.serverId,
          serverSlug: tool.serverSlug,
          serverName: tool.serverName,
        };
      }
      // Fall through: an "mcp:*"-named plugin tool is legal, just discouraged.
    }

    const pluginTool = toolDispatcher?.getTool(name) ?? null;
    if (pluginTool) {
      return {
        source: "plugin",
        name: pluginTool.namespacedName,
        displayName: pluginTool.displayName || null,
        description: pluginTool.description || null,
        inputSchema: pluginTool.parametersSchema,
        pluginId: pluginTool.pluginId,
      };
    }

    throw notFound(`Tool "${name}" is not available to this agent`);
  }

  async function execute(
    runContext: {
      companyId: string;
      agentId: string;
      runId: string;
      workspacePath?: string | null;
    },
    request: ExecuteMergedAgentToolRequest,
  ): Promise<ExecuteMergedAgentToolResponse> {
    const mcpName = parseMcpQualifiedToolName(request.name);
    if (mcpName) {
      const catalog = await mcpTools.listForAgent(runContext.agentId, {
        companyId: runContext.companyId,
      });
      const isBound = catalog.tools.some(
        (candidate) =>
          candidate.serverSlug === mcpName.serverSlug &&
          candidate.toolName === mcpName.toolName,
      );
      if (isBound) {
        const result = await mcpTools.executeForRun(
          {
            agentId: runContext.agentId,
            companyId: runContext.companyId,
            workspacePath: runContext.workspacePath,
          },
          {
            serverName: mcpName.serverSlug,
            toolName: mcpName.toolName,
            arguments: request.arguments ?? {},
          },
        );
        return {
          ok: result.ok,
          source: "mcp",
          name: request.name,
          content: result.content,
          data: result.data,
          error: result.error,
        };
      }
      // Fall through to the plugin dispatcher, mirroring getToolSchema.
    }

    if (!toolDispatcher || !toolDispatcher.getTool(request.name)) {
      throw notFound(`Tool "${request.name}" is not available to this agent`);
    }

    // Plugin tool runs are project-scoped (ToolRunContext requires a
    // projectId); the project must belong to the calling company.
    const projectId = request.projectId ?? null;
    if (!projectId) {
      throw unprocessable('"projectId" is required to execute a plugin tool');
    }
    const projectCompanyId = await resolveProjectCompanyId(projectId);
    if (projectCompanyId !== runContext.companyId) {
      throw unprocessable('"projectId" does not belong to this company');
    }

    const execution = await toolDispatcher.executeTool(request.name, request.arguments ?? {}, {
      agentId: runContext.agentId,
      runId: runContext.runId,
      companyId: runContext.companyId,
      projectId,
    });
    return {
      ok: !execution.result.error,
      source: "plugin",
      name: request.name,
      content: execution.result.content ?? null,
      data: execution.result.data ?? null,
      error: execution.result.error ?? null,
    };
  }

  return {
    listMergedIndex,
    getToolSchema,
    execute,
  };
}
