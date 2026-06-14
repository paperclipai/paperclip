import { z } from "zod";
import { DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE } from "../types/feedback.js";
import {
  DAILY_RETENTION_PRESETS,
  WEEKLY_RETENTION_PRESETS,
  MONTHLY_RETENTION_PRESETS,
  DEFAULT_BACKUP_RETENTION,
  DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
  MAX_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
  MIN_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
  DEFAULT_GUARD_COMPANY_MONTHLY_TOKENS,
  DEFAULT_GUARD_AGENT_MONTHLY_TOKENS,
  DEFAULT_GUARD_WARN_PERCENT,
  DEFAULT_GUARD_MAX_TURNS_PER_RUN,
  DEFAULT_GUARD_MAX_TOKENS_PER_RUN,
  DEFAULT_GUARD_MAX_RUNS_PER_AGENT_PER_HOUR,
  DEFAULT_GUARD_MAX_CONSECUTIVE_SAME_ISSUE_RUNS,
} from "../types/instance.js";
import { feedbackDataSharingPreferenceSchema } from "./feedback.js";

function presetSchema<T extends readonly number[]>(presets: T, label: string) {
  return z.number().refine(
    (v): v is T[number] => (presets as readonly number[]).includes(v),
    { message: `${label} must be one of: ${presets.join(", ")}` },
  );
}

export const backupRetentionPolicySchema = z.object({
  dailyDays: presetSchema(DAILY_RETENTION_PRESETS, "dailyDays").default(DEFAULT_BACKUP_RETENTION.dailyDays),
  weeklyWeeks: presetSchema(WEEKLY_RETENTION_PRESETS, "weeklyWeeks").default(DEFAULT_BACKUP_RETENTION.weeklyWeeks),
  monthlyMonths: presetSchema(MONTHLY_RETENTION_PRESETS, "monthlyMonths").default(DEFAULT_BACKUP_RETENTION.monthlyMonths),
});

export const instanceGeneralSettingsSchema = z.object({
  censorUsernameInLogs: z.boolean().default(false),
  keyboardShortcuts: z.boolean().default(false),
  feedbackDataSharingPreference: feedbackDataSharingPreferenceSchema.default(
    DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE,
  ),
  backupRetention: backupRetentionPolicySchema.default(DEFAULT_BACKUP_RETENTION),
}).strict();

export const patchInstanceGeneralSettingsSchema = instanceGeneralSettingsSchema.partial();

export const instanceExperimentalSettingsSchema = z.object({
  enableEnvironments: z.boolean().default(false),
  enableIsolatedWorkspaces: z.boolean().default(false),
  enableStreamlinedLeftNavigation: z.boolean().default(false),
  enableIssuePlanDecompositions: z.boolean().default(false),
  enableCloudSync: z.boolean().default(false),
  autoRestartDevServerWhenIdle: z.boolean().default(false),
  enableIssueGraphLivenessAutoRecovery: z.boolean().default(false),
  issueGraphLivenessAutoRecoveryLookbackHours: z
    .number()
    .int()
    .min(MIN_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS)
    .max(MAX_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS)
    .default(DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS),
  soloMode: z.boolean().default(false),
  strictBoardTransitions: z.boolean().default(false),
}).strict();

export const patchInstanceExperimentalSettingsSchema = instanceExperimentalSettingsSchema.partial();

export const issueGraphLivenessAutoRecoveryRequestSchema = z.object({
  lookbackHours: z
    .number()
    .int()
    .min(MIN_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS)
    .max(MAX_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS)
    .optional(),
}).strict();

export const instanceGuardsBudgetConfigSchema = z.object({
  metric: z.literal("total_tokens").default("total_tokens"),
  windowKind: z.literal("calendar_month_utc").default("calendar_month_utc"),
  companyMonthlyTokens: z.number().int().nonnegative().default(DEFAULT_GUARD_COMPANY_MONTHLY_TOKENS),
  agentMonthlyTokens: z.number().int().nonnegative().default(DEFAULT_GUARD_AGENT_MONTHLY_TOKENS),
  warnPercent: z.number().int().min(0).max(100).default(DEFAULT_GUARD_WARN_PERCENT),
  hardStop: z.boolean().default(true),
});

export const instanceGuardsPerRunConfigSchema = z.object({
  maxTurnsPerRun: z.number().int().positive().default(DEFAULT_GUARD_MAX_TURNS_PER_RUN),
  maxTokensPerRun: z.number().int().positive().default(DEFAULT_GUARD_MAX_TOKENS_PER_RUN),
});

export const instanceGuardsBreakerConfigSchema = z.object({
  maxRunsPerAgentPerHour: z.number().int().positive().default(DEFAULT_GUARD_MAX_RUNS_PER_AGENT_PER_HOUR),
  maxConsecutiveSameIssueRuns: z.number().int().positive().default(DEFAULT_GUARD_MAX_CONSECUTIVE_SAME_ISSUE_RUNS),
});

export const instanceGuardsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  budget: instanceGuardsBudgetConfigSchema.default({}),
  perRun: instanceGuardsPerRunConfigSchema.default({}),
  breaker: instanceGuardsBreakerConfigSchema.default({}),
});

export const patchInstanceGuardsConfigSchema = z.object({
  enabled: z.boolean().optional(),
  budget: instanceGuardsBudgetConfigSchema.partial().optional(),
  perRun: instanceGuardsPerRunConfigSchema.partial().optional(),
  breaker: instanceGuardsBreakerConfigSchema.partial().optional(),
});

export type InstanceGeneralSettings = z.infer<typeof instanceGeneralSettingsSchema>;
export type PatchInstanceGeneralSettings = z.infer<typeof patchInstanceGeneralSettingsSchema>;
export type InstanceExperimentalSettings = z.infer<typeof instanceExperimentalSettingsSchema>;
export type PatchInstanceExperimentalSettings = z.infer<typeof patchInstanceExperimentalSettingsSchema>;
export type IssueGraphLivenessAutoRecoveryRequest = z.infer<
  typeof issueGraphLivenessAutoRecoveryRequestSchema
>;
export type InstanceGuardsConfig = z.infer<typeof instanceGuardsConfigSchema>;
export type PatchInstanceGuardsConfig = z.infer<typeof patchInstanceGuardsConfigSchema>;
