import { z } from "zod";
import { ATTENTION_SOURCE_KINDS } from "../types/attention.js";

export const decisionAttentionSourceKindSchema = z.enum(ATTENTION_SOURCE_KINDS);

export const decisionQueueKeySchema = z.string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Queue key must be URL-safe lowercase kebab-case");

export const createDecisionQueueSchema = z.object({
  key: decisionQueueKeySchema,
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000).nullable().optional(),
  retentionDays: z.number().int().min(1).max(3_650).nullable().optional(),
}).strict();

export const updateDecisionQueueSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2_000).nullable().optional(),
  retentionDays: z.number().int().min(1).max(3_650).nullable().optional(),
  seedRulesEnabled: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one queue field is required");

export const addDecisionQueueItemSchema = z.object({
  sourceKind: decisionAttentionSourceKindSchema,
  sourceId: z.string().trim().min(1).max(500),
}).strict();

export const removeDecisionQueueItemSchema = z.object({
  reason: z.string().trim().max(2_000).optional(),
}).strict().default({});

const calendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Invalid calendar date");

export const decisionTriageDecideBySchema = z.union([
  z.enum(["today", "this_week", "whenever"]),
  calendarDateSchema,
]);

export const updateDecisionTriageSchema = z.object({
  decideBy: decisionTriageDecideBySchema.nullable().optional(),
  snoozedUntil: z.string().datetime({ offset: true }).nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one triage field is required");

export const updateDecisionRetentionSchema = z.object({
  keep: z.boolean(),
}).strict();

export const createDecisionArchiveProposalSchema = z.object({
  items: z.array(z.object({
    sourceKind: decisionAttentionSourceKindSchema,
    sourceId: z.string().trim().min(1).max(500),
    reason: z.string().trim().min(1).max(2_000),
  }).strict()).min(1).max(50),
  idempotencyKey: z.string().trim().min(1).max(500).optional(),
}).strict().superRefine((value, ctx) => {
  const seen = new Set<string>();
  value.items.forEach((item, index) => {
    const key = `${item.sourceKind}:${item.sourceId}`;
    if (seen.has(key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Archive proposal items must be unique", path: ["items", index] });
    }
    seen.add(key);
  });
});

export type CreateDecisionQueueInput = z.infer<typeof createDecisionQueueSchema>;
export type UpdateDecisionQueueInput = z.infer<typeof updateDecisionQueueSchema>;
export type AddDecisionQueueItemInput = z.infer<typeof addDecisionQueueItemSchema>;
export type RemoveDecisionQueueItemInput = z.infer<typeof removeDecisionQueueItemSchema>;
export type UpdateDecisionTriageInput = z.infer<typeof updateDecisionTriageSchema>;
export type UpdateDecisionRetentionInput = z.infer<typeof updateDecisionRetentionSchema>;
export type CreateDecisionArchiveProposalInput = z.infer<typeof createDecisionArchiveProposalSchema>;
