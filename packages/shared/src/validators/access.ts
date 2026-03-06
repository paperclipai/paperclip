import { z } from "zod";
import {
  AGENT_ADAPTER_TYPES,
  INVITE_JOIN_TYPES,
  JOIN_REQUEST_STATUSES,
  JOIN_REQUEST_TYPES,
  PERMISSION_KEYS,
} from "../constants.js";

export const createCompanyInviteSchema = z.object({
  allowedJoinTypes: z.enum(INVITE_JOIN_TYPES).default("both"),
  expiresInHours: z.number().int().min(1).max(24 * 30).optional().default(72),
  defaultsPayload: z.record(z.string(), z.unknown()).optional().nullable(),
});

export type CreateCompanyInvite = z.infer<typeof createCompanyInviteSchema>;

export const acceptInviteSchema = z.object({
  requestType: z.enum(JOIN_REQUEST_TYPES),
  agentName: z.string().min(1).max(120).optional(),
  adapterType: z.enum(AGENT_ADAPTER_TYPES).optional(),
  capabilities: z.string().max(4000).optional().nullable(),
  agentDefaultsPayload: z.record(z.string(), z.unknown()).optional().nullable(),
});

export type AcceptInvite = z.infer<typeof acceptInviteSchema>;

export const listJoinRequestsQuerySchema = z.object({
  status: z.enum(JOIN_REQUEST_STATUSES).optional(),
  requestType: z.enum(JOIN_REQUEST_TYPES).optional(),
});

export type ListJoinRequestsQuery = z.infer<typeof listJoinRequestsQuerySchema>;

export const claimJoinRequestApiKeySchema = z.object({
  claimSecret: z.string().min(16).max(256),
});

export type ClaimJoinRequestApiKey = z.infer<typeof claimJoinRequestApiKeySchema>;

const assignScopeRoleSchema = z.string().trim().min(1).max(120);
const assignScopeProjectIdSchema = z.union([z.literal("*"), z.string().uuid()]);

export const tasksAssignScopeSchema = z
  .object({
    projectIds: z.array(assignScopeProjectIdSchema).nonempty(),
    allowedAssigneeAgentIds: z.array(z.string().uuid()).nonempty().optional(),
    allowedAssigneeRoles: z.array(assignScopeRoleSchema).nonempty().optional(),
    deniedAssigneeRoles: z.array(assignScopeRoleSchema).default(["ceo"]),
    allowUnassign: z.boolean().default(false),
    allowAssignToUsers: z.boolean().default(false),
  })
  .strict()
  .superRefine((scope, ctx) => {
    if ((scope.allowedAssigneeAgentIds?.length ?? 0) > 0) return;
    if ((scope.allowedAssigneeRoles?.length ?? 0) > 0) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["allowedAssigneeAgentIds"],
      message: "Either allowedAssigneeAgentIds or allowedAssigneeRoles is required",
    });
  });

export type TasksAssignScope = z.infer<typeof tasksAssignScopeSchema>;

export const updateMemberPermissionsSchema = z.object({
  grants: z.array(
    z.object({
      permissionKey: z.enum(PERMISSION_KEYS),
      scope: z.record(z.string(), z.unknown()).optional().nullable(),
    }).superRefine((grant, ctx) => {
      if (grant.permissionKey !== "tasks:assign_scope") return;
      const parsed = tasksAssignScopeSchema.safeParse(grant.scope);
      if (parsed.success) return;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scope"],
        message: `Invalid tasks:assign_scope grant: ${parsed.error.issues[0]?.message ?? "invalid scope"}`,
      });
    }),
  ),
});

export type UpdateMemberPermissions = z.infer<typeof updateMemberPermissionsSchema>;

export const updateUserCompanyAccessSchema = z.object({
  companyIds: z.array(z.string().uuid()).default([]),
});

export type UpdateUserCompanyAccess = z.infer<typeof updateUserCompanyAccessSchema>;
