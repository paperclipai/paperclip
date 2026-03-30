import { z } from "zod";

export const instanceGeneralSettingsSchema = z.object({
  censorUsernameInLogs: z.boolean().default(false),
}).strict();

export const patchInstanceGeneralSettingsSchema = instanceGeneralSettingsSchema.partial();

export const instanceExperimentalSettingsSchema = z.object({
  enableIsolatedWorkspaces: z.boolean().default(false),
  autoRestartDevServerWhenIdle: z.boolean().default(false),
  staleIssueMonitorEnabled: z.boolean().default(false),
  staleIssueIdleHoursCritical: z.number().int().min(1).max(8760).default(24),
  staleIssueIdleHoursHigh: z.number().int().min(1).max(8760).default(48),
  staleIssueIdleHoursMedium: z.number().int().min(1).max(8760).default(72),
  staleIssueIdleHoursLow: z.number().int().min(1).max(8760).default(168),
}).strict();

export const patchInstanceExperimentalSettingsSchema = instanceExperimentalSettingsSchema.partial();

export type InstanceGeneralSettings = z.infer<typeof instanceGeneralSettingsSchema>;
export type PatchInstanceGeneralSettings = z.infer<typeof patchInstanceGeneralSettingsSchema>;
export type InstanceExperimentalSettings = z.infer<typeof instanceExperimentalSettingsSchema>;
export type PatchInstanceExperimentalSettings = z.infer<typeof patchInstanceExperimentalSettingsSchema>;
