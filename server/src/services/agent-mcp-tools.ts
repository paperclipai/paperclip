import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, mcpServerAuditLog } from "@paperclipai/db";
import type {
  AgentMcpServerBindingDetail,
  AgentMcpToolDescriptor,
  AgentMcpToolListResponse,
  ExecuteAgentMcpToolRequest,
  ExecuteAgentMcpToolResponse,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { MAX_DELEGATION_DEPTH } from "./delegation-origin.js";
import {
  createStderrMcpTelemetrySink,
  type McpToolTelemetrySink,
} from "./mcp-client-telemetry.js";
import { mcpServerService } from "./mcp-servers.js";
import type { secretService } from "./secrets.js";

function normalizeName(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().toLowerCase() : null;
}

// NEO-446 Phase 1: Requester-clearance dimension + MIN(agent, requester) gate.
const CLEARANCE_RANK: Record<string, number> = { guest: 0, member: 1, board: 2 };

function clearanceRank(role: string | null | undefined): number {
  return CLEARANCE_RANK[role ?? ""] ?? -1;
}

/**
 * NEO-448 Phase 3: the transitive origin principal of the delegation chain,
 * derived by the route layer from the TRUSTED run row (never agent-supplied).
 * `role` is already MIN(stamped-at-seed, fresh-from-membership).
 */
export interface OriginAuthzContext {
  kind: "user" | "autonomous" | "unresolved";
  userId: string | null;
  role: string | null;
  depth: number;
}

function effectiveClearance(
  bindingAuthority: string,
  requestingUserRole: string | null | undefined,
  autonomousAllowed: boolean,
  invocationSource: string | null | undefined,
  origin?: OriginAuthzContext | null,
): string {
  // NEO-448 Phase 3: delegation-origin clamps come first, fail-closed.
  // An agent-caused run whose origin could not be established must never
  // pass as autonomous, and a chain deeper than the cap is refused wholesale
  // (defeats depth-laundering through long wake chains).
  if (origin) {
    if (origin.kind === "unresolved") return "guest";
    if (origin.depth > MAX_DELEGATION_DEPTH) return "guest";
  }
  const originIsUser = origin?.kind === "user";
  const isAutonomous = requestingUserRole == null && !originIsUser;
  if (isAutonomous) {
    // NEO-447 Phase 2: a channel run is BY DEFINITION on behalf of someone —
    // an unresolved/unmapped requester must never inherit the binding's
    // autonomous authority. Floor to guest, fail-closed.
    if (invocationSource === "channel") return "guest";
    // Autonomous (heartbeat/no user): grant full binding authority if autonomousAllowed, else guest floor
    return autonomousAllowed ? bindingAuthority : "guest";
  }
  // MIN(agentAuthority, requesterClearance, originClearance) — the origin
  // dimension defeats MAX-over-chain laundering: no hop can ever widen the
  // chain past the human who seeded it.
  const ranks = [clearanceRank(bindingAuthority)];
  if (requestingUserRole != null) ranks.push(clearanceRank(requestingUserRole));
  if (originIsUser) ranks.push(clearanceRank(origin!.role));
  const minRank = Math.min(...ranks);
  if (minRank <= 0) return "guest";
  if (minRank === 1) return "member";
  return "board";
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
    /** Injectable for tests; defaults to db.insert for the real audit log. */
    writeAuditLog?: (
      values: typeof mcpServerAuditLog.$inferInsert,
    ) => Promise<void>;
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

  const writeAuditLog =
    deps.writeAuditLog ??
    (async (values: typeof mcpServerAuditLog.$inferInsert) => {
      await db.insert(mcpServerAuditLog).values(values);
    });

  // The agent's visible MCP tool set is the intersection of the company's
  // enabled servers with the agent's enabled bindings (`agent_mcp_servers`
  // is the reconciled home of the plan's `mcpServerIds: string[]`). When a
  // companyId is supplied, bindings whose server belongs to another company
  // are dropped outright — bindings are written company-consistent, but the
  // read path must not depend on that invariant.
  async function listForAgent(
    agentId: string,
    opts?: {
      companyId?: string | null;
      /**
       * NEO-447 Phase 2: clearance-aware surfacing. When present, the catalog
       * is clamped to tools whose required clearance is within the requester's
       * effective clearance, so an agent cannot volunteer/enumerate a tool the
       * asker isn't cleared for. This clamp is advisory UX — the execute path
       * re-verifies against the SAME rule and remains the single audited PEP.
       */
      requester?: {
        role: string | null;
        invocationSource: "heartbeat" | "channel" | null;
        /** NEO-448 Phase 3: origin principal of the delegation chain. */
        origin?: OriginAuthzContext | null;
      };
    },
  ): Promise<AgentMcpToolListResponse> {
    const companyId = opts?.companyId ?? null;
    const requester = opts?.requester;
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
        // Clearance clamp (NEO-447): with a requester in scope, hide tools
        // whose required clearance exceeds MIN(bindingAuthority, requester).
        const surfacedClearance = requester
          ? clearanceRank(
              effectiveClearance(
                binding.bindingAuthority,
                requester.role,
                binding.autonomousAllowed,
                requester.invocationSource,
                requester.origin ?? null,
              ),
            )
          : null;
        const clearedFor = (toolName: string): boolean => {
          if (surfacedClearance === null) return true;
          const required =
            binding.toolClearances[toolName] ?? binding.defaultMinUserRole;
          return surfacedClearance >= clearanceRank(required);
        };
        // Empty allowedTools means the binding exposes ZERO tools (deny by
        // default), not ALL tools. Callers must populate the allow-list to
        // grant access.
        const tools = (binding.latestSnapshot?.tools ?? [])
          .filter((tool) => allowedTools.has(tool.name) && clearedFor(tool.name))
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
      requestingUserId?: string | null;
      requestingUserRole?: string | null;
      invocationSource?: "heartbeat" | "channel" | null;
      /** NEO-448 Phase 3: origin principal of the delegation chain (trusted, route-derived). */
      origin?: OriginAuthzContext | null;
      /** Run id for audit correlation (taint-label replay checks join on this). */
      runId?: string | null;
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

    // Clearance gate (NEO-446 Phase 1): MIN(agentBindingAuthority, requestingUserClearance)
    // extended with the delegation-origin dimension (NEO-448 Phase 3).
    const effective = effectiveClearance(
      selectedBinding.bindingAuthority,
      runContext.requestingUserRole ?? null,
      selectedBinding.autonomousAllowed,
      runContext.invocationSource ?? null,
      runContext.origin ?? null,
    );
    const toolClearanceRequired =
      selectedBinding.toolClearances[selected.toolName] ??
      selectedBinding.defaultMinUserRole;

    const effectiveRank = clearanceRank(effective);
    const requiredRank = clearanceRank(toolClearanceRequired);
    const allowed = effectiveRank >= requiredRank;

    // Write durable audit row for every allow/deny — fail-closed on audit failure.
    await writeAuditLog({
      companyId: runContext.companyId ?? selectedBinding.server.companyId,
      mcpServerId: selectedBinding.server.id,
      serverSlug: selectedBinding.server.slug,
      eventType: allowed ? "clearance.allowed" : "clearance.denied",
      toolName: selected.toolName,
      actorType: "agent",
      actorId: runContext.agentId,
      onBehalfOfUserId: runContext.requestingUserId ?? runContext.origin?.userId ?? null,
      onBehalfOfRole: runContext.requestingUserRole ?? null,
      decision: allowed ? "allow" : "deny",
      details: {
        effectiveClearance: effective,
        requiredClearance: toolClearanceRequired,
        bindingAuthority: selectedBinding.bindingAuthority,
        autonomousAllowed: selectedBinding.autonomousAllowed,
        invocationSource: runContext.invocationSource ?? null,
        // NEO-448 Phase 3: delegation-chain attribution + taint correlation.
        runId: runContext.runId ?? null,
        originKind: runContext.origin?.kind ?? null,
        originUserId: runContext.origin?.userId ?? null,
        originRole: runContext.origin?.role ?? null,
        delegationDepth: runContext.origin?.depth ?? null,
      },
    });

    if (!allowed) {
      throw Object.assign(
        new Error(
          `MCP tool denied by clearance: requires '${toolClearanceRequired}', effective clearance is '${effective}'`,
        ),
        {
          statusCode: 403,
          code: "mcp_tool_denied_by_clearance",
          requiredClearance: toolClearanceRequired,
          requesterClearance: effective,
        },
      );
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
      // NEO-448 Phase 3: taint label. The result may contain data as
      // sensitive as the tool's clearance class; every re-surface (session
      // replay, memory retrieval, room rendering) must re-check the reader's
      // clearance against this ceiling before showing it. An unmapped
      // required-clearance value labels as board (fail closed).
      clearanceCeiling:
        toolClearanceRequired === "guest" || toolClearanceRequired === "member"
          ? toolClearanceRequired
          : "board",
    };
  }

  return {
    listForAgent,
    executeForRun,
  };
}
