import { z } from "zod";
import { companySearchQuerySchema } from "./search.js";

export const STATUS_CARD_AGENT_MAX_CARDS = 20;
export const STATUS_CARD_AGENT_MAX_INTEREST_PROMPT_LENGTH = 4_000;

function isValidTimeZone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

export const statusCardInstructionsModeSchema = z.enum(["none", "append", "replace"]);
export const statusCardStateSchema = z.enum(["compiling", "active", "error", "paused_budget", "paused_hours"]);
export const statusCardUpdateKindSchema = z.enum(["compile", "full", "incremental"]);
export const statusCardUpdateTriggerSchema = z.enum(["manual", "interval", "reactive", "restore"]);
export const statusCardUpdateStatusSchema = z.enum(["ok", "failed"]);

export const statusCardRefreshTriggersSchema = z.object({
  statusTransitions: z.boolean().default(true),
  membershipChanges: z.boolean().default(true),
  humanComments: z.boolean().default(true),
  assigneeChanges: z.boolean().default(true),
  anyUpdate: z.boolean().default(false),
});

export const statusCardRefreshPolicySchema = z
  .object({
    mode: z.enum(["manual", "interval", "reactive"]).default("manual"),
    intervalMinutes: z.number().int().positive().optional(),
    debounceSeconds: z.number().int().positive().optional(),
    maxUpdatesPerHour: z.number().int().positive().optional(),
    triggers: statusCardRefreshTriggersSchema.default({}),
    activeHours: z
      .object({
        start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        timezone: z.string().trim().min(1).refine(isValidTimeZone, { message: "Invalid timezone identifier" }),
      })
      .optional(),
    dailyTokenCap: z.number().int().positive().optional(),
  })
  .superRefine((policy, ctx) => {
    if (policy.mode === "interval" && policy.intervalMinutes === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["intervalMinutes"], message: "Required for interval mode" });
    }
    if (policy.mode === "reactive" && policy.debounceSeconds === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["debounceSeconds"], message: "Required for reactive mode" });
    }
  });

export const defaultStatusCardRefreshPolicy = statusCardRefreshPolicySchema.parse({ mode: "manual" });

export const statusCardFingerprintSchema = z.record(
  z.string(),
  z.object({
    status: z.string(),
    updatedAt: z.string().datetime(),
    latestHumanCommentAt: z.string().datetime().nullable().optional(),
    identifier: z.string().nullable().optional(),
    title: z.string().optional(),
    assigneeAgentId: z.string().uuid().nullable().optional(),
    assigneeUserId: z.string().nullable().optional(),
  }),
);

export const statusCardSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  createdByUserId: z.string().nullable(),
  createdByAgentId: z.string().uuid().nullable(),
  title: z.string().nullable(),
  titlePinned: z.boolean(),
  interestPrompt: z.string(),
  queries: z.array(companySearchQuerySchema),
  queryVersion: z.number().int().nonnegative(),
  queryCompiledAt: z.string().datetime().nullable(),
  queryCompiledByAgentId: z.string().uuid().nullable(),
  instructionsMode: statusCardInstructionsModeSchema,
  instructions: z.string().nullable(),
  refreshPolicy: statusCardRefreshPolicySchema,
  state: statusCardStateSchema,
  pendingChangeCount: z.number().int().nonnegative(),
  lastChangeAt: z.string().datetime().nullable(),
  fingerprint: statusCardFingerprintSchema.nullable(),
  fingerprintAt: z.string().datetime().nullable(),
  documentId: z.string().uuid().nullable(),
  lastUpdateRunKind: z.enum(["full", "incremental"]).nullable(),
  lastGeneratedAt: z.string().datetime().nullable(),
  lastModel: z.string().nullable(),
  generatingIssueId: z.string().uuid().nullable(),
  failureReason: z.string().nullable(),
  nextEvalAt: z.string().datetime().nullable(),
  archivedAt: z.string().datetime().nullable(),
  archivedByUserId: z.string().nullable(),
  archivedByAgentId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  summaryBody: z.string().nullable().optional(),
  watchedIssueCount: z.number().int().nonnegative().optional(),
  todayTokens: z.number().int().nonnegative().optional(),
  todayCostCents: z.number().int().nonnegative().optional(),
});

export const statusCardUpdateChangeSchema = z.object({
  issueId: z.string().uuid(),
  identifier: z.string(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  changeKind: z.string(),
});

export const statusCardUpdateSchema = z.object({
  id: z.string().uuid(),
  cardId: z.string().uuid(),
  kind: statusCardUpdateKindSchema,
  trigger: statusCardUpdateTriggerSchema,
  generationIssueId: z.string().uuid().nullable(),
  runId: z.string().uuid().nullable(),
  changes: z.array(statusCardUpdateChangeSchema),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costCents: z.number().int().nonnegative(),
  model: z.string().nullable(),
  queryVersion: z.number().int().nonnegative().nullable(),
  changeSummary: z.string().nullable(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  status: statusCardUpdateStatusSchema,
  error: z.string().nullable(),
});

export const listStatusCardsQuerySchema = z.object({
  archived: z.preprocess(
    (value) => (value === "true" ? true : value === "false" ? false : value),
    z.boolean().default(false),
  ),
});

export const createStatusCardSchema = z.object({
  interestPrompt: z.string().trim().min(1).max(20_000),
  title: z.string().trim().min(1).max(300).optional(),
  titlePinned: z.boolean().default(false),
  instructionsMode: statusCardInstructionsModeSchema.default("none"),
  instructions: z.string().max(50_000).nullable().optional(),
  refreshPolicy: statusCardRefreshPolicySchema.default(defaultStatusCardRefreshPolicy),
});

export const patchStatusCardSchema = z
  .object({
    interestPrompt: z.string().trim().min(1).max(20_000).optional(),
    title: z.string().trim().min(1).max(300).nullable().optional(),
    titlePinned: z.boolean().optional(),
    instructionsMode: statusCardInstructionsModeSchema.optional(),
    instructions: z.string().max(50_000).nullable().optional(),
    refreshPolicy: statusCardRefreshPolicySchema.optional(),
    archived: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const refreshStatusCardSchema = z.object({
  full: z.boolean().default(false),
});

export const writeStatusCardQuerySchema = z.object({
  queries: z.array(companySearchQuerySchema).min(1).max(10),
  title: z.string().trim().min(1).max(300),
  changeSummary: z.string().trim().min(1).max(2_000),
  generationIssueId: z.string().uuid(),
});

export const writeStatusCardSummarySchema = z.object({
  markdown: z.string().trim().min(1).max(200_000),
  title: z.string().trim().min(1).max(300).optional(),
  changeSummary: z.string().trim().min(1).max(2_000),
  generationIssueId: z.string().uuid(),
  model: z.string().trim().min(1).max(200).optional().nullable(),
});

export type StatusCard = z.infer<typeof statusCardSchema>;
export type StatusCardRefreshPolicy = z.infer<typeof statusCardRefreshPolicySchema>;
export type StatusCardUpdate = z.infer<typeof statusCardUpdateSchema>;
export type CreateStatusCard = z.infer<typeof createStatusCardSchema>;
export type PatchStatusCard = z.infer<typeof patchStatusCardSchema>;
export type RefreshStatusCard = z.infer<typeof refreshStatusCardSchema>;
export type WriteStatusCardQuery = z.infer<typeof writeStatusCardQuerySchema>;
export type WriteStatusCardSummary = z.infer<typeof writeStatusCardSummarySchema>;
