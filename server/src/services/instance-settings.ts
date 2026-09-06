import type { Db } from "@paperclipai/db";
import { companies, instanceSettings } from "@paperclipai/db";

/**
 * A `Db` or an open transaction handle — the subset of query builders the
 * settings writes use. Lets `update` run inside a caller's transaction so
 * it commits atomically with a sibling write.
 */
type InstanceSettingsTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type InstanceSettingsWriteDb = Pick<
  Db | InstanceSettingsTransaction,
  "select" | "insert" | "update"
>;
import {
  DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE,
  DEFAULT_BACKUP_RETENTION,
  PAPERCLIP_CLOUD_MANAGED_BY,
  instanceGeneralSettingsSchema,
  type InstanceGeneralSettings,
  instanceExperimentalSettingsSchema,
  type InstanceExperimentalSettings,
  type InstanceExperimentalSettingsWithManaged,
  type ManagedExperimentalFeatureKey,
  type ManagedSettingMetadata,
  type PatchInstanceGeneralSettings,
  type InstanceSettings,
  type PatchInstanceSettings,
  type PatchInstanceExperimentalSettings,
} from "@paperclipai/shared";
import { applyOperatorGeneralDefaults, stripOperatorGeneralEchoes } from "@paperclipai/shared";
import { eq } from "drizzle-orm";
import { getManagedInstanceConfig, type ManagedInstanceConfig } from "./managed-config.js";
import { getOperatorSettingDefaults } from "./setting-defaults.js";

const DEFAULT_SINGLETON_KEY = "default";
const instanceGeneralSettingsStorageSchema = instanceGeneralSettingsSchema.strip();
const instanceExperimentalSettingsStorageSchema = instanceExperimentalSettingsSchema.strip();
const TRUTHY_RUNTIME_ENV_VALUES = new Set(["1", "true", "yes", "on"]);

interface InstanceSettingsServiceOptions {
  runtimeEnv?: Record<string, string | undefined>;
  now?: () => Date;
}

type WorktreeRunExecutionSuppressedReason =
  | "not_worktree_runtime"
  | "flag_disabled"
  | "missing_cutoff"
  | "missing_instance_id"
  | "instance_id_mismatch"
  | "settings_read_error";

export type WorktreeRunExecutionActivationState =
  | {
      armed: true;
      cutoff: string;
      activationInstanceId: string;
      reason: null;
    }
  | {
      armed: false;
      cutoff: null;
      activationInstanceId: string | null;
      reason: WorktreeRunExecutionSuppressedReason;
    };

export function isTruthyRuntimeEnvValue(value: string | undefined) {
  return typeof value === "string" && TRUTHY_RUNTIME_ENV_VALUES.has(value.trim().toLowerCase());
}

function getRuntimeInstanceId(env: Record<string, string | undefined>) {
  const instanceId = env.PAPERCLIP_INSTANCE_ID?.trim();
  return instanceId ? instanceId : null;
}

function stripServerManagedExperimentalPatchFields(
  patch: PatchInstanceExperimentalSettings | Record<string, unknown>,
): PatchInstanceExperimentalSettings {
  const {
    worktreeRunExecutionActivatedAt: _ignoredActivatedAt,
    worktreeRunExecutionActivationInstanceId: _ignoredActivationInstanceId,
    ...patchable
  } = patch as Record<string, unknown>;
  return patchable as PatchInstanceExperimentalSettings;
}

export function applyExperimentalSettingsPatch(
  current: unknown,
  patch: PatchInstanceExperimentalSettings | Record<string, unknown>,
  options: InstanceSettingsServiceOptions = {},
): InstanceExperimentalSettings {
  const previousExperimental = normalizeExperimentalSettings(current);
  const patchable = stripServerManagedExperimentalPatchFields(patch);
  const nextExperimental = normalizeExperimentalSettings({
    ...previousExperimental,
    ...patchable,
  });
  const hasWorktreeRunExecutionPatch = Object.prototype.hasOwnProperty.call(
    patchable,
    "enableWorktreeRunExecution",
  );

  if (!hasWorktreeRunExecutionPatch) {
    return nextExperimental;
  }

  if (nextExperimental.enableWorktreeRunExecution !== true) {
    return {
      ...nextExperimental,
      worktreeRunExecutionActivatedAt: null,
      worktreeRunExecutionActivationInstanceId: null,
    };
  }

  if (previousExperimental.enableWorktreeRunExecution === true) {
    return nextExperimental;
  }

  const runtimeEnv = options.runtimeEnv ?? process.env;
  if (!isTruthyRuntimeEnvValue(runtimeEnv.PAPERCLIP_IN_WORKTREE)) {
    return nextExperimental;
  }

  return {
    ...nextExperimental,
    worktreeRunExecutionActivatedAt: (options.now ?? (() => new Date()))().toISOString(),
    worktreeRunExecutionActivationInstanceId: getRuntimeInstanceId(runtimeEnv),
  };
}

function suppressWorktreeRunExecution(
  reason: WorktreeRunExecutionSuppressedReason,
  activationInstanceId: string | null = null,
): WorktreeRunExecutionActivationState {
  return {
    armed: false,
    cutoff: null,
    activationInstanceId,
    reason,
  };
}

export function resolveWorktreeRunExecutionActivation(
  experimental: InstanceExperimentalSettings,
  currentInstanceId: string | null | undefined,
): WorktreeRunExecutionActivationState {
  if (experimental.enableWorktreeRunExecution !== true) {
    return suppressWorktreeRunExecution(
      "flag_disabled",
      experimental.worktreeRunExecutionActivationInstanceId,
    );
  }
  if (!experimental.worktreeRunExecutionActivatedAt) {
    return suppressWorktreeRunExecution(
      "missing_cutoff",
      experimental.worktreeRunExecutionActivationInstanceId,
    );
  }
  if (!currentInstanceId) {
    return suppressWorktreeRunExecution(
      "missing_instance_id",
      experimental.worktreeRunExecutionActivationInstanceId,
    );
  }
  if (experimental.worktreeRunExecutionActivationInstanceId !== currentInstanceId) {
    return suppressWorktreeRunExecution(
      "instance_id_mismatch",
      experimental.worktreeRunExecutionActivationInstanceId,
    );
  }
  return {
    armed: true,
    cutoff: experimental.worktreeRunExecutionActivatedAt,
    activationInstanceId: currentInstanceId,
    reason: null,
  };
}

export async function resolveWorktreeRunExecutionActivationState(options: {
  getExperimental: () => Promise<InstanceExperimentalSettings>;
  runtimeEnv?: Record<string, string | undefined>;
}): Promise<WorktreeRunExecutionActivationState> {
  const runtimeEnv = options.runtimeEnv ?? process.env;
  if (!isTruthyRuntimeEnvValue(runtimeEnv.PAPERCLIP_IN_WORKTREE)) {
    return suppressWorktreeRunExecution("not_worktree_runtime");
  }
  try {
    return resolveWorktreeRunExecutionActivation(
      await options.getExperimental(),
      getRuntimeInstanceId(runtimeEnv),
    );
  } catch {
    return suppressWorktreeRunExecution("settings_read_error");
  }
}

function normalizeGeneralSettings(raw: unknown): InstanceGeneralSettings {
  const parsed = instanceGeneralSettingsStorageSchema.safeParse(raw ?? {});
  if (parsed.success) {
    return {
      censorUsernameInLogs: parsed.data.censorUsernameInLogs ?? false,
      keyboardShortcuts: parsed.data.keyboardShortcuts ?? false,
      feedbackDataSharingPreference:
        parsed.data.feedbackDataSharingPreference ?? DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE,
      backupRetention: parsed.data.backupRetention ?? DEFAULT_BACKUP_RETENTION,
      // Absent => unrestricted; only carry through an explicit policy.
      ...(parsed.data.executionMode ? { executionMode: parsed.data.executionMode } : {}),
    };
  }
  return {
    censorUsernameInLogs: false,
    keyboardShortcuts: false,
    feedbackDataSharingPreference: DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE,
    backupRetention: DEFAULT_BACKUP_RETENTION,
  };
}

export function normalizeExperimentalSettings(raw: unknown): InstanceExperimentalSettings {
  const parsed = instanceExperimentalSettingsStorageSchema.safeParse(raw ?? {});
  if (parsed.success) {
    return {
      enableEnvironments: parsed.data.enableEnvironments ?? false,
      enableNativeRunner: parsed.data.enableNativeRunner ?? false,
      enableManagedSandboxOnly: parsed.data.enableManagedSandboxOnly ?? false,
      enableIsolatedWorkspaces: parsed.data.enableIsolatedWorkspaces ?? false,
      enableStreamlinedLeftNavigation: parsed.data.enableStreamlinedLeftNavigation ?? true,
      enableStreamlinedUi: parsed.data.enableStreamlinedUi ?? true,
      // Apps graduated from Experimental. Ignore historical off values while
      // continuing to accept the compatibility key in stored settings.
      enableApps: true,
      enablePipelines: parsed.data.enablePipelines ?? false,
      enableCases: parsed.data.enableCases ?? false,
      enableConferenceRoomChat: parsed.data.enableConferenceRoomChat ?? false,
      enableClassicTaskInterface: parsed.data.enableClassicTaskInterface ?? false,
      enableIssuePlanDecompositions: parsed.data.enableIssuePlanDecompositions ?? false,
      enableExperimentalFileViewer: parsed.data.enableExperimentalFileViewer ?? false,
      enableExternalObjects: parsed.data.enableExternalObjects ?? false,
      enableSmokeLab: parsed.data.enableSmokeLab ?? false,
      enableBuiltInAgents: parsed.data.enableBuiltInAgents ?? false,
      enableBetaSkills: parsed.data.enableBetaSkills ?? false,
      enableSummaries: parsed.data.enableSummaries ?? false,
      enableStatusCards: parsed.data.enableStatusCards ?? false,
      enableDecisions: parsed.data.enableDecisions ?? false,
      enableGoalsSidebarLink: parsed.data.enableGoalsSidebarLink ?? false,
      enableServerInfoDebugView: parsed.data.enableServerInfoDebugView ?? false,
      enablePaperclipDeveloperMode: parsed.data.enablePaperclipDeveloperMode ?? false,
      enableSimplifiedEnglishInteractions: parsed.data.enableSimplifiedEnglishInteractions ?? false,
      autoRestartDevServerWhenIdle: parsed.data.autoRestartDevServerWhenIdle ?? false,
      enableWorkspaceBranchReconcileForward: parsed.data.enableWorkspaceBranchReconcileForward ?? true,
      enableWorkspaceDirtyQuarantineRepair: parsed.data.enableWorkspaceDirtyQuarantineRepair ?? true,
      enableOwnerInstanceAdmin: parsed.data.enableOwnerInstanceAdmin ?? false,
      enableSandboxDuplexBridge: parsed.data.enableSandboxDuplexBridge ?? false,
      enableRunnerPreviewIngress: parsed.data.enableRunnerPreviewIngress ?? false,
      enableWorktreeRunExecution: parsed.data.enableWorktreeRunExecution ?? false,
      worktreeRunExecutionActivatedAt: parsed.data.worktreeRunExecutionActivatedAt ?? null,
      worktreeRunExecutionActivationInstanceId:
        parsed.data.worktreeRunExecutionActivationInstanceId ?? null,
    };
  }
  return {
    enableEnvironments: false,
    enableNativeRunner: false,
    enableManagedSandboxOnly: false,
    enableIsolatedWorkspaces: false,
    enableStreamlinedLeftNavigation: true,
    enableStreamlinedUi: true,
    enableApps: true,
    enablePipelines: false,
    enableCases: false,
    enableConferenceRoomChat: false,
    enableClassicTaskInterface: false,
    enableIssuePlanDecompositions: false,
    enableExperimentalFileViewer: false,
    enableExternalObjects: false,
    enableSmokeLab: false,
    enableBuiltInAgents: false,
    enableBetaSkills: false,
    enableSummaries: false,
    enableStatusCards: false,
    enableDecisions: false,
    enableGoalsSidebarLink: false,
    enableServerInfoDebugView: false,
    enablePaperclipDeveloperMode: false,
    enableSimplifiedEnglishInteractions: false,
    autoRestartDevServerWhenIdle: false,
    enableWorkspaceBranchReconcileForward: true,
    enableWorkspaceDirtyQuarantineRepair: true,
    enableOwnerInstanceAdmin: false,
    enableSandboxDuplexBridge: false,
    enableRunnerPreviewIngress: false,
    enableWorktreeRunExecution: false,
    worktreeRunExecutionActivatedAt: null,
    worktreeRunExecutionActivationInstanceId: null,
  };
}

export type ManagedExperimentalKeyMetadata = Partial<
  Record<ManagedExperimentalFeatureKey, ManagedSettingMetadata>
>;

/**
 * Overlay the cloud managed-config feature values over normalized settings.
 *
 * Read-time precedence: code floor (cloud) > managed overlay > tenant DB
 * value > schema default. (No code floors are expressed as flags today —
 * floors are enforced in code at the guarded routes, independent of any
 * flag value.) The overlay is deliberately never persisted: it re-asserts on
 * every read, so a DB restore or manual row edit cannot resurrect a
 * capability the harness has disabled.
 */
export function applyManagedExperimentalOverlay(
  experimental: InstanceExperimentalSettings,
  managedConfig: ManagedInstanceConfig | null,
): { experimental: InstanceExperimentalSettings; managedKeys: ManagedExperimentalKeyMetadata } {
  if (!managedConfig) return { experimental, managedKeys: {} };
  const next: InstanceExperimentalSettings = { ...experimental };
  const managedKeys: ManagedExperimentalKeyMetadata = {};
  for (const [key, value] of Object.entries(managedConfig.features) as Array<
    [ManagedExperimentalFeatureKey, boolean]
  >) {
    // Existing Cloud stack configs may still carry enableApps. Accept the
    // document during rollout, but never let the retired flag disable Apps.
    if (key === "enableApps") continue;
    next[key] = value;
    managedKeys[key] = { managed: true, managedBy: PAPERCLIP_CLOUD_MANAGED_BY };
  }
  return { experimental: next, managedKeys };
}

export function instanceSettingsService(db: Db, options: InstanceSettingsServiceOptions = {}) {
  // Fail closed: a malformed PAPERCLIP_MANAGED_CONFIG throws here (and at
  // boot in index.ts) rather than silently running without the overlay.
  const managedConfig = getManagedInstanceConfig(options.runtimeEnv ?? process.env);
  // Same posture for PAPERCLIP_SETTING_DEFAULTS: parsed once, applied per
  // read, never persisted (see applyOperatorGeneralDefaults) — including on
  // the write path, where a full-GET echo of the overlaid value is stripped
  // back to the schema default (see stripOperatorGeneralEchoes).
  const operatorDefaults = getOperatorSettingDefaults(options.runtimeEnv ?? process.env);

  function toGeneralView(raw: unknown): InstanceGeneralSettings {
    return applyOperatorGeneralDefaults(normalizeGeneralSettings(raw), operatorDefaults);
  }

  function toExperimentalView(raw: unknown): InstanceExperimentalSettingsWithManaged {
    const { experimental, managedKeys } = applyManagedExperimentalOverlay(
      normalizeExperimentalSettings(raw),
      managedConfig,
    );
    // Self-hosted responses stay byte-identical: no managedKeys field at all.
    return managedConfig ? { ...experimental, managedKeys } : experimental;
  }

  function toInstanceSettings(row: typeof instanceSettings.$inferSelect): InstanceSettings {
    return {
      id: row.id,
      defaultEnvironmentId: row.defaultEnvironmentId ?? null,
      general: toGeneralView(row.general),
      experimental: toExperimentalView(row.experimental),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } as InstanceSettings;
  }
  async function getOrCreateRow(runner: InstanceSettingsWriteDb = db) {
    const existing = await runner
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, DEFAULT_SINGLETON_KEY))
      .then((rows) => rows[0] ?? null);
    if (existing) return existing;

    const now = new Date();
    const [created] = await runner
      .insert(instanceSettings)
      .values({
        singletonKey: DEFAULT_SINGLETON_KEY,
        general: {},
        experimental: {},
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [instanceSettings.singletonKey],
        set: {
          updatedAt: now,
        },
      })
      .returning();

    if (created) return created;

    const raced = await runner
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, DEFAULT_SINGLETON_KEY))
      .then((rows) => rows[0] ?? null);
    if (raced) return raced;

    throw new Error("Failed to initialize instance settings row");
  }

  return {
    get: async (): Promise<InstanceSettings> => toInstanceSettings(await getOrCreateRow()),

    update: async (
      patch: PatchInstanceSettings,
      writeOptions?: { db?: InstanceSettingsWriteDb },
    ): Promise<InstanceSettings> => {
      // The write may run inside a caller-supplied transaction so it commits
      // atomically with a sibling write (e.g. clearing the managed-default
      // stamp on the environment row alongside a defaultEnvironmentId
      // change). Reads use the same runner so the row is visible to the tx.
      const runner = writeOptions?.db ?? db;
      const current = await getOrCreateRow(runner);
      const now = new Date();
      const [updated] = await runner
        .update(instanceSettings)
        .set({
          ...(Object.prototype.hasOwnProperty.call(patch, "defaultEnvironmentId")
            ? { defaultEnvironmentId: patch.defaultEnvironmentId ?? null }
            : {}),
          updatedAt: now,
        })
        .where(eq(instanceSettings.id, current.id))
        .returning();
      return toInstanceSettings(updated ?? current);
    },

    getGeneral: async (): Promise<InstanceGeneralSettings> => {
      const row = await getOrCreateRow();
      return toGeneralView(row.general);
    },

    getExperimental: async (): Promise<InstanceExperimentalSettingsWithManaged> => {
      const row = await getOrCreateRow();
      return toExperimentalView(row.experimental);
    },

    updateGeneral: async (patch: PatchInstanceGeneralSettings): Promise<InstanceSettings> => {
      const current = await getOrCreateRow();
      const storedGeneral = normalizeGeneralSettings(current.general);
      // A full-GET echo carries the overlaid operator value for a field the
      // user never chose; stripping it keeps the overlay strictly read-time,
      // so changing or unsetting the variable later still takes effect.
      const nextGeneral = stripOperatorGeneralEchoes(
        storedGeneral,
        normalizeGeneralSettings({ ...storedGeneral, ...patch }),
        operatorDefaults,
      );
      const now = new Date();
      const [updated] = await db
        .update(instanceSettings)
        .set({
          general: { ...nextGeneral },
          updatedAt: now,
        })
        .where(eq(instanceSettings.id, current.id))
        .returning();
      return toInstanceSettings(updated ?? current);
    },

    updateExperimental: async (patch: PatchInstanceExperimentalSettings): Promise<InstanceSettings> => {
      const current = await getOrCreateRow();
      const nextExperimental = applyExperimentalSettingsPatch(current.experimental, patch, options);
      const now = new Date();
      const [updated] = await db
        .update(instanceSettings)
        .set({
          experimental: { ...nextExperimental },
          updatedAt: now,
        })
        .where(eq(instanceSettings.id, current.id))
        .returning();
      return toInstanceSettings(updated ?? current);
    },

    listCompanyIds: async (): Promise<string[]> =>
      db
        .select({ id: companies.id })
        .from(companies)
        .then((rows) => rows.map((row) => row.id)),
  };
}
