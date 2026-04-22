import { z } from "zod";
import { MCP_SERVER_BINDING_MODES } from "../constants.js";

export const mcpServerBindingModeSchema = z.enum(MCP_SERVER_BINDING_MODES);

export const agentMcpServerBindingSchema = z.object({
  companyId: z.string().uuid(),
  agentId: z.string().uuid(),
  mcpServerId: z.string().uuid(),
  bindingMode: mcpServerBindingModeSchema,
  enabled: z.boolean(),
  allowedTools: z.array(z.string().min(1)),
  createdByAgentId: z.string().uuid().nullable(),
  createdByUserId: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const bindAgentMcpServerSchema = z.object({
  mcpServerId: z.string().uuid(),
  bindingMode: mcpServerBindingModeSchema.optional().default("allowed"),
  enabled: z.boolean().optional().default(true),
  allowedTools: z.array(z.string().min(1)).optional().default([]),
});

export type BindAgentMcpServer = z.infer<typeof bindAgentMcpServerSchema>;

export const updateAgentMcpServerBindingSchema = z.object({
  bindingMode: mcpServerBindingModeSchema.optional(),
  enabled: z.boolean().optional(),
  allowedTools: z.array(z.string().min(1)).optional(),
});

export type UpdateAgentMcpServerBinding = z.infer<typeof updateAgentMcpServerBindingSchema>;
