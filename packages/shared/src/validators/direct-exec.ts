import { z } from "zod";
import {
  DIRECT_EXEC_ANSWER_CATEGORIES,
  DIRECT_EXEC_LIFECYCLE_STATUSES,
  DIRECT_EXEC_SCRUB_STATUSES,
  DIRECT_EXEC_SURFACE_TYPES,
  DIRECT_EXEC_VISIBILITIES,
} from "../constants.js";
import { multilineTextSchema } from "./text.js";

export const DIRECT_EXEC_DEFAULT_THRESHOLDS = {
  ackDeadlineSeconds: 30,
  targetReceiptDeadlineSeconds: 120,
  responseTimeoutSeconds: 900,
  deliveryRetryLimit: 3,
  pendingStatusCadenceSeconds: 60,
  paperclipReadMaxAgeSeconds: 60,
  runtimeStatusMaxAgeSeconds: 60,
  heartbeatFreshSeconds: 300,
} as const;

export const directExecLifecycleStatusSchema = z.enum(DIRECT_EXEC_LIFECYCLE_STATUSES);
export const directExecSurfaceTypeSchema = z.enum(DIRECT_EXEC_SURFACE_TYPES);
export const directExecVisibilitySchema = z.enum(DIRECT_EXEC_VISIBILITIES);
export const directExecScrubStatusSchema = z.enum(DIRECT_EXEC_SCRUB_STATUSES);
export const directExecAnswerCategorySchema = z.enum(DIRECT_EXEC_ANSWER_CATEGORIES);

export const directExecThresholdsSchema = z.object({
  ackDeadlineSeconds: z.number().int().positive().default(DIRECT_EXEC_DEFAULT_THRESHOLDS.ackDeadlineSeconds),
  targetReceiptDeadlineSeconds: z.number().int().positive().default(DIRECT_EXEC_DEFAULT_THRESHOLDS.targetReceiptDeadlineSeconds),
  responseTimeoutSeconds: z.number().int().positive().default(DIRECT_EXEC_DEFAULT_THRESHOLDS.responseTimeoutSeconds),
  deliveryRetryLimit: z.number().int().nonnegative().default(DIRECT_EXEC_DEFAULT_THRESHOLDS.deliveryRetryLimit),
  pendingStatusCadenceSeconds: z.number().int().positive().default(DIRECT_EXEC_DEFAULT_THRESHOLDS.pendingStatusCadenceSeconds),
  paperclipReadMaxAgeSeconds: z.number().int().positive().default(DIRECT_EXEC_DEFAULT_THRESHOLDS.paperclipReadMaxAgeSeconds),
  runtimeStatusMaxAgeSeconds: z.number().int().positive().default(DIRECT_EXEC_DEFAULT_THRESHOLDS.runtimeStatusMaxAgeSeconds),
  heartbeatFreshSeconds: z.number().int().positive().default(DIRECT_EXEC_DEFAULT_THRESHOLDS.heartbeatFreshSeconds),
}).strict();

export const directExecSourceMetadataSchema = z.object({
  channel: z.string().trim().min(1).max(80),
  chatId: z.string().trim().min(1).max(200),
  messageId: z.string().trim().min(1).max(200),
  senderId: z.string().trim().min(1).max(200),
  senderLabel: z.string().trim().min(1).max(200).optional().nullable().default(null),
  surfaceType: directExecSurfaceTypeSchema,
  threadId: z.string().trim().min(1).max(200).optional().nullable().default(null),
  replyToMessageId: z.string().trim().min(1).max(200).optional().nullable().default(null),
  receivedAt: z.string().datetime().optional().nullable().default(null),
}).strict();

export const directExecTargetMetadataSchema = z.object({
  alias: z.string().trim().min(1).max(120),
  agentIds: z.array(z.string().uuid()).default([]),
}).strict();

export const directExecDeliveryReceiptSchema = z.object({
  id: z.string().trim().min(1).max(200),
  channel: z.string().trim().min(1).max(80),
  targetId: z.string().trim().min(1).max(200),
  deliveredAt: z.string().datetime().optional().nullable().default(null),
  status: z.enum(["queued", "delivered", "failed"]),
  error: z.string().trim().min(1).max(1000).optional().nullable().default(null),
}).strict();

export const createDirectExecThreadSchema = z.object({
  title: z.string().trim().min(1).max(500),
  description: multilineTextSchema.optional().nullable().default(null),
  projectId: z.string().uuid().optional().nullable().default(null),
  goalId: z.string().uuid().optional().nullable().default(null),
  parentId: z.string().uuid().optional().nullable().default(null),
  priority: z.enum(["critical", "high", "medium", "low"]).optional().default("medium"),
  source: directExecSourceMetadataSchema,
  dedupeKey: z.string().trim().min(1).max(500).optional(),
  target: directExecTargetMetadataSchema,
  visibility: directExecVisibilitySchema,
  originRunId: z.string().trim().min(1).max(200).optional().nullable().default(null),
  timeoutAt: z.string().datetime().optional().nullable().default(null),
  retentionExpiresAt: z.string().datetime().optional().nullable().default(null),
  scrubStatus: directExecScrubStatusSchema.optional().default("not_required"),
  thresholds: directExecThresholdsSchema.partial().optional().default({}),
}).strict();

export const updateDirectExecLifecycleSchema = z.object({
  status: directExecLifecycleStatusSchema,
  statusReason: z.string().trim().min(1).max(1000).optional().nullable().default(null),
  contextBundleId: z.string().uuid().optional().nullable(),
  wakeReceiptIds: z.array(z.string().uuid()).optional(),
  responseIds: z.array(z.string().uuid()).optional(),
  deliveryReceipts: z.array(directExecDeliveryReceiptSchema).optional(),
  timeoutAt: z.string().datetime().optional().nullable(),
  retentionExpiresAt: z.string().datetime().optional().nullable(),
  scrubStatus: directExecScrubStatusSchema.optional(),
}).strict();

export const directExecContextSourceSchema = z.object({
  sourceName: z.string().trim().min(1).max(160),
  sourceId: z.string().trim().min(1).max(300),
  fetchedAt: z.string().datetime(),
  maxAgeSeconds: z.number().int().positive(),
  stale: z.boolean().optional(),
  unavailableReason: z.string().trim().min(1).max(1000).optional().nullable().default(null),
  errorReason: z.string().trim().min(1).max(1000).optional().nullable().default(null),
}).strict();

export const directExecContextConflictSchema = z.object({
  field: z.string().trim().min(1).max(160),
  sources: z.array(z.string().trim().min(1).max(300)).min(2),
  resolution: z.enum(["live_paperclip", "target_authored", "newer_same_source", "unresolved"]).default("unresolved"),
  surfaced: z.boolean().optional().default(true),
  evidence: z.string().trim().min(1).max(2000),
}).strict();

export const directExecContextItemSchema = z.object({
  sourceName: z.string().trim().min(1).max(160),
  sourceId: z.string().trim().min(1).max(300),
  kind: z.string().trim().min(1).max(120),
  data: z.record(z.string(), z.unknown()).default({}),
}).strict();

export const directExecAnswerEvidenceSchema = z.object({
  sourceName: z.string().trim().min(1).max(160),
  sourceId: z.string().trim().min(1).max(300),
  detail: z.string().trim().min(1).max(2000),
}).strict();

export const directExecAnswerEvidenceByCategorySchema = z
  .object(Object.fromEntries(
    DIRECT_EXEC_ANSWER_CATEGORIES.map((category) => [
      category,
      z.array(directExecAnswerEvidenceSchema).min(1).optional(),
    ]),
  ) as Record<(typeof DIRECT_EXEC_ANSWER_CATEGORIES)[number], z.ZodOptional<z.ZodArray<typeof directExecAnswerEvidenceSchema>>>)
  .partial()
  .strict();

export const upsertDirectExecContextBundleSchema = z.object({
  sources: z.array(directExecContextSourceSchema).min(1),
  items: z.array(directExecContextItemSchema).optional().default([]),
  conflicts: z.array(directExecContextConflictSchema).default([]),
  answerCategory: directExecAnswerCategorySchema.optional().nullable().default(null),
  answerEvidence: directExecAnswerEvidenceByCategorySchema.default({}),
}).strict().superRefine((value, ctx) => {
  if (!value.answerCategory) return;
  const categoryEvidence = value.answerEvidence[value.answerCategory];
  if (!categoryEvidence || categoryEvidence.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["answerEvidence", value.answerCategory],
      message: `answerCategory ${value.answerCategory} requires named evidence`,
    });
  }
});

export const assembleDirectExecContextBundleSchema = z.object({
  issueRefs: z.array(z.string().trim().min(1).max(120)).default([]),
  targetAgentIds: z.array(z.string().uuid()).default([]),
  runtimeRefs: z.array(z.object({
    kind: z.enum(["operator_runtime", "generator_runtime"]),
    id: z.string().trim().min(1).max(200),
  }).strict()).default([]),
  answerCategory: directExecAnswerCategorySchema.optional().nullable().default(null),
  answerEvidence: directExecAnswerEvidenceByCategorySchema.default({}),
}).strict().superRefine((value, ctx) => {
  if (!value.answerCategory) return;
  const categoryEvidence = value.answerEvidence[value.answerCategory];
  if (!categoryEvidence || categoryEvidence.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["answerEvidence", value.answerCategory],
      message: `answerCategory ${value.answerCategory} requires named evidence`,
    });
  }
});

export type CreateDirectExecThread = z.infer<typeof createDirectExecThreadSchema>;
export type UpdateDirectExecLifecycle = z.infer<typeof updateDirectExecLifecycleSchema>;
export type UpsertDirectExecContextBundle = z.infer<typeof upsertDirectExecContextBundleSchema>;
export type AssembleDirectExecContextBundle = z.infer<typeof assembleDirectExecContextBundleSchema>;
export type DirectExecThresholdsInput = z.infer<typeof directExecThresholdsSchema>;
