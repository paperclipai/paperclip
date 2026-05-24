import { z } from "@paperclipai/plugin-sdk";

export const briefCardStateSchema = z.enum([
  "error",
  "blocked",
  "waiting-user",
  "waiting-reviewer",
  "live",
  "done",
  "stale",
]);

export const briefSummaryStatusSchema = z.enum(["ok", "pending", "fallback"]);

export const briefSummaryFailureReasonSchema = z.enum([
  "model_error",
  "truncation_failed",
  "budget_capped",
  "safety_block",
]);

export const briefSourceKindSchema = z.enum([
  "issue_tree",
  "issue",
  "comment",
  "run",
  "document",
  "work_product",
  "interaction",
  "activity_event",
  "approval",
]);

export const briefTaskRowSchema = z.object({
  kind: briefSourceKindSchema.exclude(["issue_tree", "activity_event", "work_product"]),
  sourceId: z.string().min(1),
  issueId: z.string().min(1).nullable(),
  identifier: z.string().min(1).nullable(),
  titleLine: z.string().min(1).max(120),
  rightTag: z.string().min(1).max(40),
  linkPath: z.string().min(1),
  isIntraTreeBlocked: z.boolean().nullable(),
  eventAt: z.string().min(1),
}).strict();

export const briefCardSourceSchema = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  userId: z.string().min(1),
  cardId: z.string().min(1),
  sourceKind: briefSourceKindSchema,
  sourceId: z.string().min(1),
  issueId: z.string().min(1).nullable(),
  identifier: z.string().min(1).nullable(),
  titleLine: z.string().min(1).max(160),
  rightTag: z.string().min(1).max(60),
  linkPath: z.string().min(1),
  isIntraTreeBlocked: z.boolean().nullable(),
  eventAt: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).strict();

export const briefSnapshotSchema = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  userId: z.string().min(1),
  cardId: z.string().min(1),
  summaryParagraph: z.string().max(900).nullable(),
  summaryStatus: briefSummaryStatusSchema,
  summaryModel: z.string().min(1).nullable(),
  summaryTokensIn: z.number().int().nonnegative().nullable(),
  summaryTokensOut: z.number().int().nonnegative().nullable(),
  summaryFailureReason: briefSummaryFailureReasonSchema.nullable(),
  taskRows: z.array(briefTaskRowSchema).max(3),
  evidenceSourceIds: z.array(z.string().min(1)),
  generatedByAgentId: z.string().min(1).nullable(),
  generatedByRunId: z.string().min(1).nullable(),
  deterministicStateInputs: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string().min(1),
}).strict();

export const briefCardSchema = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  userId: z.string().min(1),
  slug: z.string().min(1).max(120),
  title: z.string().min(1).max(90),
  groupingDescription: z.string().min(1).max(500),
  rootIssueId: z.string().min(1).nullable(),
  state: briefCardStateSchema,
  summaryStatus: briefSummaryStatusSchema,
  pinned: z.boolean(),
  hidden: z.boolean(),
  staleAt: z.string().min(1),
  expiresAt: z.string().min(1).nullable(),
  latestSnapshotId: z.string().min(1).nullable(),
  lastMeaningfulEventAt: z.string().min(1),
  snapshot: briefSnapshotSchema,
  sources: z.array(briefCardSourceSchema),
  moreSourceCount: z.number().int().nonnegative(),
}).strict();

export const briefPreferencesSchema = z.object({
  companyId: z.string().min(1),
  userId: z.string().min(1),
  cadence: z.enum(["manual", "hourly", "daily"]).default("hourly"),
  retentionDays: z.number().int().positive().default(7),
  doneRetentionHours: z.number().int().positive().default(72),
  staleAfterDays: z.number().int().positive().default(7),
  maxUnpinnedCards: z.number().int().positive().default(30),
  scope: z.literal("user").default("user"),
}).strict();

export const listBriefCardsInputSchema = z.object({
  companyId: z.string().min(1),
  userId: z.string().min(1),
  includeHidden: z.boolean().optional().default(false),
  limit: z.number().int().positive().max(100).optional().default(50),
}).strict();

export const pinBriefCardInputSchema = z.object({
  companyId: z.string().min(1),
  userId: z.string().min(1),
  cardId: z.string().min(1),
  pinned: z.boolean(),
}).strict();

export const dismissBriefCardInputSchema = z.object({
  companyId: z.string().min(1),
  userId: z.string().min(1),
  cardId: z.string().min(1),
}).strict();

export const updateBriefPreferencesInputSchema = briefPreferencesSchema.partial({
  cadence: true,
  retentionDays: true,
  doneRetentionHours: true,
  staleAfterDays: true,
  maxUnpinnedCards: true,
  scope: true,
}).required({
  companyId: true,
  userId: true,
});

export const briefCursorEventSchema = z.object({
  id: z.string().min(1),
  eventAt: z.string().min(1),
  fingerprint: z.string().min(1).optional(),
}).strict();

export type BriefCardState = z.infer<typeof briefCardStateSchema>;
export type BriefSummaryStatus = z.infer<typeof briefSummaryStatusSchema>;
export type BriefSummaryFailureReason = z.infer<typeof briefSummaryFailureReasonSchema>;
export type BriefSourceKind = z.infer<typeof briefSourceKindSchema>;
export type BriefTaskRow = z.infer<typeof briefTaskRowSchema>;
export type BriefCardSource = z.infer<typeof briefCardSourceSchema>;
export type BriefSnapshot = z.infer<typeof briefSnapshotSchema>;
export type BriefCard = z.infer<typeof briefCardSchema>;
export type BriefPreferences = z.infer<typeof briefPreferencesSchema>;
export type ListBriefCardsInput = z.infer<typeof listBriefCardsInputSchema>;
export type PinBriefCardInput = z.infer<typeof pinBriefCardInputSchema>;
export type DismissBriefCardInput = z.infer<typeof dismissBriefCardInputSchema>;
export type UpdateBriefPreferencesInput = z.infer<typeof updateBriefPreferencesInputSchema>;
export type BriefCursorEvent = z.infer<typeof briefCursorEventSchema>;
