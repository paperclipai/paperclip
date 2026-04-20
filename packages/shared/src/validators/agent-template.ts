import { z } from "zod";
import { AGENT_ADAPTER_TYPES, AGENT_ICON_NAMES, AGENT_ROLES } from "../constants.js";

const approvalPolicySchema = z.object({
  autoApprove: z.array(z.string()).optional().default([]),
  needsApproval: z.array(z.string()).optional().default([]),
}).passthrough();

export const createAgentTemplateSchema = z.object({
  name: z.string().min(1),
  role: z.enum(AGENT_ROLES).optional().default("general"),
  title: z.string().optional().nullable(),
  icon: z.enum(AGENT_ICON_NAMES).optional().nullable(),
  adapterType: z.enum(AGENT_ADAPTER_TYPES).optional().default("claude_local"),
  adapterConfig: z.record(z.unknown()).optional().default({}),
  systemPrompt: z.string().optional().nullable(),
  skills: z.array(z.unknown()).optional().default([]),
  approvalPolicy: approvalPolicySchema.optional().default({}),
});

export type CreateAgentTemplate = z.infer<typeof createAgentTemplateSchema>;

export const updateAgentTemplateSchema = createAgentTemplateSchema.partial();

export type UpdateAgentTemplate = z.infer<typeof updateAgentTemplateSchema>;

export const instantiateAgentTemplateSchema = z.object({
  companyId: z.string().uuid(),
  name: z.string().min(1).optional(),
  credentialId: z.string().uuid().optional().nullable(),
});

export type InstantiateAgentTemplate = z.infer<typeof instantiateAgentTemplateSchema>;
