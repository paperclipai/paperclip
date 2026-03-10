import { z } from "zod";
import {
  BRIEFING_CADENCES,
  BRIEFING_RECORD_KINDS,
  BRIEFING_SCHEDULE_RUN_STATUSES,
  BRIEFING_WINDOW_PRESETS,
  HEALTH_DELTAS,
  HEALTH_STATUSES,
  PLAN_RECORD_KINDS,
  PRICING_STATES,
  RECORD_CATEGORIES,
  RECORD_LINK_RELATIONS,
  RECORD_LINK_TARGET_TYPES,
  RECORD_SCOPE_TYPES,
  RECORD_STATUSES,
  RESULT_RECORD_KINDS,
} from "../constants.js";

export const recordCategorySchema = z.enum(RECORD_CATEGORIES);
export const recordScopeTypeSchema = z.enum(RECORD_SCOPE_TYPES);
export const recordStatusSchema = z.enum(RECORD_STATUSES);
export const planRecordKindSchema = z.enum(PLAN_RECORD_KINDS);
export const resultRecordKindSchema = z.enum(RESULT_RECORD_KINDS);
export const briefingRecordKindSchema = z.enum(BRIEFING_RECORD_KINDS);
export const briefingCadenceSchema = z.enum(BRIEFING_CADENCES);
export const briefingWindowPresetSchema = z.enum(BRIEFING_WINDOW_PRESETS);
export const briefingScheduleRunStatusSchema = z.enum(BRIEFING_SCHEDULE_RUN_STATUSES);
export const healthStatusSchema = z.enum(HEALTH_STATUSES);
export const healthDeltaSchema = z.enum(HEALTH_DELTAS);
export const pricingStateSchema = z.enum(PRICING_STATES);
export const recordLinkTargetTypeSchema = z.enum(RECORD_LINK_TARGET_TYPES);
export const recordLinkRelationSchema = z.enum(RECORD_LINK_RELATIONS);

const recordBaseFields = {
  scopeType: recordScopeTypeSchema,
  scopeRefId: z.string().uuid(),
  title: z.string().trim().min(1).max(240),
  summary: z.string().trim().max(2000).nullable().optional(),
  bodyMd: z.string().nullable().optional(),
  status: recordStatusSchema.optional(),
  ownerAgentId: z.string().uuid().nullable().optional(),
  decisionNeeded: z.boolean().optional(),
  decisionDueAt: z.string().datetime().nullable().optional(),
  healthStatus: healthStatusSchema.nullable().optional(),
  healthDelta: healthDeltaSchema.nullable().optional(),
  confidence: z.number().int().min(0).max(100).nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
};

export const createPlanRecordSchema = z.object({
  ...recordBaseFields,
  kind: planRecordKindSchema,
});
export type CreatePlanRecord = z.infer<typeof createPlanRecordSchema>;

export const createResultRecordSchema = z.object({
  ...recordBaseFields,
  kind: resultRecordKindSchema,
});
export type CreateResultRecord = z.infer<typeof createResultRecordSchema>;

export const createBriefingRecordSchema = z.object({
  ...recordBaseFields,
  kind: briefingRecordKindSchema,
});
export type CreateBriefingRecord = z.infer<typeof createBriefingRecordSchema>;

export const updateRecordSchema = z.object({
  category: recordCategorySchema.optional(),
  kind: z.string().min(1).optional(),
  ...recordBaseFields,
}).partial();
export type UpdateRecord = z.infer<typeof updateRecordSchema>;

export const createRecordLinkSchema = z.object({
  targetType: recordLinkTargetTypeSchema,
  targetId: z.string().uuid(),
  relation: recordLinkRelationSchema.optional().default("related"),
});
export type CreateRecordLink = z.infer<typeof createRecordLinkSchema>;

export const createRecordAttachmentSchema = z.object({
  assetId: z.string().uuid(),
});
export type CreateRecordAttachment = z.infer<typeof createRecordAttachmentSchema>;

export const generateRecordSchema = z.object({
  since: z.union([z.literal("last_visit"), z.string().datetime()]).optional(),
  windowPreset: briefingWindowPresetSchema.optional(),
  from: z.string().datetime().nullable().optional(),
  to: z.string().datetime().nullable().optional(),
});
export type GenerateRecord = z.infer<typeof generateRecordSchema>;

export const upsertBriefingScheduleSchema = z.object({
  enabled: z.boolean().optional().default(true),
  cadence: briefingCadenceSchema,
  timezone: z.string().trim().min(1).max(120),
  localHour: z.number().int().min(0).max(23),
  localMinute: z.number().int().min(0).max(59),
  dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
  windowPreset: briefingWindowPresetSchema,
  autoPublish: z.boolean().optional().default(false),
});
export type UpsertBriefingSchedule = z.infer<typeof upsertBriefingScheduleSchema>;

export const publishRecordSchema = z.object({});
export type PublishRecord = z.infer<typeof publishRecordSchema>;

export const boardSummaryQuerySchema = z.object({
  scopeType: recordScopeTypeSchema.default("company"),
  scopeId: z.string().uuid().optional(),
  since: z.union([z.literal("last_visit"), z.string().datetime()]).optional(),
});
export type BoardSummaryQuery = z.infer<typeof boardSummaryQuerySchema>;

export const promoteToResultSchema = z.object({
  sourceType: z.enum(["issue", "heartbeat_run", "approval"]),
  sourceId: z.string().uuid(),
  kind: resultRecordKindSchema.optional().default("status_report"),
  title: z.string().trim().min(1).max(240).optional(),
  summary: z.string().trim().max(2000).nullable().optional(),
});
export type PromoteToResult = z.infer<typeof promoteToResultSchema>;
