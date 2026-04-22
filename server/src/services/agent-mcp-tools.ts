import type { Db } from "@paperclipai/db";
import type {
  AgentMcpServerBindingDetail,
  AgentMcpToolDescriptor,
  AgentMcpToolListResponse,
  ExecuteAgentMcpToolRequest,
  ExecuteAgentMcpToolResponse,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { mcpServerService } from "./mcp-servers.js";
import type { secretService } from "./secrets.js";

function normalizeName(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().toLowerCase() : null;
}

export function agentMcpToolService(
  db: Db,
  deps: {
    secrets: ReturnType<typeof secretService>;
  },
) {
  const mcpServers = mcpServerService(db, { secrets: deps.secrets });

  async function listForAgent(agentId: string): Promise<AgentMcpToolListResponse> {
    const bindings = await mcpServers.listBindingsForAgent(agentId);
    const servers = bindings
      .filter((binding) => binding.enabled && binding.server.enabled)
      .map((binding) => {
        const allowedTools = new Set(binding.allowedTools);
        const tools = (binding.latestSnapshot?.tools ?? [])
          .filter((tool) => allowedTools.size === 0 || allowedTools.has(tool.name))
          .map<AgentMcpToolDescriptor>((tool) => ({
            serverId: binding.server.id,
            serverName: binding.server.name,
            serverSlug: binding.server.slug,
            bindingMode: binding.bindingMode,
            toolName: tool.name,
            title: tool.title,
            description: tool.description,
            inputSchema: tool.inputSchema,
          }));

        return {
          serverId: binding.server.id,
          serverName: binding.server.name,
          serverSlug: binding.server.slug,
          bindingMode: binding.bindingMode,
          enabled: binding.enabled && binding.server.enabled,
          toolCount: tools.length,
          tools,
        };
      })
      .filter((server) => server.tools.length > 0);

    return {
      servers,
      tools: servers.flatMap((server) => server.tools),
    };
  }

  async function executeForRun(
    runContext: {
      agentId: string;
      workspacePath?: string | null;
    },
    request: ExecuteAgentMcpToolRequest,
  ): Promise<ExecuteAgentMcpToolResponse> {
    const bindings = await mcpServers.listBindingsForAgent(runContext.agentId);
    const catalog = await listForAgent(runContext.agentId);
    const requestedServerId = normalizeName(request.serverId);
    const requestedServerName = normalizeName(request.serverName);
    const requestedToolName = normalizeName(request.toolName);
    const candidates = catalog.tools.filter((tool) => {
      if (normalizeName(tool.toolName) !== requestedToolName) return false;
      if (requestedServerId && normalizeName(tool.serverId) !== requestedServerId) return false;
      if (
        requestedServerName &&
        normalizeName(tool.serverName) !== requestedServerName &&
        normalizeName(tool.serverSlug) !== requestedServerName
      ) {
        return false;
      }
      return true;
    });

    if (candidates.length === 0) {
      throw notFound("No bound MCP tool matched this request");
    }
    if (candidates.length > 1) {
      throw unprocessable("Multiple MCP servers expose this tool; specify serverName or serverId");
    }

    const selected = candidates[0]!;
    const selectedBinding = bindings.find((binding) => binding.server.id === selected.serverId);
    if (!selectedBinding || !selectedBinding.enabled || !selectedBinding.server.enabled) {
      throw notFound("The selected MCP server binding is no longer available");
    }
    const result = await mcpServers.executeTool(selectedBinding.server, {
      toolName: selected.toolName,
      arguments: request.arguments ?? {},
      workspacePath: runContext.workspacePath ?? selectedBinding.server.cwd,
    });

    return {
      ok: !result.error,
      serverId: selected.serverId,
      serverName: selected.serverName,
      serverSlug: selected.serverSlug,
      toolName: selected.toolName,
      content: result.content ?? null,
      data: result.data ?? null,
      error: result.error ?? null,
    };
  }

  return {
    listForAgent,
    executeForRun,
  };
}
