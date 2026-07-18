import { z } from "zod";
import { MCP_SERVER_BINDING_MODES } from "../constants.js";

export const agentMcpToolDescriptorSchema = z.object({
  serverId: z.string().uuid(),
  serverName: z.string().min(1),
  serverSlug: z.string().min(1),
  bindingMode: z.enum(MCP_SERVER_BINDING_MODES),
  toolName: z.string().min(1),
  title: z.string().nullable(),
  description: z.string().nullable(),
  inputSchema: z.record(z.string(), z.unknown()).nullable(),
});

export const agentMcpServerToolCatalogSchema = z.object({
  serverId: z.string().uuid(),
  serverName: z.string().min(1),
  serverSlug: z.string().min(1),
  bindingMode: z.enum(MCP_SERVER_BINDING_MODES),
  enabled: z.boolean(),
  toolCount: z.number().int().nonnegative(),
  tools: z.array(agentMcpToolDescriptorSchema),
});

export const agentMcpToolListResponseSchema = z.object({
  servers: z.array(agentMcpServerToolCatalogSchema),
  tools: z.array(agentMcpToolDescriptorSchema),
});

export const executeAgentMcpToolSchema = z.object({
  serverId: z.string().uuid().nullable().optional(),
  serverName: z.string().trim().min(1).nullable().optional(),
  toolName: z.string().trim().min(1),
  arguments: z.record(z.string(), z.unknown()).optional().default({}),
}).strict();

export type ExecuteAgentMcpTool = z.infer<typeof executeAgentMcpToolSchema>;
