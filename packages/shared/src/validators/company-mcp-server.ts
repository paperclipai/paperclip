import { z } from "zod";
import { mcpServerConfigSchema, mcpServerNameSchema } from "./mcp.js";

export const companyMcpServerCreateSchema = z.object({
  name: mcpServerNameSchema,
  description: z.string().trim().max(500).optional().nullable(),
  config: mcpServerConfigSchema,
  enabled: z.boolean().optional().default(true),
});

export type CompanyMcpServerCreate = z.infer<typeof companyMcpServerCreateSchema>;

export const companyMcpServerUpdateSchema = z.object({
  name: mcpServerNameSchema.optional(),
  description: z.string().trim().max(500).optional().nullable(),
  config: mcpServerConfigSchema.optional(),
  enabled: z.boolean().optional(),
});

export type CompanyMcpServerUpdate = z.infer<typeof companyMcpServerUpdateSchema>;

/** POST /agents/:id/mcp-servers/sync — replace the agent's catalog refs. */
export const agentMcpServersSyncSchema = z.object({
  desiredMcpServers: z.array(mcpServerNameSchema).max(32),
});

export type AgentMcpServersSync = z.infer<typeof agentMcpServersSyncSchema>;
