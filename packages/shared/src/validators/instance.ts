import { z } from "zod";
import { DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE } from "../types/feedback.js";
import {
  DAILY_RETENTION_PRESETS,
  WEEKLY_RETENTION_PRESETS,
  MONTHLY_RETENTION_PRESETS,
  DEFAULT_BACKUP_RETENTION,
} from "../types/instance.js";
import { feedbackDataSharingPreferenceSchema } from "./feedback.js";
import { shapeWithoutDefaults } from "./partial.js";

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
  // Execution policy. Absent/"any" = unrestricted; "kubernetes" forces the
  // Kubernetes sandbox provider and denies local/ssh execution (cloud_tenant).
  executionMode: z.enum(["kubernetes", "any"]).optional(),
}).strict();

export const patchInstanceGeneralSettingsSchema = z
  .object(shapeWithoutDefaults(instanceGeneralSettingsSchema.shape))
  .partial()
  .strict();

export const instanceExperimentalSettingsSchema = z.object({
  enableEnvironments: z.boolean().default(false),
  enableNativeRunner: z.boolean().default(false),
  enableManagedSandboxOnly: z.boolean().default(false),
  enableIsolatedWorkspaces: z.boolean().default(false),
  enableStreamlinedLeftNavigation: z.boolean().default(true),
  enableStreamlinedUi: z.boolean().default(true),
  // Deprecated compatibility key. Apps is a standard product surface and is
  // always enabled; this remains accepted so older stored rows and managed
  // configs continue to load during upgrades.
  enableApps: z.boolean().default(true),
  enablePipelines: z.boolean().default(false),
  enableCases: z.boolean().default(false),
  enableConferenceRoomChat: z.boolean().default(false),
  enableClassicTaskInterface: z.boolean().default(false),
  enableIssuePlanDecompositions: z.boolean().default(false),
  enableExperimentalFileViewer: z.boolean().default(false),
  enableExternalObjects: z.boolean().default(false),
  enableSmokeLab: z.boolean().default(false),
  enableBuiltInAgents: z.boolean().default(false),
  enableBetaSkills: z.boolean().default(false),
  enableSummaries: z.boolean().default(false),
  enableStatusCards: z.boolean().default(false),
  enableDecisions: z.boolean().default(false),
  enableGoalsSidebarLink: z.boolean().default(false),
  enableServerInfoDebugView: z.boolean().default(false),
  enablePaperclipDeveloperMode: z.boolean().default(false),
  enableSimplifiedEnglishInteractions: z.boolean().default(false),
  autoRestartDevServerWhenIdle: z.boolean().default(false),
  enableWorkspaceBranchReconcileForward: z.boolean().default(true),
  enableWorkspaceDirtyQuarantineRepair: z.boolean().default(true),
  enableOwnerInstanceAdmin: z.boolean().default(false),
  // Kill switch for the sandbox duplex command-stream bridge. Default off. When
  // off the host keeps the file bridge for every run with no manifest change and
  // no redeploy. The host reads this per run before it selects the transport.
  enableSandboxDuplexBridge: z.boolean().default(false),
  // Deprecated compatibility key. Runner ingress follows enableNativeRunner;
  // this remains accepted so older stored rows and managed configs keep loading.
  enableRunnerPreviewIngress: z.boolean().default(false),
  enableWorktreeRunExecution: z.boolean().default(false),
  worktreeRunExecutionActivatedAt: z.string().datetime().nullable().default(null),
  worktreeRunExecutionActivationInstanceId: z.string().min(1).nullable().default(null),
}).strict();

export const patchInstanceExperimentalSettingsSchema = z
  .object(
    shapeWithoutDefaults(
      instanceExperimentalSettingsSchema
        .omit({
          worktreeRunExecutionActivatedAt: true,
          worktreeRunExecutionActivationInstanceId: true,
        })
        .shape,
    ),
  )
  .partial()
  .strip();

export const managedSettingMetadataSchema = z.object({
  managed: z.literal(true),
  managedBy: z.literal("paperclip-cloud"),
}).strict();

// Response shape of the experimental settings endpoints: on cloud-managed
// instances every overlaid key is listed in `managedKeys`; self-hosted
// responses omit the field entirely.
export const instanceExperimentalSettingsWithManagedSchema = instanceExperimentalSettingsSchema.extend({
  managedKeys: z.record(z.string(), managedSettingMetadataSchema).optional(),
}).strict();

export const patchInstanceSettingsSchema = z.object({
  defaultEnvironmentId: z.string().guid().nullable().optional(),
}).strict();

// The longest time a task drain can run before it expires on its own. A
// caller can send a shorter `ttlMs`, but not a longer one — the request must
// fail instead of the server silently clamping the value.
export const MAX_TASK_DRAIN_TTL_MS = 24 * 60 * 60 * 1000;

export const startTaskDrainRequestSchema = z.object({
  ttlMs: z.number().int().positive().max(MAX_TASK_DRAIN_TTL_MS).nullable().optional(),
}).strict();

export type InstanceGeneralSettings = z.infer<typeof instanceGeneralSettingsSchema>;
// The patch schema removes each default so an absent key stays absent. Declare
// the type from the full settings type, so every field keeps its precise type.
export type PatchInstanceGeneralSettings = Partial<InstanceGeneralSettings>;
export type InstanceExperimentalSettings = z.infer<typeof instanceExperimentalSettingsSchema>;
export type PatchInstanceExperimentalSettings = Partial<
  Omit<
    InstanceExperimentalSettings,
    "worktreeRunExecutionActivatedAt" | "worktreeRunExecutionActivationInstanceId"
  >
>;
export type PatchInstanceSettings = z.infer<typeof patchInstanceSettingsSchema>;
export type StartTaskDrainRequest = z.infer<typeof startTaskDrainRequestSchema>;

export const instanceSettingsSchema = z.object({
  id: z.string().guid(),
  defaultEnvironmentId: z.string().guid().nullable(),
  general: instanceGeneralSettingsSchema,
  experimental: instanceExperimentalSettingsWithManagedSchema,
  createdAt: z.union([z.date(), z.string().datetime()]),
  updatedAt: z.union([z.date(), z.string().datetime()]),
}).strict();
