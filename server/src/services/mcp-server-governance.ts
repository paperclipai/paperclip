/**
 * MCP server governance service (NEO-354 / D2-6).
 *
 * Implements:
 *  - `pending → quarantine → allowlisted | revoked` state machine
 *  - `mcp_server_audit_log` append for every transition and tool execution
 *  - Risk classification from catalog snapshot data
 *  - Gatekeeper: checks governance before any connect/execute
 *
 * Admin-only transitions (agents cannot self-approve — mirrors board-only
 * confirmation semantics). The caller is responsible for authz; this module
 * only validates whether the requested transition is structurally valid.
 */
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { mcpServers, mcpServerAuditLog, mcpServerCatalogSnapshots } from "@paperclipai/db";
import type {
  McpServerAuditLogEntry,
  McpServerGovernanceStatus,
  McpServerRiskClassification,
  TransitionMcpServerGovernanceRequest,
} from "@paperclipai/shared";
import { forbidden, notFound } from "../errors.js";

// ---------------------------------------------------------------------------
// Valid state-machine transitions
// ---------------------------------------------------------------------------

const ALLOWED_TRANSITIONS: Record<McpServerGovernanceStatus, McpServerGovernanceStatus[]> = {
  pending: ["quarantine"],
  quarantine: ["allowlisted", "revoked"],
  allowlisted: ["revoked", "quarantine"],
  revoked: ["quarantine"],
};

function isValidTransition(from: McpServerGovernanceStatus, to: McpServerGovernanceStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

// ---------------------------------------------------------------------------
// Risk classification from catalog snapshot
// ---------------------------------------------------------------------------

const HIGH_RISK_TOOL_PATTERNS = [
  /exec|shell|command|run|spawn|subprocess/i,
  /delete|remove|drop|truncate|destroy/i,
  /write|upload|overwrite|create.*file/i,
  /password|secret|credential|token|key/i,
  /network|http|fetch|request|proxy/i,
  /database|db|sql|query/i,
];

const CRITICAL_RISK_TOOL_PATTERNS = [
  /admin|sudo|root|privilege/i,
  /deploy|release|push|publish/i,
  /payment|billing|charge|invoice/i,
];

export function classifyRisk(toolNames: string[]): McpServerRiskClassification {
  if (toolNames.length === 0) {
    return { riskLevel: "unknown", riskFactors: [] };
  }

  const riskFactors: string[] = [];

  for (const tool of toolNames) {
    for (const pattern of CRITICAL_RISK_TOOL_PATTERNS) {
      if (pattern.test(tool)) {
        riskFactors.push(`critical-pattern:${tool}`);
      }
    }
    for (const pattern of HIGH_RISK_TOOL_PATTERNS) {
      if (pattern.test(tool)) {
        riskFactors.push(`high-risk-pattern:${tool}`);
      }
    }
  }

  const uniqueFactors = [...new Set(riskFactors)];

  if (uniqueFactors.some((f) => f.startsWith("critical-pattern:"))) {
    return { riskLevel: "critical", riskFactors: uniqueFactors };
  }
  if (uniqueFactors.length > 3) {
    return { riskLevel: "high", riskFactors: uniqueFactors };
  }
  if (uniqueFactors.length > 0) {
    return { riskLevel: "medium", riskFactors: uniqueFactors };
  }
  return { riskLevel: "low", riskFactors: [] };
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export interface WriteAuditLogOptions {
  companyId: string;
  mcpServerId: string | null;
  serverSlug: string;
  eventType: McpServerAuditLogEntry["eventType"];
  fromStatus?: McpServerGovernanceStatus | null;
  toStatus?: McpServerGovernanceStatus | null;
  riskLevel?: McpServerAuditLogEntry["riskLevel"];
  toolName?: string | null;
  actorType: "user" | "agent" | "system";
  actorId?: string | null;
  reason?: string | null;
  details?: Record<string, unknown>;
}

async function writeAuditLog(db: Db, opts: WriteAuditLogOptions) {
  await db.insert(mcpServerAuditLog).values({
    companyId: opts.companyId,
    mcpServerId: opts.mcpServerId,
    serverSlug: opts.serverSlug,
    eventType: opts.eventType,
    fromStatus: opts.fromStatus ?? null,
    toStatus: opts.toStatus ?? null,
    riskLevel: opts.riskLevel ?? null,
    toolName: opts.toolName ?? null,
    actorType: opts.actorType,
    actorId: opts.actorId ?? null,
    reason: opts.reason ?? null,
    details: opts.details ?? {},
  });
}

// ---------------------------------------------------------------------------
// Governance service
// ---------------------------------------------------------------------------

export function mcpServerGovernanceService(db: Db) {
  async function getServer(companyId: string, serverId: string) {
    const rows = await db
      .select()
      .from(mcpServers)
      .where(and(eq(mcpServers.id, serverId), eq(mcpServers.companyId, companyId)))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Transition a server's governance status. Only structurally valid transitions
   * are accepted; callers must have already verified admin-level authz.
   */
  async function transition(
    companyId: string,
    serverId: string,
    request: TransitionMcpServerGovernanceRequest,
    actor: { type: "user" | "agent" | "system"; id?: string | null },
  ) {
    const server = await getServer(companyId, serverId);
    if (!server) throw notFound("MCP server not found");

    const from = (server.governanceStatus ?? "pending") as McpServerGovernanceStatus;
    const to = request.targetStatus;

    if (from === to) {
      return server;
    }

    if (!isValidTransition(from, to)) {
      throw forbidden(
        `Invalid governance transition: ${from} → ${to}. Allowed from ${from}: ${ALLOWED_TRANSITIONS[from]?.join(", ") ?? "none"}`,
      );
    }

    const actorDescriptor =
      actor.type === "system" ? "system" : `${actor.type}:${actor.id ?? "unknown"}`;
    const now = new Date();

    const [updated] = await db
      .update(mcpServers)
      .set({
        governanceStatus: to,
        governanceUpdatedAt: now,
        governanceUpdatedBy: actorDescriptor,
        governanceReason: request.reason ?? null,
        updatedAt: now,
      })
      .where(and(eq(mcpServers.id, serverId), eq(mcpServers.companyId, companyId)))
      .returning();

    await writeAuditLog(db, {
      companyId,
      mcpServerId: serverId,
      serverSlug: server.slug,
      eventType: "governance.transition",
      fromStatus: from,
      toStatus: to,
      actorType: actor.type,
      actorId: actor.id ?? null,
      reason: request.reason ?? null,
    });

    return updated;
  }

  /**
   * Gate: returns true if the server is allowlisted and may execute tools.
   * Writes a denied-execution audit entry when execution is blocked.
   */
  async function checkExecutionAllowed(
    companyId: string,
    serverId: string,
    toolName: string | null,
    actor: { type: "user" | "agent" | "system"; id?: string | null },
  ): Promise<boolean> {
    const server = await getServer(companyId, serverId);
    if (!server) return false;

    const status = (server.governanceStatus ?? "pending") as McpServerGovernanceStatus;
    const allowed = status === "allowlisted";

    const eventType = allowed ? "governance.execute_allowed" : "governance.execute_denied";
    await writeAuditLog(db, {
      companyId,
      mcpServerId: serverId,
      serverSlug: server.slug,
      eventType,
      toolName: toolName ?? null,
      actorType: actor.type,
      actorId: actor.id ?? null,
      details: { governanceStatus: status },
    });

    return allowed;
  }

  /**
   * Recompute risk from the server's latest catalog snapshot and persist it.
   */
  async function refreshRiskClassification(companyId: string, serverId: string) {
    const server = await getServer(companyId, serverId);
    if (!server) throw notFound("MCP server not found");

    const snapshotRows = await db
      .select()
      .from(mcpServerCatalogSnapshots)
      .where(eq(mcpServerCatalogSnapshots.mcpServerId, serverId))
      .orderBy(desc(mcpServerCatalogSnapshots.createdAt))
      .limit(1);

    const snapshot = snapshotRows[0];
    const toolNames: string[] = snapshot?.tools
      ? (snapshot.tools as Array<{ name?: string }>)
          .map((t) => t.name ?? "")
          .filter(Boolean)
      : [];

    const classification = classifyRisk(toolNames);

    const [updated] = await db
      .update(mcpServers)
      .set({
        riskLevel: classification.riskLevel,
        riskFactors: classification.riskFactors,
        updatedAt: new Date(),
      })
      .where(and(eq(mcpServers.id, serverId), eq(mcpServers.companyId, companyId)))
      .returning();

    await writeAuditLog(db, {
      companyId,
      mcpServerId: serverId,
      serverSlug: server.slug,
      eventType: "governance.risk_classified",
      riskLevel: classification.riskLevel,
      actorType: "system",
      details: { riskFactors: classification.riskFactors, toolCount: toolNames.length },
    });

    return updated;
  }

  async function listAuditLog(
    companyId: string,
    serverId: string,
    limit = 100,
  ): Promise<McpServerAuditLogEntry[]> {
    const rows = await db
      .select()
      .from(mcpServerAuditLog)
      .where(and(
        eq(mcpServerAuditLog.companyId, companyId),
        eq(mcpServerAuditLog.mcpServerId, serverId),
      ))
      .orderBy(desc(mcpServerAuditLog.createdAt))
      .limit(limit);

    return rows.map((row) => ({
      id: row.id,
      companyId: row.companyId,
      mcpServerId: row.mcpServerId,
      serverSlug: row.serverSlug,
      eventType: row.eventType as McpServerAuditLogEntry["eventType"],
      fromStatus: (row.fromStatus as McpServerGovernanceStatus | null) ?? null,
      toStatus: (row.toStatus as McpServerGovernanceStatus | null) ?? null,
      riskLevel: (row.riskLevel as McpServerAuditLogEntry["riskLevel"]) ?? null,
      toolName: row.toolName ?? null,
      actorType: row.actorType as "user" | "agent" | "system",
      actorId: row.actorId ?? null,
      reason: row.reason ?? null,
      details: (row.details as Record<string, unknown>) ?? {},
      createdAt: row.createdAt,
    }));
  }

  return {
    transition,
    checkExecutionAllowed,
    refreshRiskClassification,
    listAuditLog,
  };
}

export type McpServerGovernanceServiceInstance = ReturnType<typeof mcpServerGovernanceService>;
