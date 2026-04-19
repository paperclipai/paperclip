import { z } from "zod";
import { DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE } from "../types/feedback.js";
import {
  DAILY_RETENTION_PRESETS,
  WEEKLY_RETENTION_PRESETS,
  MONTHLY_RETENTION_PRESETS,
  DEFAULT_BACKUP_RETENTION,
  DEFAULT_INSTANCE_UPDATE_SETTINGS,
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

export const instanceUpdateSettingsSchema = z.object({
  channel: z.literal("stable").default(DEFAULT_INSTANCE_UPDATE_SETTINGS.channel),
  updateChecksEnabled: z.boolean().default(DEFAULT_INSTANCE_UPDATE_SETTINGS.updateChecksEnabled),
  dismissedVersion: z.string().trim().min(1).nullable().default(DEFAULT_INSTANCE_UPDATE_SETTINGS.dismissedVersion),
  dismissedAt: z.string().trim().min(1).nullable().default(DEFAULT_INSTANCE_UPDATE_SETTINGS.dismissedAt),
}).strict();

export const instanceGeneralSettingsSchema = z.object({
  censorUsernameInLogs: z.boolean().default(false),
  keyboardShortcuts: z.boolean().default(false),
  feedbackDataSharingPreference: feedbackDataSharingPreferenceSchema.default(
    DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE,
  ),
  backupRetention: backupRetentionPolicySchema.default(DEFAULT_BACKUP_RETENTION),
  updateSettings: instanceUpdateSettingsSchema.default(DEFAULT_INSTANCE_UPDATE_SETTINGS),
}).strict();

export const patchInstanceGeneralSettingsSchema = instanceGeneralSettingsSchema.partial();

export const dismissInstanceUpdateSchema = z.object({
  version: z.string().trim().min(1).optional(),
}).strict();

export const createPreUpdateBackupSchema = z.object({
  targetVersion: z.string().trim().min(1).nullable().optional(),
  acknowledgeExternalStorage: z.boolean().optional(),
}).strict();

export const instanceExperimentalSettingsSchema = z.object({
  enableIsolatedWorkspaces: z.boolean().default(false),
  autoRestartDevServerWhenIdle: z.boolean().default(false),
}).strict();

export const patchInstanceExperimentalSettingsSchema = instanceExperimentalSettingsSchema.partial();

export type InstanceGeneralSettings = z.infer<typeof instanceGeneralSettingsSchema>;
export type PatchInstanceGeneralSettings = z.infer<typeof patchInstanceGeneralSettingsSchema>;
export type InstanceExperimentalSettings = z.infer<typeof instanceExperimentalSettingsSchema>;
export type PatchInstanceExperimentalSettings = z.infer<typeof patchInstanceExperimentalSettingsSchema>;
export type DismissInstanceUpdateInput = z.infer<typeof dismissInstanceUpdateSchema>;
export type CreatePreUpdateBackupInput = z.infer<typeof createPreUpdateBackupSchema>;
