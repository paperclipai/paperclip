import { z } from "zod";
import {
  INVITE_JOIN_TYPES,
  JOIN_REQUEST_STATUSES,
  JOIN_REQUEST_TYPES,
  PERMISSION_KEYS,
} from "../constants.js";
import { optionalAgentAdapterTypeSchema } from "../adapter-type.js";

export const createCompanyInviteSchema = z.object({
  allowedJoinTypes: z.enum(INVITE_JOIN_TYPES).default("both"),
  defaultsPayload: z.record(z.string(), z.unknown()).optional().nullable(),
  agentMessage: z.string().max(4000).optional().nullable(),
});

export type CreateCompanyInvite = z.infer<typeof createCompanyInviteSchema>;

export const createOpenClawInvitePromptSchema = z.object({
  agentMessage: z.string().max(4000).optional().nullable(),
});

export type CreateOpenClawInvitePrompt = z.infer<
  typeof createOpenClawInvitePromptSchema
>;

export const acceptInviteSchema = z.object({
  requestType: z.enum(JOIN_REQUEST_TYPES),
  agentName: z.string().min(1).max(120).optional(),
  adapterType: optionalAgentAdapterTypeSchema,
  capabilities: z.string().max(4000).optional().nullable(),
  agentDefaultsPayload: z.record(z.string(), z.unknown()).optional().nullable(),
  // OpenClaw join compatibility fields accepted at top level.
  responsesWebhookUrl: z.string().max(4000).optional().nullable(),
  responsesWebhookMethod: z.string().max(32).optional().nullable(),
  responsesWebhookHeaders: z.record(z.string(), z.unknown()).optional().nullable(),
  paperclipApiUrl: z.string().max(4000).optional().nullable(),
  webhookAuthHeader: z.string().max(4000).optional().nullable(),
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

export const boardCliAuthAccessLevelSchema = z.enum([
  "board",
  "instance_admin_required",
]);

export type BoardCliAuthAccessLevel = z.infer<typeof boardCliAuthAccessLevelSchema>;

export const createCliAuthChallengeSchema = z.object({
  command: z.string().min(1).max(240),
  clientName: z.string().max(120).optional().nullable(),
  requestedAccess: boardCliAuthAccessLevelSchema.default("board"),
  requestedCompanyId: z.string().uuid().optional().nullable(),
});

export type CreateCliAuthChallenge = z.infer<typeof createCliAuthChallengeSchema>;

export const resolveCliAuthChallengeSchema = z.object({
  token: z.string().min(16).max(256),
});

export type ResolveCliAuthChallenge = z.infer<typeof resolveCliAuthChallengeSchema>;

export const updateMemberPermissionsSchema = z.object({
  grants: z.array(
    z.object({
      permissionKey: z.enum(PERMISSION_KEYS),
      scope: z.record(z.string(), z.unknown()).optional().nullable(),
    }),
  ),
});

export type UpdateMemberPermissions = z.infer<typeof updateMemberPermissionsSchema>;

export const updateUserCompanyAccessSchema = z.object({
  companyIds: z.array(z.string().uuid()).default([]),
});

export type UpdateUserCompanyAccess = z.infer<typeof updateUserCompanyAccessSchema>;
