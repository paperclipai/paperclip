import { z } from "zod";
import {
  CLIP_COMMENT_CATEGORIES,
  CLIP_DEPENDENCY_REQUIREMENTS,
  CLIP_DEPENDENCY_TYPES,
  CLIP_IMPORT_STATUSES,
  CLIP_MODERATION_STATES,
  CLIP_REPORT_REASONS,
  CLIP_SECURITY_REVIEW_STATES,
  CLIP_STATUSES,
  CLIP_TYPES,
  CLIP_VERIFICATION_STATES,
  CLIP_VISIBILITIES,
  CLIP_VOTE_VALUES,
} from "../types/clip.js";

const slugSchema = z
  .string()
  .min(3)
  .max(96)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const publicTextSchema = z.string().trim().min(1).max(12_000);
const shortPublicTextSchema = z.string().trim().min(1).max(280);
const tagArraySchema = z.array(z.string().trim().min(1).max(48)).max(24).default([]);
const recordSchema = z.record(z.string(), z.unknown());
const optionalRecordSchema = recordSchema.nullable().optional();

export const clipTypeSchema = z.enum(CLIP_TYPES);
export const clipVisibilitySchema = z.enum(CLIP_VISIBILITIES);
export const clipStatusSchema = z.enum(CLIP_STATUSES);
export const clipModerationStateSchema = z.enum(CLIP_MODERATION_STATES);
export const clipSecurityReviewStateSchema = z.enum(CLIP_SECURITY_REVIEW_STATES);
export const clipVerificationStateSchema = z.enum(CLIP_VERIFICATION_STATES);
export const clipDependencyTypeSchema = z.enum(CLIP_DEPENDENCY_TYPES);
export const clipVoteValueSchema = z.enum(CLIP_VOTE_VALUES);
export const clipReportReasonSchema = z.enum(CLIP_REPORT_REASONS);

export const createClipCreatorProfileSchema = z.object({
  handle: slugSchema,
  displayName: z.string().trim().min(1).max(96),
  bio: z.string().trim().max(1_000).nullable().optional(),
  avatarUrl: z.string().url().nullable().optional(),
  websiteUrl: z.string().url().nullable().optional(),
  verificationState: z.string().trim().min(1).max(48).optional(),
  reputationSummary: recordSchema.optional(),
});

export type CreateClipCreatorProfile = z.infer<typeof createClipCreatorProfileSchema>;

export const clipDependencyInputSchema = z.object({
  type: clipDependencyTypeSchema,
  key: z.string().trim().min(1).max(160),
  displayName: z.string().trim().min(1).max(160).nullable().optional(),
  required: z.enum(CLIP_DEPENDENCY_REQUIREMENTS).optional(),
  metadata: recordSchema.optional(),
});

export type ClipDependencyInput = z.infer<typeof clipDependencyInputSchema>;

export const clipRevisionInputSchema = z.object({
  manifestVersion: z.string().trim().min(1).max(64).optional(),
  manifestChecksum: z.string().trim().min(8).max(160),
  artifactChecksum: z.string().trim().min(8).max(160),
  manifestPayload: recordSchema,
  artifactRef: optionalRecordSchema,
  dependencyGraph: recordSchema.optional(),
  dependencies: z.array(clipDependencyInputSchema).max(200).optional(),
  permissions: z.array(recordSchema).max(200).optional(),
  secretsSchema: z.array(recordSchema).max(200).optional(),
  budgetEstimate: optionalRecordSchema,
  redactionReport: recordSchema.optional(),
  dangerousCapabilities: z.array(z.string().trim().min(1).max(80)).max(100).optional(),
  securityReviewState: clipSecurityReviewStateSchema.optional(),
  verificationState: clipVerificationStateSchema.optional(),
  compatibility: recordSchema.optional(),
  changeSummary: z.string().trim().max(4_000).nullable().optional(),
  breakingChanges: z.string().trim().max(4_000).nullable().optional(),
  migrationNotes: z.string().trim().max(4_000).nullable().optional(),
});

export type ClipRevisionInput = z.infer<typeof clipRevisionInputSchema>;

export const publishClipSchema = z.object({
  creatorProfileId: z.string().uuid().optional(),
  creatorProfile: createClipCreatorProfileSchema.optional(),
  slug: slugSchema,
  type: clipTypeSchema,
  title: z.string().trim().min(1).max(160),
  summary: shortPublicTextSchema,
  description: publicTextSchema.nullable().optional(),
  visibility: clipVisibilitySchema.optional(),
  status: clipStatusSchema.optional(),
  tags: tagArraySchema.optional(),
  categories: tagArraySchema.optional(),
  useCases: tagArraySchema.optional(),
  requiredProviders: tagArraySchema.optional(),
  compatibility: recordSchema.optional(),
  sourceKind: z.string().trim().min(1).max(80).nullable().optional(),
  sourceObjectType: z.string().trim().min(1).max(80).nullable().optional(),
  sourceObjectId: z.string().trim().min(1).max(160).nullable().optional(),
  revision: clipRevisionInputSchema,
}).refine((value) => value.creatorProfileId || value.creatorProfile, {
  message: "creatorProfileId or creatorProfile is required",
  path: ["creatorProfileId"],
});

export type PublishClip = z.infer<typeof publishClipSchema>;

export const createClipRevisionSchema = clipRevisionInputSchema;
export type CreateClipRevision = z.infer<typeof createClipRevisionSchema>;

export const updateClipSchema = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    summary: shortPublicTextSchema.optional(),
    description: publicTextSchema.nullable().optional(),
    visibility: clipVisibilitySchema.optional(),
    status: clipStatusSchema.optional(),
    moderationState: clipModerationStateSchema.optional(),
    latestApprovedRevisionId: z.string().uuid().nullable().optional(),
    tags: tagArraySchema.optional(),
    categories: tagArraySchema.optional(),
    useCases: tagArraySchema.optional(),
    requiredProviders: tagArraySchema.optional(),
    compatibility: recordSchema.optional(),
    moderationReason: z.string().trim().max(1_000).optional(),
  })
  .strict();

export type UpdateClip = z.infer<typeof updateClipSchema>;

export const createClipVoteSchema = z.object({
  revisionNumber: z.number().int().positive().optional(),
  vote: clipVoteValueSchema,
  reason: z.string().trim().max(400).nullable().optional(),
  metadata: recordSchema.optional(),
});

export type CreateClipVote = z.infer<typeof createClipVoteSchema>;

export const createClipReportSchema = z.object({
  revisionNumber: z.number().int().positive().optional(),
  reason: clipReportReasonSchema,
  details: z.string().trim().max(4_000).nullable().optional(),
  metadata: recordSchema.optional(),
});

export type CreateClipReport = z.infer<typeof createClipReportSchema>;

export const createClipCommentSchema = z.object({
  revisionNumber: z.number().int().positive().optional(),
  scope: z.enum(["clip", "revision"]).optional(),
  category: z.enum(CLIP_COMMENT_CATEGORIES).optional(),
  body: publicTextSchema,
});

export type CreateClipComment = z.infer<typeof createClipCommentSchema>;

export const createClipShowcaseSchema = z.object({
  revisionNumber: z.number().int().positive().optional(),
  type: z.string().trim().min(1).max(80).optional(),
  title: z.string().trim().min(1).max(160),
  body: publicTextSchema.nullable().optional(),
  mediaRefs: z.array(recordSchema).max(12).optional(),
  validationState: clipVerificationStateSchema.optional(),
});

export type CreateClipShowcase = z.infer<typeof createClipShowcaseSchema>;

export const createClipImportTelemetrySchema = z.object({
  revisionNumber: z.number().int().positive().optional(),
  destinationCompanyId: z.string().uuid().optional(),
  status: z.enum(CLIP_IMPORT_STATUSES).optional(),
  sourceUrl: z.string().url().nullable().optional(),
  revisionUrl: z.string().url().nullable().optional(),
  metadata: recordSchema.optional(),
});

export type CreateClipImportTelemetry = z.infer<typeof createClipImportTelemetrySchema>;

export const clipSharePreviewSchema = z.object({
  source: z.object({
    type: clipTypeSchema,
    id: z.string().trim().min(1).max(160),
  }),
  title: z.string().trim().min(1).max(160).optional(),
  summary: shortPublicTextSchema.optional(),
  slug: slugSchema.optional(),
  visibility: clipVisibilitySchema.optional(),
  revisionNote: z.string().trim().max(4_000).nullable().optional(),
});

export type ClipSharePreview = z.infer<typeof clipSharePreviewSchema>;

export const clipImportPreviewSchema = z.object({
  url: z.string().trim().min(1).max(2_000),
  collisionStrategy: z.enum(["rename", "skip"]).optional(),
});

export type ClipImportPreview = z.infer<typeof clipImportPreviewSchema>;

export const clipImportApplySchema = clipImportPreviewSchema.extend({
  selectedOptions: recordSchema.optional(),
});

export type ClipImportApply = z.infer<typeof clipImportApplySchema>;
