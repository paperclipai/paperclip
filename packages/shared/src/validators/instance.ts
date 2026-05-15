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

// At least 2 chars (letter + one more) to avoid single-char IDs that collide
// with cgroup interface name prefixes (cpu, pids, memory, etc.).
const PLUGIN_ID_REGEX = /^[a-z][a-z0-9._-]+$/;
const MIN_MEMORY_HIGH_BYTES = 33554432;   // 32MB
const MIN_MEMORY_MAX_BYTES = 67108864;    // 64MB
const MIN_CPU_WEIGHT = 1;
const MAX_CPU_WEIGHT = 10000;
const MIN_PIDS_MAX = 32;
const MAX_PIDS_MAX = 65536;

export const pluginCgroupLimitsSchema = z.object({
  memoryHighBytes: z.number().int().min(MIN_MEMORY_HIGH_BYTES).optional(),
  memoryMaxBytes: z.number().int().min(MIN_MEMORY_MAX_BYTES).optional(),
  cpuWeight: z.number().int().min(MIN_CPU_WEIGHT).max(MAX_CPU_WEIGHT).optional(),
  pidsMax: z.number().int().min(MIN_PIDS_MAX).max(MAX_PIDS_MAX).optional(),
}).strict().refine(
  (v) => {
    if (v.memoryHighBytes !== undefined && v.memoryMaxBytes !== undefined) {
      return v.memoryMaxBytes >= v.memoryHighBytes;
    }
    return true;
  },
  { message: "memoryMaxBytes must be >= memoryHighBytes when both are set" },
);

export const instanceExperimentalSettingsSchema = z.object({
  enableEnvironments: z.boolean().default(false),
  enableIsolatedWorkspaces: z.boolean().default(false),
  autoRestartDevServerWhenIdle: z.boolean().default(false),
  enableIssueGraphLivenessAutoRecovery: z.boolean().default(false),
  issueGraphLivenessAutoRecoveryLookbackHours: z
    .number()
    .int()
    .min(MIN_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS)
    .max(MAX_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS)
    .default(DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS),
  pluginCgroupDefaults: pluginCgroupLimitsSchema.default({}),
  pluginCgroupOverrides: z.record(
    z.string().regex(PLUGIN_ID_REGEX, "Plugin ID must match ^[a-z][a-z0-9._-]+$"),
    pluginCgroupLimitsSchema,
  ).default({}),
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

export type InstanceGeneralSettings = z.infer<typeof instanceGeneralSettingsSchema>;
export type PatchInstanceGeneralSettings = z.infer<typeof patchInstanceGeneralSettingsSchema>;
export type InstanceExperimentalSettings = z.infer<typeof instanceExperimentalSettingsSchema>;
export type PatchInstanceExperimentalSettings = z.infer<typeof patchInstanceExperimentalSettingsSchema>;
export type IssueGraphLivenessAutoRecoveryRequest = z.infer<
  typeof issueGraphLivenessAutoRecoveryRequestSchema
>;
