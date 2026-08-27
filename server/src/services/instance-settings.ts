import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { companies, heartbeatRuns, instanceSettings } from "@paperclipai/db";

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
  DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
  PAPERCLIP_CLOUD_MANAGED_BY,
  WORKTREE_SEED_QUARANTINE_ERROR_CODE,
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
  type WorktreeRunExecutionSuppressedReason,
  type WorktreeRunExecutionActivationState,
  type WorktreeRunEngineStatus,
} from "@paperclipai/shared";
import { and, eq, sql } from "drizzle-orm";
import { getManagedInstanceConfig, type ManagedInstanceConfig } from "./managed-config.js";

const DEFAULT_SINGLETON_KEY = "default";
const instanceGeneralSettingsStorageSchema = instanceGeneralSettingsSchema.strip();
const instanceExperimentalSettingsStorageSchema = instanceExperimentalSettingsSchema.strip();
const TRUTHY_RUNTIME_ENV_VALUES = new Set(["1", "true", "yes", "on"]);

interface InstanceSettingsServiceOptions {
  runtimeEnv?: Record<string, string | undefined>;
  now?: () => Date;
  generateInstanceNonce?: () => string;
  generateSeedEpoch?: () => string;
}

export type {
  WorktreeRunExecutionSuppressedReason,
  WorktreeRunExecutionActivationState,
} from "@paperclipai/shared";

export function isTruthyRuntimeEnvValue(value: string | undefined) {
  return typeof value === "string" && TRUTHY_RUNTIME_ENV_VALUES.has(value.trim().toLowerCase());
}

function stripServerManagedExperimentalPatchFields(
  patch: PatchInstanceExperimentalSettings | Record<string, unknown>,
): PatchInstanceExperimentalSettings {
  const {
    worktreeRunExecutionInstanceNonce: _ignoredInstanceNonce,
    worktreeRunExecutionSeedEpoch: _ignoredSeedEpoch,
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
    worktreeRunExecutionActivationInstanceId: nextExperimental.worktreeRunExecutionInstanceNonce,
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
  if (!experimental.worktreeRunExecutionInstanceNonce) {
    return suppressWorktreeRunExecution(
      "missing_instance_id",
      experimental.worktreeRunExecutionActivationInstanceId,
    );
  }
  if (!experimental.worktreeRunExecutionSeedEpoch) {
    return suppressWorktreeRunExecution(
      "missing_seed_epoch",
      experimental.worktreeRunExecutionActivationInstanceId,
    );
  }
  if (
    experimental.worktreeRunExecutionActivationInstanceId !==
    experimental.worktreeRunExecutionInstanceNonce
  ) {
    return suppressWorktreeRunExecution(
      "instance_id_mismatch",
      experimental.worktreeRunExecutionActivationInstanceId,
    );
  }
  return {
    armed: true,
    cutoff: experimental.worktreeRunExecutionActivatedAt,
    activationInstanceId: experimental.worktreeRunExecutionInstanceNonce,
    instanceNonce: experimental.worktreeRunExecutionInstanceNonce,
    seedEpoch: experimental.worktreeRunExecutionSeedEpoch,
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
    return resolveWorktreeRunExecutionActivation(await options.getExperimental());
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
      enableApps: parsed.data.enableApps ?? false,
      enablePipelines: parsed.data.enablePipelines ?? false,
      enableCases: parsed.data.enableCases ?? false,
      enableConferenceRoomChat: parsed.data.enableConferenceRoomChat ?? false,
      enableClassicTaskInterface: parsed.data.enableClassicTaskInterface ?? false,
      enableIssuePlanDecompositions: parsed.data.enableIssuePlanDecompositions ?? false,
      enableExperimentalFileViewer: parsed.data.enableExperimentalFileViewer ?? false,
      enableTaskWatchdogs: parsed.data.enableTaskWatchdogs ?? false,
      enableExternalObjects: parsed.data.enableExternalObjects ?? false,
      enableSmokeLab: parsed.data.enableSmokeLab ?? false,
      enableBuiltInAgents: parsed.data.enableBuiltInAgents ?? false,
      enableBetaSkills: parsed.data.enableBetaSkills ?? false,
      enableSummaries: parsed.data.enableSummaries ?? false,
      enableStatusCards: parsed.data.enableStatusCards ?? false,
      enableDecisions: parsed.data.enableDecisions ?? false,
      enableGoalsSidebarLink: parsed.data.enableGoalsSidebarLink ?? false,
      enableServerInfoDebugView: parsed.data.enableServerInfoDebugView ?? false,
      enableSimplifiedEnglishInteractions: parsed.data.enableSimplifiedEnglishInteractions ?? false,
      autoRestartDevServerWhenIdle: parsed.data.autoRestartDevServerWhenIdle ?? false,
      enableIssueGraphLivenessAutoRecovery: parsed.data.enableIssueGraphLivenessAutoRecovery ?? false,
      enableWorkspaceBranchReconcileForward: parsed.data.enableWorkspaceBranchReconcileForward ?? true,
      enableWorkspaceDirtyQuarantineRepair: parsed.data.enableWorkspaceDirtyQuarantineRepair ?? true,
      enableOwnerInstanceAdmin: parsed.data.enableOwnerInstanceAdmin ?? false,
      enableSandboxDuplexBridge: parsed.data.enableSandboxDuplexBridge ?? false,
      enableWorktreeRunExecution: parsed.data.enableWorktreeRunExecution ?? false,
      worktreeRunExecutionInstanceNonce: parsed.data.worktreeRunExecutionInstanceNonce ?? null,
      worktreeRunExecutionSeedEpoch: parsed.data.worktreeRunExecutionSeedEpoch ?? null,
      worktreeRunExecutionActivatedAt: parsed.data.worktreeRunExecutionActivatedAt ?? null,
      worktreeRunExecutionActivationInstanceId:
        parsed.data.worktreeRunExecutionActivationInstanceId ?? null,
      issueGraphLivenessAutoRecoveryLookbackHours:
        parsed.data.issueGraphLivenessAutoRecoveryLookbackHours ??
        DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
    };
  }
  return {
    enableEnvironments: false,
    enableNativeRunner: false,
    enableManagedSandboxOnly: false,
    enableIsolatedWorkspaces: false,
    enableStreamlinedLeftNavigation: true,
    enableApps: false,
    enablePipelines: false,
    enableCases: false,
    enableConferenceRoomChat: false,
    enableClassicTaskInterface: false,
    enableTaskWatchdogs: false,
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
    enableSimplifiedEnglishInteractions: false,
    autoRestartDevServerWhenIdle: false,
    enableIssueGraphLivenessAutoRecovery: false,
    enableWorkspaceBranchReconcileForward: true,
    enableWorkspaceDirtyQuarantineRepair: true,
    enableOwnerInstanceAdmin: false,
    enableSandboxDuplexBridge: false,
    enableWorktreeRunExecution: false,
    worktreeRunExecutionInstanceNonce: null,
    worktreeRunExecutionSeedEpoch: null,
    worktreeRunExecutionActivatedAt: null,
    worktreeRunExecutionActivationInstanceId: null,
    issueGraphLivenessAutoRecoveryLookbackHours:
      DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
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
    next[key] = value;
    managedKeys[key] = { managed: true, managedBy: PAPERCLIP_CLOUD_MANAGED_BY };
  }
  return { experimental: next, managedKeys };
}

export function instanceSettingsService(db: Db, options: InstanceSettingsServiceOptions = {}) {
  const runtimeEnv = options.runtimeEnv ?? process.env;
  // Fail closed: a malformed PAPERCLIP_MANAGED_CONFIG throws here (and at
  // boot in index.ts) rather than silently running without the overlay.
  const managedConfig = getManagedInstanceConfig(runtimeEnv);

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
      general: normalizeGeneralSettings(row.general),
      experimental: toExperimentalView(row.experimental),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } as InstanceSettings;
  }
  async function ensureWorktreeInstanceNonce(
    row: typeof instanceSettings.$inferSelect,
    runner: InstanceSettingsWriteDb = db,
  ) {
    if (!isTruthyRuntimeEnvValue(runtimeEnv.PAPERCLIP_IN_WORKTREE)) return row;
    const normalized = normalizeExperimentalSettings(row.experimental);
    if (normalized.worktreeRunExecutionInstanceNonce && normalized.worktreeRunExecutionSeedEpoch) return row;

    const now = options.now?.() ?? new Date();
    const instanceNonce = (options.generateInstanceNonce ?? randomUUID)();
    const experimental = typeof row.experimental === "object" && row.experimental !== null
      ? row.experimental
      : {};
    const [updated] = await runner
      .update(instanceSettings)
      .set({
        experimental: {
          ...experimental,
          worktreeRunExecutionInstanceNonce:
            normalized.worktreeRunExecutionInstanceNonce ?? instanceNonce,
          worktreeRunExecutionSeedEpoch:
            normalized.worktreeRunExecutionSeedEpoch ?? (options.generateSeedEpoch ?? randomUUID)(),
        },
        updatedAt: now,
      })
      .where(and(
        eq(instanceSettings.id, row.id),
        sql`${instanceSettings.experimental} ->> 'worktreeRunExecutionInstanceNonce' is null
          or ${instanceSettings.experimental} ->> 'worktreeRunExecutionSeedEpoch' is null`,
      ))
      .returning();
    if (updated) return updated;

    return await runner
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.id, row.id))
      .then((rows) => rows[0] ?? row);
  }

  async function getOrCreateRow(runner: InstanceSettingsWriteDb = db) {
    const existing = await runner
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, DEFAULT_SINGLETON_KEY))
      .then((rows) => rows[0] ?? null);
    if (existing) return await ensureWorktreeInstanceNonce(existing, runner);

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

    if (created) return await ensureWorktreeInstanceNonce(created, runner);

    const raced = await runner
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, DEFAULT_SINGLETON_KEY))
      .then((rows) => rows[0] ?? null);
    if (raced) return await ensureWorktreeInstanceNonce(raced, runner);

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
      return normalizeGeneralSettings(row.general);
    },

    getExperimental: async (): Promise<InstanceExperimentalSettingsWithManaged> => {
      const row = await getOrCreateRow();
      return toExperimentalView(row.experimental);
    },

    updateGeneral: async (patch: PatchInstanceGeneralSettings): Promise<InstanceSettings> => {
      const current = await getOrCreateRow();
      const nextGeneral = normalizeGeneralSettings({
        ...normalizeGeneralSettings(current.general),
        ...patch,
      });
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

    getWorktreeRunEngineStatus: async (): Promise<WorktreeRunEngineStatus> => {
      const experimental = normalizeExperimentalSettings((await getOrCreateRow()).experimental);
      const inWorktree = isTruthyRuntimeEnvValue(runtimeEnv.PAPERCLIP_IN_WORKTREE);
      const activation = await resolveWorktreeRunExecutionActivationState({
        getExperimental: async () => experimental,
        runtimeEnv,
      });
      // Only quarantined-run rows survive a seed (P1 deletes the wakeups/monitors
      // it clears), so this count is the durable evidence of what was neutralized.
      let quarantinedRunCount = 0;
      if (inWorktree && experimental.worktreeRunExecutionSeedEpoch) {
        const [row] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.errorCode, WORKTREE_SEED_QUARANTINE_ERROR_CODE),
              eq(heartbeatRuns.seedEpoch, experimental.worktreeRunExecutionSeedEpoch),
            ),
          );
        quarantinedRunCount = row?.count ?? 0;
      }
      return {
        inWorktree,
        activation,
        instanceNonce: experimental.worktreeRunExecutionInstanceNonce,
        quarantinedRunCount,
      };
    },

    listCompanyIds: async (): Promise<string[]> =>
      db
        .select({ id: companies.id })
        .from(companies)
        .then((rows) => rows.map((row) => row.id)),
  };
}
