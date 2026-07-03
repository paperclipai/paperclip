import { z } from "zod";
import {
  MCP_SERVER_GOVERNANCE_STATUSES,
  MCP_SERVER_HEALTH_STATUSES,
  MCP_SERVER_RISK_LEVELS,
  MCP_SERVER_TRANSPORTS,
} from "../constants.js";
import { envConfigSchema } from "./secret.js";

const slugSchema = z.string().min(1).regex(/^[a-z0-9][a-z0-9._-]*$/);

export const mcpServerTransportSchema = z.enum(MCP_SERVER_TRANSPORTS);
export const mcpServerHealthStatusSchema = z.enum(MCP_SERVER_HEALTH_STATUSES);
export const mcpServerGovernanceStatusSchema = z.enum(MCP_SERVER_GOVERNANCE_STATUSES);
export const mcpServerRiskLevelSchema = z.enum(MCP_SERVER_RISK_LEVELS);

export const mcpServerSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  name: z.string().min(1),
  slug: slugSchema,
  description: z.string().nullable(),
  transport: mcpServerTransportSchema,
  command: z.string().nullable(),
  args: z.array(z.string()),
  cwd: z.string().nullable(),
  url: z.string().url().nullable(),
  headers: z.record(z.string()),
  env: envConfigSchema,
  credentialSecretRef: z.string().nullable(),
  enabled: z.boolean(),
  governanceStatus: mcpServerGovernanceStatusSchema,
  riskLevel: mcpServerRiskLevelSchema,
  riskFactors: z.array(z.string()),
  governanceUpdatedAt: z.date().nullable(),
  governanceUpdatedBy: z.string().nullable(),
  governanceReason: z.string().nullable(),
  lastHealthStatus: mcpServerHealthStatusSchema,
  lastHealthcheckAt: z.date().nullable(),
  lastDiscoveryAt: z.date().nullable(),
  lastError: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdByAgentId: z.string().uuid().nullable(),
  createdByUserId: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const mcpServerInputBaseSchema = z.object({
  name: z.string().min(1),
  slug: slugSchema,
  description: z.string().nullable().optional(),
  transport: mcpServerTransportSchema,
  command: z.string().nullable().optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().nullable().optional(),
  url: z.string().url().nullable().optional(),
  headers: z.record(z.string()).optional(),
  env: envConfigSchema.optional(),
  credential: z.string().min(1).nullable().optional(),
  enabled: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const createMcpServerSchema = mcpServerInputBaseSchema.superRefine((value, ctx) => {
  if (value.transport === "stdio" && typeof value.command !== "string") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "command is required for stdio MCP servers",
      path: ["command"],
    });
  }

  if ((value.transport === "http" || value.transport === "sse") && typeof value.url !== "string") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `url is required for ${value.transport} MCP servers`,
      path: ["url"],
    });
  }
});

export type CreateMcpServer = z.infer<typeof createMcpServerSchema>;

export const updateMcpServerSchema = mcpServerInputBaseSchema
  .partial()
  .superRefine((value, ctx) => {
    if (value.transport === "stdio" && value.command !== undefined && value.command !== null && value.command === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "command cannot be empty for stdio MCP servers",
        path: ["command"],
      });
    }

    if ((value.transport === "http" || value.transport === "sse") && value.url !== undefined && value.url !== null && value.url === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "url cannot be empty for http MCP servers",
        path: ["url"],
      });
    }
  });

export type UpdateMcpServer = z.infer<typeof updateMcpServerSchema>;
