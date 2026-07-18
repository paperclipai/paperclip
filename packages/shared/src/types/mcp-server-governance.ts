import type {
  McpServerAuditEventType,
  McpServerGovernanceStatus,
  McpServerRiskLevel,
} from "../constants.js";

/**
 * Governance audit trail for MCP servers (port of upstream PAP-10341 /
 * #4741). Every state transition, tool execution, and denied action is
 * recorded. Rows outlive server deletion (`mcpServerId` nulls out;
 * `serverSlug` keeps the identity readable).
 */
export interface McpServerAuditLogEntry {
  id: string;
  companyId: string;
  mcpServerId: string | null;
  serverSlug: string;
  eventType: McpServerAuditEventType;
  fromStatus: McpServerGovernanceStatus | null;
  toStatus: McpServerGovernanceStatus | null;
  riskLevel: McpServerRiskLevel | null;
  toolName: string | null;
  actorType: "user" | "agent" | "system";
  actorId: string | null;
  reason: string | null;
  details: Record<string, unknown>;
  createdAt: Date;
}

export interface TransitionMcpServerGovernanceRequest {
  targetStatus: McpServerGovernanceStatus;
  reason?: string | null;
}

export interface McpServerRiskClassification {
  riskLevel: McpServerRiskLevel;
  riskFactors: string[];
}
