import { z } from "zod";

export const inboxAgentPolicyModeSchema = z.enum(["open", "allowlist", "disabled"]);

export const updateInboxAgentPolicySchema = z.object({
  mode: inboxAgentPolicyModeSchema,
  allowedAgentIds: z.array(z.string().uuid()).max(100).default([]),
}).strict();

export type UpdateInboxAgentPolicy = z.infer<typeof updateInboxAgentPolicySchema>;
