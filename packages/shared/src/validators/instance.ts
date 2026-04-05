import { z } from "zod";
import { DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE } from "../types/feedback.js";
import { feedbackDataSharingPreferenceSchema } from "./feedback.js";

export const instanceGeneralSettingsSchema = z.object({
  censorUsernameInLogs: z.boolean().default(false),
  keyboardShortcuts: z.boolean().default(false),
  feedbackDataSharingPreference: feedbackDataSharingPreferenceSchema.default(
    DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE,
  ),
}).strict();

export const patchInstanceGeneralSettingsSchema = instanceGeneralSettingsSchema.partial();

export const crashMonitoringSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  monitoringAgentId: z.string().uuid().nullable().default(null),
  failureThreshold: z.number().int().min(1).max(100).default(3),
  timeWindowMs: z.number().int().min(60_000).max(86_400_000).default(3_600_000),
  cooldownMs: z.number().int().min(60_000).max(86_400_000).default(300_000),
}).strict();

export type CrashMonitoringSettings = z.infer<typeof crashMonitoringSettingsSchema>;

export const instanceExperimentalSettingsSchema = z.object({
  enableIsolatedWorkspaces: z.boolean().default(false),
  autoRestartDevServerWhenIdle: z.boolean().default(false),
  enforceBlockedOnValidation: z.boolean().default(false),
  autoLabelRulesEngine: z.boolean().default(false),
  enableWorkflows: z.boolean().default(true),
  enableIssueDocuments: z.boolean().default(true),
  enableWorkProductReconciliation: z.boolean().default(true),
  crashMonitoring: crashMonitoringSettingsSchema.default({}),
}).strict();

export const patchInstanceExperimentalSettingsSchema = instanceExperimentalSettingsSchema.partial();

export type InstanceGeneralSettings = z.infer<typeof instanceGeneralSettingsSchema>;
export type PatchInstanceGeneralSettings = z.infer<typeof patchInstanceGeneralSettingsSchema>;
export type InstanceExperimentalSettings = z.infer<typeof instanceExperimentalSettingsSchema>;
export type PatchInstanceExperimentalSettings = z.infer<typeof patchInstanceExperimentalSettingsSchema>;
