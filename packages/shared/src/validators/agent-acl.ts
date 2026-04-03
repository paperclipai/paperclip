import { z } from "zod";

export const agentPermissionSchema = z.enum(["assign", "comment"]);

export const agentPermissionGrantSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  granteeId: z.string().uuid(),
  agentId: z.string().uuid(),
  permission: agentPermissionSchema,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const createAgentPermissionGrantSchema = z.object({
  granteeId: z.string().uuid(),
  agentId: z.string().uuid(),
  permission: agentPermissionSchema,
});

export const agentPermissionDefaultsSchema = z.object({
  companyId: z.string().uuid(),
  assignDefault: z.boolean(),
  commentDefault: z.boolean(),
  updatedAt: z.coerce.date(),
});

export const patchAgentPermissionDefaultsSchema = z.object({
  assignDefault: z.boolean().optional(),
  commentDefault: z.boolean().optional(),
});

export type AgentPermission = z.infer<typeof agentPermissionSchema>;
export type AgentPermissionGrant = z.infer<typeof agentPermissionGrantSchema>;
export type CreateAgentPermissionGrant = z.infer<typeof createAgentPermissionGrantSchema>;
export type AgentPermissionDefaults = z.infer<typeof agentPermissionDefaultsSchema>;
export type PatchAgentPermissionDefaults = z.infer<typeof patchAgentPermissionDefaultsSchema>;
