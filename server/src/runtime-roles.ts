export const RUNTIME_ROLES = ["primary", "api-only", "scheduler-only", "staged"] as const;

export type RuntimeRole = (typeof RUNTIME_ROLES)[number];

export type MigrationMode = "apply" | "refuse";

export type RuntimeControls = {
  role: RuntimeRole;
  heartbeatSchedulerEnabled: boolean;
  routineSchedulerEnabled: boolean;
  pluginSchedulerEnabled: boolean;
  pluginWorkersEnabled: boolean;
  pluginAutoInstallEnabled: boolean;
  startupRecoveryEnabled: boolean;
  startupReconciliationEnabled: boolean;
  databaseBackupSchedulerEnabled: boolean;
  feedbackExporterEnabled: boolean;
  migrationsApplyAllowed: boolean;
  migrationMode: MigrationMode;
  disabledSystems: Array<{ system: string; reason: string }>;
};

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

export function parseRuntimeRole(value: string | undefined): RuntimeRole {
  const normalized = value?.trim();
  if (!normalized) return "primary";
  if ((RUNTIME_ROLES as readonly string[]).includes(normalized)) {
    return normalized as RuntimeRole;
  }
  throw new Error(
    `Invalid PAPERCLIP_RUNTIME_ROLE="${normalized}". Expected one of: ${RUNTIME_ROLES.join(", ")}`,
  );
}

export function deriveRuntimeControls(input: {
  role?: string;
  heartbeatSchedulerEnv?: string;
  databaseBackupEnabled: boolean;
  feedbackExporterConfigured: boolean;
  migrationAutoApplyEnv?: string;
  migrationPromptEnv?: string;
}): RuntimeControls {
  const role = parseRuntimeRole(input.role);
  const heartbeatSchedulerExplicit = parseBooleanEnv(input.heartbeatSchedulerEnv);
  const roleAllowsWork = role === "primary" || role === "scheduler-only";
  const primaryOnly = role === "primary";
  const heartbeatSchedulerEnabled = roleAllowsWork && (heartbeatSchedulerExplicit ?? true);
  const routineSchedulerEnabled = heartbeatSchedulerEnabled;
  const startupRecoveryEnabled = heartbeatSchedulerEnabled;
  const startupReconciliationEnabled = primaryOnly;
  const pluginSchedulerEnabled = roleAllowsWork;
  const pluginWorkersEnabled = roleAllowsWork;
  const pluginAutoInstallEnabled = roleAllowsWork;
  const databaseBackupSchedulerEnabled = primaryOnly && input.databaseBackupEnabled;
  const feedbackExporterEnabled = primaryOnly && input.feedbackExporterConfigured;
  const migrationsApplyAllowed = primaryOnly;
  const migrationMode: MigrationMode =
    migrationsApplyAllowed &&
    input.migrationPromptEnv !== "never" &&
    input.migrationAutoApplyEnv !== "false"
      ? "apply"
      : "refuse";

  const disabledSystems: RuntimeControls["disabledSystems"] = [];
  const addDisabled = (system: string, enabled: boolean, reason: string) => {
    if (!enabled) disabledSystems.push({ system, reason });
  };
  const roleReason = role === "primary" ? "disabled by explicit env/config" : `disabled by runtime role ${role}`;
  addDisabled("heartbeat-scheduler", heartbeatSchedulerEnabled, roleReason);
  addDisabled("routine-scheduler", routineSchedulerEnabled, roleReason);
  addDisabled("startup-recovery", startupRecoveryEnabled, roleReason);
  addDisabled("startup-reconciliation", startupReconciliationEnabled, roleReason);
  addDisabled("plugin-job-scheduler", pluginSchedulerEnabled, roleReason);
  addDisabled("plugin-workers", pluginWorkersEnabled, roleReason);
  addDisabled("plugin-auto-install", pluginAutoInstallEnabled, roleReason);
  addDisabled("database-backup-scheduler", databaseBackupSchedulerEnabled, roleReason);
  addDisabled("feedback-exporter", feedbackExporterEnabled, roleReason);
  addDisabled("migration-apply", migrationsApplyAllowed, roleReason);

  return {
    role,
    heartbeatSchedulerEnabled,
    routineSchedulerEnabled,
    pluginSchedulerEnabled,
    pluginWorkersEnabled,
    pluginAutoInstallEnabled,
    startupRecoveryEnabled,
    startupReconciliationEnabled,
    databaseBackupSchedulerEnabled,
    feedbackExporterEnabled,
    migrationsApplyAllowed,
    migrationMode,
    disabledSystems,
  };
}

export function runtimeControlsHealthPayload(controls: RuntimeControls) {
  return {
    runtimeRole: controls.role,
    heartbeatSchedulerEnabled: controls.heartbeatSchedulerEnabled,
    routineSchedulerEnabled: controls.routineSchedulerEnabled,
    pluginSchedulerEnabled: controls.pluginSchedulerEnabled,
    pluginWorkersEnabled: controls.pluginWorkersEnabled,
    pluginAutoInstallEnabled: controls.pluginAutoInstallEnabled,
    databaseBackupSchedulerEnabled: controls.databaseBackupSchedulerEnabled,
    startupRecoveryEnabled: controls.startupRecoveryEnabled,
    startupReconciliationEnabled: controls.startupReconciliationEnabled,
    migrationMode: controls.migrationMode,
  };
}
