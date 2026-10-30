import { z } from "zod";
import {
  ENVIRONMENT_CUSTOM_IMAGE_SETUP_CONNECTION_TYPES,
  ENVIRONMENT_CUSTOM_IMAGE_SETUP_SESSION_STATUSES,
  ENVIRONMENT_CUSTOM_IMAGE_TEMPLATE_KINDS,
  ENVIRONMENT_CUSTOM_IMAGE_TEMPLATE_STATUSES,
} from "../constants.js";

const isoDateTime = z.union([z.date(), z.string().datetime()]);
const providerKeySchema = z.string().min(1).max(200);
const optionalRecordSchema = z.record(z.string(), z.unknown()).optional().nullable();

export const environmentCustomImageTemplateKindSchema = z.enum(ENVIRONMENT_CUSTOM_IMAGE_TEMPLATE_KINDS);
export const environmentCustomImageTemplateStatusSchema = z.enum(ENVIRONMENT_CUSTOM_IMAGE_TEMPLATE_STATUSES);
export const environmentCustomImageSetupSessionStatusSchema = z.enum(
  ENVIRONMENT_CUSTOM_IMAGE_SETUP_SESSION_STATUSES,
);
export const environmentCustomImageSetupConnectionTypeSchema = z.enum(
  ENVIRONMENT_CUSTOM_IMAGE_SETUP_CONNECTION_TYPES,
);

export const environmentCustomImageSetupConnectionSummarySchema = z.object({
  type: environmentCustomImageSetupConnectionTypeSchema,
  username: z.string().min(1).max(200).optional().nullable(),
  hostRedacted: z.literal(true).optional().default(true),
  portRedacted: z.literal(true).optional().default(true),
  label: z.string().min(1).max(200).optional().nullable(),
  instructions: z.string().min(1).max(1000).optional().nullable(),
}).strict();
export type EnvironmentCustomImageSetupConnectionSummary =
  z.infer<typeof environmentCustomImageSetupConnectionSummarySchema>;

export const environmentCustomImageTemplateSchema = z.object({
  id: z.string().guid(),
  environmentId: z.string().guid(),
  provider: providerKeySchema,
  templateKind: environmentCustomImageTemplateKindSchema,
  templateRef: z.string().min(1).nullable(),
  sourceTemplateRef: z.string().min(1).nullable(),
  sourceEnvironmentConfigFingerprint: z.string().min(1).nullable(),
  status: environmentCustomImageTemplateStatusSchema,
  createdByUserId: z.string().min(1).nullable(),
  createdByAgentId: z.string().guid().nullable(),
  capturedAt: isoDateTime.nullable(),
  lastUsedAt: isoDateTime.nullable(),
  supersededByTemplateId: z.string().guid().nullable(),
  metadata: optionalRecordSchema,
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
}).strict();
export type EnvironmentCustomImageTemplate =
  z.infer<typeof environmentCustomImageTemplateSchema>;

export const environmentCustomImageSetupSessionSchema = z.object({
  id: z.string().guid(),
  environmentId: z.string().guid(),
  templateId: z.string().guid().nullable(),
  promotedTemplateId: z.string().guid().nullable(),
  provider: providerKeySchema,
  providerLeaseId: z.string().min(1).nullable(),
  environmentLeaseId: z.string().guid().nullable(),
  status: environmentCustomImageSetupSessionStatusSchema,
  startedByUserId: z.string().min(1).nullable(),
  startedByAgentId: z.string().guid().nullable(),
  baseTemplateRef: z.string().min(1).nullable(),
  expiresAt: isoDateTime.nullable(),
  finishedAt: isoDateTime.nullable(),
  failureReason: z.string().min(1).nullable(),
  connectionSummary: environmentCustomImageSetupConnectionSummarySchema.nullable(),
  connectionSecretRef: z.string().min(1).nullable(),
  metadata: optionalRecordSchema,
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
}).strict();
export type EnvironmentCustomImageSetupSession =
  z.infer<typeof environmentCustomImageSetupSessionSchema>;

export const startEnvironmentCustomImageSetupSessionSchema = z.object({
  templateId: z.string().guid().optional().nullable(),
  ttlSeconds: z.number().int().min(60).max(24 * 60 * 60).optional(),
}).strict();
export type StartEnvironmentCustomImageSetupSession =
  z.infer<typeof startEnvironmentCustomImageSetupSessionSchema>;

export const finishEnvironmentCustomImageSetupSessionSchema = z.object({
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type FinishEnvironmentCustomImageSetupSession =
  z.infer<typeof finishEnvironmentCustomImageSetupSessionSchema>;

export const cancelEnvironmentCustomImageSetupSessionSchema = z.object({
  reason: z.string().min(1).max(1000).optional(),
}).strict();
export type CancelEnvironmentCustomImageSetupSession =
  z.infer<typeof cancelEnvironmentCustomImageSetupSessionSchema>;

export const relinkEnvironmentCustomImageTemplateSchema = z.object({
  confirmBootSourceDrift: z.boolean().optional().default(false),
}).strict();
export type RelinkEnvironmentCustomImageTemplate =
  z.infer<typeof relinkEnvironmentCustomImageTemplateSchema>;

export const createEnvironmentCustomImageTerminalSessionTokenSchema = z.object({}).strict().default({});
export type CreateEnvironmentCustomImageTerminalSessionToken =
  z.infer<typeof createEnvironmentCustomImageTerminalSessionTokenSchema>;

export const environmentCustomImageTerminalSessionTokenSchema = z.object({
  id: z.string().min(1),
  token: z.string().min(32),
  expiresAt: isoDateTime,
  setupSessionId: z.string().min(1),
  environmentId: z.string().min(1),
  connectionType: z.literal("ssh"),
  websocketPath: z.string().min(1),
}).strict();
export type EnvironmentCustomImageTerminalSessionToken =
  z.infer<typeof environmentCustomImageTerminalSessionTokenSchema>;
