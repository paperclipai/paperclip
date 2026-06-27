import { z } from "zod";
import {
  LOW_TRUST_REVIEW_PRESET,
  LOW_TRUST_REVIEW_PRESET_VERSION,
  LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION,
  TRUST_PRESETS,
} from "../trust-policy.js";

export const trustPresetSchema = z.enum(TRUST_PRESETS);

export const lowTrustOutputPromotionTargetSchema = z.object({
  type: z.literal("issue"),
  issueId: z.string().uuid(),
}).strict();

export const lowTrustBoundarySchema = z.object({
  mode: z.literal(LOW_TRUST_REVIEW_PRESET),
  companyId: z.string().uuid().optional(),
  projectIds: z.array(z.string().uuid()).optional(),
  rootIssueId: z.string().uuid().optional(),
  issueIds: z.array(z.string().uuid()).optional(),
  allowedAgentIds: z.array(z.string().uuid()).optional(),
  allowedSecretBindingIds: z.array(z.string().uuid()).optional(),
  allowedToolClasses: z.array(z.string().trim().min(1)).optional(),
  outputPromotionTarget: lowTrustOutputPromotionTargetSchema.optional(),
}).strict();

export const lowTrustReviewPresetPolicySchema = z.object({
  id: z.literal(LOW_TRUST_REVIEW_PRESET),
  version: z.literal(LOW_TRUST_REVIEW_PRESET_VERSION),
  rawOutputDisposition: z.literal(LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION),
}).strict();

export const trustAuthorizationPolicySchema = z.object({
  trustPreset: trustPresetSchema.optional(),
  reviewPreset: lowTrustReviewPresetPolicySchema.optional(),
  trustBoundary: lowTrustBoundarySchema.optional(),
}).catchall(z.unknown());

export const sourceTrustArtifactKindSchema = z.enum(["issue", "comment", "document", "work_product"]);

export const sourceTrustMetadataSchema = z.object({
  preset: trustPresetSchema,
  disposition: z.enum(["quarantined", "promoted"]),
  sourceIssueId: z.string().uuid().nullable().optional(),
  sourceRunId: z.string().uuid().nullable().optional(),
  sourceAgentId: z.string().uuid().nullable().optional(),
  promotedFrom: z.object({
    artifactKind: sourceTrustArtifactKindSchema,
    artifactId: z.string().uuid(),
    issueId: z.string().uuid().nullable().optional(),
  }).strict().nullable().optional(),
  promotedByActorType: z.enum(["agent", "user", "system"]).nullable().optional(),
  promotedByActorId: z.string().trim().min(1).nullable().optional(),
  promotedAt: z.string().datetime({ offset: true }).nullable().optional(),
}).strict();

export type TrustPresetInput = z.infer<typeof trustPresetSchema>;
export type LowTrustBoundaryInput = z.infer<typeof lowTrustBoundarySchema>;
export type TrustAuthorizationPolicyInput = z.infer<typeof trustAuthorizationPolicySchema>;
export type SourceTrustMetadataInput = z.infer<typeof sourceTrustMetadataSchema>;
