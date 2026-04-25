import { z } from "zod";

const optionalDateTimeSchema = z.string().datetime().optional().nullable();
const metadataSchema = z.record(z.unknown());
const hasText = (value: string | null | undefined) => typeof value === "string" && value.trim().length > 0;

export const truthDocumentIngestStatusSchema = z.enum(["pending", "running", "succeeded", "failed"]);
export const truthDocumentEmbeddingStatusSchema = z.enum([
  "not_required",
  "pending",
  "running",
  "succeeded",
  "failed",
]);
export const truthDocumentExclusionStatusSchema = z.enum(["included", "excluded", "pending_review"]);
export const truthRunStatusSchema = z.enum([
  "pending",
  "running",
  "needs_review",
  "accepted",
  "failed",
  "superseded",
]);
export const truthAtomLedgerSectionSchema = z.enum(["truth", "context", "noise", "open_question", "risk"]);
export const truthAtomStatusSchema = z.enum(["needs_review", "accepted", "rejected", "superseded"]);
export const truthRunAuditTypeSchema = z.enum(["hallucination", "omission", "coverage", "integrity"]);
export const truthRunAuditStatusSchema = z.enum(["pending", "running", "succeeded", "failed"]);
export const truthBriefStatusSchema = z.enum(["draft", "needs_review", "accepted", "rejected", "superseded"]);
export const truthDossierStatusSchema = z.enum(["draft", "ready", "published", "superseded", "failed"]);
export const truthPromotionRequestStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "completed",
  "failed",
  "expired",
]);

export const truthBriefCanonicalInputSchema = z
  .object({
    atomIds: z.array(z.string()),
    auditIds: z.array(z.string()),
    promptInputs: metadataSchema,
    templateVariables: metadataSchema,
  })
  .passthrough();

export const createTruthDocumentSchema = z.object({
  companySlug: z.string().min(1),
  title: z.string().optional().nullable(),
  sourceType: z.string().min(1),
  sourceUri: z.string().optional().nullable(),
  sourceSha256: z.string().optional().nullable(),
  ingestStatus: truthDocumentIngestStatusSchema.optional().default("pending"),
  embeddingStatus: truthDocumentEmbeddingStatusSchema.optional().default("not_required"),
  exclusionStatus: truthDocumentExclusionStatusSchema.optional().default("included"),
  mappingConfidence: z.string().optional().nullable(),
  mappingReason: z.string().optional().nullable(),
  metadata: metadataSchema.optional().default({}),
});

export type CreateTruthDocument = z.infer<typeof createTruthDocumentSchema>;

export const createTruthDocumentChunkSchema = z.object({
  id: z.string().uuid().optional(),
  truthDocumentId: z.string().uuid(),
  sourceChunkKey: z.string().min(1),
  deterministicKey: z.string().min(1),
  chunkIndex: z.number().int().nonnegative().optional().default(0),
  chunkKind: z.string().min(1).optional().default("text"),
  contentText: z.string().optional().default(""),
  contentSha256: z.string().optional().nullable(),
  metadata: metadataSchema.optional().default({}),
});

export type CreateTruthDocumentChunk = z.infer<typeof createTruthDocumentChunkSchema>;

export const createTruthRunSchema = z.object({
  companySlug: z.string().min(1),
  truthDocumentId: z.string().uuid(),
  status: truthRunStatusSchema.optional().default("pending"),
  title: z.string().optional().nullable(),
  extractionVersion: z.string().min(1).optional().default("truth_atom_extractor_v1"),
  promptVersion: z.string().min(1),
  model: z.string().optional().nullable(),
  sourceCounts: metadataSchema.optional().default({}),
  startedAt: optionalDateTimeSchema,
  completedAt: optionalDateTimeSchema,
  failedAt: optionalDateTimeSchema,
  failureReason: z.string().optional().nullable(),
  metadata: metadataSchema.optional().default({}),
});

export type CreateTruthRun = z.infer<typeof createTruthRunSchema>;

export const createTruthAtomSchema = z.object({
  truthRunId: z.string().uuid(),
  truthDocumentId: z.string().uuid(),
  truthDocumentChunkId: z.string().uuid().optional().nullable(),
  rawAtomId: z.string().optional().nullable(),
  atomIndex: z.number().int().nonnegative(),
  ledgerSection: truthAtomLedgerSectionSchema,
  atomType: z.string().min(1),
  atomText: z.string().min(1),
  durabilityScore: z.number().int(),
  confidenceScore: z.string().min(1),
  evidenceMode: z.string().min(1),
  speakerName: z.string().optional().nullable(),
  speakerId: z.string().optional().nullable(),
  startTime: z.string().optional().nullable(),
  endTime: z.string().optional().nullable(),
  sourceUtteranceIds: z.array(z.string()).optional().default([]),
  evidenceQuote: z.string().min(1),
  planningRelevance: z.string().optional().nullable(),
  status: truthAtomStatusSchema.optional().default("needs_review"),
  auditFlags: metadataSchema.optional().default({}),
  metadata: metadataSchema.optional().default({}),
});

export type CreateTruthAtom = z.infer<typeof createTruthAtomSchema>;

export const createTruthRunAuditSchema = z.object({
  truthRunId: z.string().uuid(),
  auditType: truthRunAuditTypeSchema,
  status: truthRunAuditStatusSchema.optional().default("pending"),
  auditorModel: z.string().optional().nullable(),
  promptVersion: z.string().min(1),
  templateVersion: z.string().optional().nullable(),
  findingCount: z.number().int().nonnegative().optional().default(0),
  summary: z.string().optional().nullable(),
  findings: z.array(metadataSchema).optional().default([]),
  startedAt: optionalDateTimeSchema,
  completedAt: optionalDateTimeSchema,
  failedAt: optionalDateTimeSchema,
  failureReason: z.string().optional().nullable(),
});

export type CreateTruthRunAudit = z.infer<typeof createTruthRunAuditSchema>;

export const createTruthBriefSchema = z.object({
  truthRunId: z.string().uuid(),
  title: z.string().min(1),
  status: truthBriefStatusSchema.optional().default("draft"),
  briefKind: z.string().min(1),
  contentMarkdown: z.string().optional().nullable(),
  contentJson: metadataSchema.optional().nullable(),
  canonicalInput: truthBriefCanonicalInputSchema,
  promptVersion: z.string().min(1),
  templateVersion: z.string().min(1),
  model: z.string().optional().nullable(),
  inputHash: z.string().min(1),
  payloadHash: z.string().optional().nullable(),
  createdByAgentId: z.string().uuid().optional().nullable(),
  createdByUserId: z.string().optional().nullable(),
  reviewedAt: optionalDateTimeSchema,
  reviewedBy: z.string().optional().nullable(),
  rejectionReason: z.string().optional().nullable(),
});

export type CreateTruthBrief = z.infer<typeof createTruthBriefSchema>;

export const createTruthDossierSchema = z
  .object({
    truthRunId: z.string().uuid(),
    briefId: z.string().uuid(),
    title: z.string().min(1),
    status: truthDossierStatusSchema.optional().default("draft"),
    htmlContent: z.string().optional().nullable(),
    filePath: z.string().optional().nullable(),
    contentSha256: z.string().optional().nullable(),
    briefInputHash: z.string().min(1),
    briefPayloadHash: z.string().min(1),
    promptVersion: z.string().min(1),
    templateVersion: z.string().min(1),
    generatedAt: optionalDateTimeSchema,
    generatedByAgentId: z.string().uuid().optional().nullable(),
    generatedByUserId: z.string().optional().nullable(),
    metadata: metadataSchema.optional().default({}),
  })
  .superRefine((value, ctx) => {
    if (!hasText(value.htmlContent) && !hasText(value.filePath)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Either htmlContent or filePath is required",
        path: ["htmlContent"],
      });
    }
  });

export type CreateTruthDossier = z.infer<typeof createTruthDossierSchema>;

export const createTruthPromotionRequestSchema = z
  .object({
    companySlug: z.string().min(1),
    truthRunId: z.string().uuid().optional().nullable(),
    briefId: z.string().uuid().optional().nullable(),
    dossierId: z.string().uuid().optional().nullable(),
    requestedBy: z.string().min(1),
    requestReason: z.string().optional().nullable(),
    status: truthPromotionRequestStatusSchema.optional().default("pending"),
    expiresAt: optionalDateTimeSchema,
    metadata: metadataSchema.optional().default({}),
  })
  .superRefine((value, ctx) => {
    if (!value.truthRunId && !value.briefId && !value.dossierId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one of truthRunId, briefId, or dossierId is required",
        path: ["truthRunId"],
      });
    }
  });

export type CreateTruthPromotionRequest = z.infer<typeof createTruthPromotionRequestSchema>;

export const approveTruthPromotionRequestSchema = z.object({
  approvedBy: z.string().min(1),
  metadata: metadataSchema.optional().nullable(),
});

export type ApproveTruthPromotionRequest = z.infer<typeof approveTruthPromotionRequestSchema>;

export const rejectTruthPromotionRequestSchema = z.object({
  rejectionReason: z.string().min(1),
  metadata: metadataSchema.optional().nullable(),
});

export type RejectTruthPromotionRequest = z.infer<typeof rejectTruthPromotionRequestSchema>;

export const completeTruthPromotionRequestSchema = z.object({
  metadata: metadataSchema.optional().nullable(),
});

export type CompleteTruthPromotionRequest = z.infer<typeof completeTruthPromotionRequestSchema>;

export const failTruthPromotionRequestSchema = z.object({
  failureReason: z.string().min(1),
  metadata: metadataSchema.optional().nullable(),
});

export type FailTruthPromotionRequest = z.infer<typeof failTruthPromotionRequestSchema>;
