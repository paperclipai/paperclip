import { z } from "zod";
import { MCP_SERVER_AUDIT_EVENT_TYPES } from "../constants.js";
import { mcpServerGovernanceStatusSchema, mcpServerRiskLevelSchema } from "./mcp-server.js";

export const mcpServerAuditEventTypeSchema = z.enum(MCP_SERVER_AUDIT_EVENT_TYPES);

export const transitionMcpServerGovernanceSchema = z.object({
  targetStatus: mcpServerGovernanceStatusSchema,
  reason: z.string().min(1).max(2000).nullable().optional(),
});

export type TransitionMcpServerGovernance = z.infer<typeof transitionMcpServerGovernanceSchema>;

export const mcpServerAuditLogEntrySchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  mcpServerId: z.string().uuid().nullable(),
  serverSlug: z.string(),
  eventType: mcpServerAuditEventTypeSchema,
  fromStatus: mcpServerGovernanceStatusSchema.nullable(),
  toStatus: mcpServerGovernanceStatusSchema.nullable(),
  riskLevel: mcpServerRiskLevelSchema.nullable(),
  toolName: z.string().nullable(),
  actorType: z.enum(["user", "agent", "system"]),
  actorId: z.string().nullable(),
  reason: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
  createdAt: z.date(),
});
