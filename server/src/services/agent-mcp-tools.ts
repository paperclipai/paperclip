import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import type {
  AgentMcpServerBindingDetail,
  AgentMcpToolDescriptor,
  AgentMcpToolListResponse,
  ExecuteAgentMcpToolRequest,
  ExecuteAgentMcpToolResponse,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import {
  createStderrMcpTelemetrySink,
  type McpToolTelemetrySink,
} from "./mcp-client-telemetry.js";
import { mcpServerService } from "./mcp-servers.js";
import type { secretService } from "./secrets.js";

function normalizeName(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().toLowerCase() : null;
}

export function agentMcpToolService(
  db: Db,
  deps: {
    secrets: ReturnType<typeof secretService>;
    /** Injectable for tests; defaults to the real db-backed service. */
    mcpServers?: Pick<ReturnType<typeof mcpServerService>, "listBindingsForAgent" | "executeTool">;
    /** Injectable for tests; defaults to a db lookup on `companies.mcp_client_enabled`. */
    isCompanyMcpClientEnabled?: (companyId: string) => Promise<boolean>;
    /** Injectable for tests; defaults to one JSON line per call on stderr. */
    telemetry?: McpToolTelemetrySink;
  },
) {
  const mcpServers = deps.mcpServers ?? mcpServerService(db, { secrets: deps.secrets });
  const emitTelemetry = deps.telemetry ?? createStderrMcpTelemetrySink();
  // Per-company gate (NEO-286 D2-5): the process-wide flag mounts the MCP
  // surface, but only companies with mcp_client_enabled=true expose tools —
  // so enabling the flag on a shared instance is not on-for-everyone.
  const isCompanyMcpClientEnabled =
    deps.isCompanyMcpClientEnabled ??
    (async (companyId: string) => {
      const [row] = await db
        .select({ enabled: companies.mcpClientEnabled })
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1);
      return row?.enabled === true;
    });

  // The agent's visible MCP tool set is the intersection of the company's
  // enabled servers with the agent's enabled bindings (`agent_mcp_servers`
  // is the reconciled home of the plan's `mcpServerIds: string[]`). When a
  // companyId is supplied, bindings whose server belongs to another company
  // are dropped outright — bindings are written company-consistent, but the
  // read path must not depend on that invariant.
  async function listForAgent(
    agentId: string,
    opts?: { companyId?: string | null },
  ): Promise<AgentMcpToolListResponse> {
    const companyId = opts?.companyId ?? null;
    if (companyId !== null && !(await isCompanyMcpClientEnabled(companyId))) {
      return { servers: [], tools: [] };
    }
    const bindings = await mcpServers.listBindingsForAgent(agentId);
    // Unscoped calls still honor the per-company gate: each binding's own
    // company must be enabled for its servers to surface.
    const gateCache = new Map<string, boolean>();
    const companyGateAllows = async (id: string): Promise<boolean> => {
      if (companyId !== null) return true; // already checked above
      const cached = gateCache.get(id);
      if (cached !== undefined) return cached;
      const allowed = await isCompanyMcpClientEnabled(id);
      gateCache.set(id, allowed);
      return allowed;
    };
    const gatedBindings: typeof bindings = [];
    for (const binding of bindings) {
      if (!binding.enabled || !binding.server.enabled) continue;
      if (companyId !== null && binding.server.companyId !== companyId) continue;
      if (!(await companyGateAllows(binding.server.companyId))) continue;
      gatedBindings.push(binding);
    }
    const servers = gatedBindings
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
      companyId?: string | null;
      workspacePath?: string | null;
    },
    request: ExecuteAgentMcpToolRequest,
  ): Promise<ExecuteAgentMcpToolResponse> {
    const bindings = await mcpServers.listBindingsForAgent(runContext.agentId);
    const catalog = await listForAgent(runContext.agentId, { companyId: runContext.companyId });
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
    if (runContext.companyId != null && selectedBinding.server.companyId !== runContext.companyId) {
      throw notFound("The selected MCP server binding is no longer available");
    }
    // One telemetry event per call (NEO-286 D2-5, mirroring NEO-296): tool,
    // server, actor, company, outcome, latency. Arguments, headers, and
    // credentials are never part of the event.
    const startedAt = Date.now();
    let result: Awaited<ReturnType<typeof mcpServers.executeTool>>;
    try {
      result = await mcpServers.executeTool(selectedBinding.server, {
        toolName: selected.toolName,
        arguments: request.arguments ?? {},
        workspacePath: runContext.workspacePath ?? selectedBinding.server.cwd,
      });
    } catch (error) {
      emitTelemetry({
        tool: selected.toolName,
        server: selected.serverSlug,
        actor: runContext.agentId,
        company: runContext.companyId ?? null,
        status: "error",
        durationMs: Date.now() - startedAt,
        errorName: error instanceof Error ? error.constructor.name : "UnknownError",
      });
      throw error;
    }
    emitTelemetry({
      tool: selected.toolName,
      server: selected.serverSlug,
      actor: runContext.agentId,
      company: runContext.companyId ?? null,
      status: result.error ? "error" : "ok",
      durationMs: Date.now() - startedAt,
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
