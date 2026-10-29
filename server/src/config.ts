import { readConfigFile, resolveDeploymentMode } from "./config-file.js";
import { parseChatWebhookPublicBaseUrl } from "./chat-webhook-public-url.js";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { resolvePaperclipEnvPath } from "./paths.js";
import { maybeRepairLegacyWorktreeConfigAndEnvFiles } from "./worktree-config.js";
import { shouldLoadWorkingDirectoryEnv } from "./env-file-policy.js";
import { applyEmptyWorktreeSigningSecrets } from "./dev-runner-worktree.js";
import {
  AUTH_BASE_URL_MODES,
  BIND_MODES,
  DEPLOYMENT_EXPOSURES,
  SECRET_PROVIDERS,
  STORAGE_PROVIDERS,
  type BindMode,
  type AuthBaseUrlMode,
  type DeploymentExposure,
  type DeploymentMode,
  type SecretProvider,
  type StorageProvider,
  inferBindModeFromHost,
  resolveRuntimeBind,
  validateConfiguredBindMode,
} from "@paperclipai/shared";
import {
  resolveDefaultBackupDir,
  resolveDefaultEmbeddedPostgresDir,
  resolveDefaultSecretsKeyFilePath,
  resolveDefaultStorageDir,
  resolveHomeAwarePath,
} from "./home-paths.js";

const PAPERCLIP_ENV_FILE_PATH = resolvePaperclipEnvPath();
if (existsSync(PAPERCLIP_ENV_FILE_PATH)) {
  loadDotenv({ path: PAPERCLIP_ENV_FILE_PATH, override: false, quiet: true });
}

const CWD_ENV_PATH = resolve(process.cwd(), ".env");
const cwdEnvExists = existsSync(CWD_ENV_PATH);
const isSameFile = cwdEnvExists && existsSync(PAPERCLIP_ENV_FILE_PATH)
  ? realpathSync(CWD_ENV_PATH) === realpathSync(PAPERCLIP_ENV_FILE_PATH)
  : CWD_ENV_PATH === PAPERCLIP_ENV_FILE_PATH;
if (shouldLoadWorkingDirectoryEnv({
  cwdEnvExists,
  isPaperclipEnvFile: isSameFile,
})) {
  loadDotenv({ path: CWD_ENV_PATH, override: false, quiet: true });
}

if (basename(dirname(PAPERCLIP_ENV_FILE_PATH)) === ".paperclip") {
  applyEmptyWorktreeSigningSecrets(dirname(dirname(PAPERCLIP_ENV_FILE_PATH)));
}
maybeRepairLegacyWorktreeConfigAndEnvFiles();

const TAILSCALE_DETECT_TIMEOUT_MS = 3000;

type DatabaseMode = "embedded-postgres" | "postgres";

export interface Config {
  deploymentMode: DeploymentMode;
  deploymentExposure: DeploymentExposure;
  bind: BindMode;
  customBindHost: string | undefined;
  host: string;
  port: number;
  allowedHostnames: string[];
  authBaseUrlMode: AuthBaseUrlMode;
  authPublicBaseUrl: string | undefined;
  chatWebhookPublicBaseUrl: string | undefined;
  authDisableSignUp: boolean;
  databaseMode: DatabaseMode;
  databaseUrl: string | undefined;
  databaseMigrationUrl: string | undefined;
  embeddedPostgresDataDir: string;
  embeddedPostgresPort: number;
  databaseBackupEnabled: boolean;
  databaseBackupIntervalMinutes: number;
  databaseBackupRetentionDays: number;
  databaseBackupDir: string;
  gitCacheExpirationEnabled: boolean;
  gitBaseExpirationEnabled: boolean;
  gitCacheExpirationDryRun: boolean;
  isolatedSourceRehomeEnabled: boolean;
  isolatedSourceRehomeDryRun: boolean;
  nestedCloneMigrationEnabled: boolean;
  nestedCloneMigrationDryRun: boolean;
  workspaceReaperCooldownDays: number;
  workspaceCompactionDelayHours: number | null;
  skillVersionRetentionEnabled: boolean;
  skillVersionRetentionDryRun: boolean;
  skillVersionRetentionKeepNewest: number;
  skillVersionRetentionGraceMinutes: number;
  nativeHarnessBackupExpirationEnabled: boolean;
  nativeHarnessBackupExpirationDryRun: boolean;
  nativeHarnessBackupExpirationDays: number;
  nativeRunnerEvidenceRetentionDays: number;
  nativeWorkspaceSyncRetentionEnabled: boolean;
  nativeWorkspaceSyncRetentionDryRun: boolean;
  nativeWorkspaceSyncRetentionDays: number;
  gitRestorePointRetentionDays: number;
  gitRestorePointsEnabled: boolean;
  gitRestorePointTerminalDelayDays: number;
  gitRestorePointIdleDays: number;
  taskDirectoryRetentionEnabled: boolean;
  taskDirectoryRetentionDryRun: boolean;
  taskDirectoryOrphanGraceDays: number;
  serveUi: boolean;
  uiDevMiddleware: boolean;
  secretsProvider: SecretProvider;
  secretsStrictMode: boolean;
  secretsMasterKeyFilePath: string;
  storageProvider: StorageProvider;
  storageLocalDiskBaseDir: string;
  storageS3Bucket: string;
  storageS3Region: string;
  storageS3Endpoint: string | undefined;
  storageS3Prefix: string;
  storageS3ForcePathStyle: boolean;
  feedbackExportBackendUrl: string | undefined;
  feedbackExportBackendToken: string | undefined;
  heartbeatSchedulerEnabled: boolean;
  heartbeatSchedulerIntervalMs: number;
  companyDeletionEnabled: boolean;
  telemetryEnabled: boolean;
  announcementsEnabled: boolean;
  announcementsFeedUrl: string;
}

function detectTailnetBindHost(): string | undefined {
  const explicit = process.env.PAPERCLIP_TAILNET_BIND_HOST?.trim();
  if (explicit) return explicit;

  try {
    const stdout = execFileSync("tailscale", ["ip", "-4"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: TAILSCALE_DETECT_TIMEOUT_MS,
    });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
  } catch {
    return undefined;
  }
}

export function loadConfig(): Config {
  const fileConfig = readConfigFile();
  const fileDatabaseMode =
    (fileConfig?.database.mode === "postgres" ? "postgres" : "embedded-postgres") as DatabaseMode;

  const fileDbUrl =
    fileDatabaseMode === "postgres"
      ? fileConfig?.database.connectionString
      : undefined;
  const fileDatabaseBackup = fileConfig?.database.backup;
  const fileSecrets = fileConfig?.secrets;
  const fileStorage = fileConfig?.storage;

  const providerFromEnvRaw = process.env.PAPERCLIP_SECRETS_PROVIDER;
  const providerFromEnv =
    providerFromEnvRaw && SECRET_PROVIDERS.includes(providerFromEnvRaw as SecretProvider)
      ? (providerFromEnvRaw as SecretProvider)
      : null;
  const providerFromFile = fileSecrets?.provider;
  const secretsProvider: SecretProvider = providerFromEnv ?? providerFromFile ?? "local_encrypted";

  const storageProviderFromEnvRaw = process.env.PAPERCLIP_STORAGE_PROVIDER;
  const storageProviderFromEnv =
    storageProviderFromEnvRaw && STORAGE_PROVIDERS.includes(storageProviderFromEnvRaw as StorageProvider)
      ? (storageProviderFromEnvRaw as StorageProvider)
      : null;
  const storageProvider: StorageProvider = storageProviderFromEnv ?? fileStorage?.provider ?? "local_disk";
  const storageLocalDiskBaseDir = resolveHomeAwarePath(
    process.env.PAPERCLIP_STORAGE_LOCAL_DIR ??
      fileStorage?.localDisk?.baseDir ??
      resolveDefaultStorageDir(),
  );
  const storageS3Bucket = process.env.PAPERCLIP_STORAGE_S3_BUCKET ?? fileStorage?.s3?.bucket ?? "paperclip";
  const storageS3Region = process.env.PAPERCLIP_STORAGE_S3_REGION ?? fileStorage?.s3?.region ?? "us-east-1";
  const storageS3Endpoint = process.env.PAPERCLIP_STORAGE_S3_ENDPOINT ?? fileStorage?.s3?.endpoint ?? undefined;
  const storageS3Prefix = process.env.PAPERCLIP_STORAGE_S3_PREFIX ?? fileStorage?.s3?.prefix ?? "";
  const storageS3ForcePathStyle =
    process.env.PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE !== undefined
      ? process.env.PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE === "true"
      : (fileStorage?.s3?.forcePathStyle ?? false);
  const feedbackExportBackendUrl =
    process.env.PAPERCLIP_FEEDBACK_EXPORT_BACKEND_URL?.trim() ||
    process.env.PAPERCLIP_TELEMETRY_BACKEND_URL?.trim() ||
    undefined;
  const feedbackExportBackendToken =
    process.env.PAPERCLIP_FEEDBACK_EXPORT_BACKEND_TOKEN?.trim() ||
    process.env.PAPERCLIP_TELEMETRY_BACKEND_TOKEN?.trim() ||
    undefined;

  const deploymentMode = resolveDeploymentMode(fileConfig);
  const strictModeFromEnv = process.env.PAPERCLIP_SECRETS_STRICT_MODE;
  const secretsStrictMode =
    strictModeFromEnv !== undefined
      ? strictModeFromEnv === "true"
      : (fileSecrets?.strictMode ?? deploymentMode === "authenticated");
  const deploymentExposureFromEnvRaw = process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE;
  const deploymentExposureFromEnv =
    deploymentExposureFromEnvRaw &&
    DEPLOYMENT_EXPOSURES.includes(deploymentExposureFromEnvRaw as DeploymentExposure)
      ? (deploymentExposureFromEnvRaw as DeploymentExposure)
      : null;
  const deploymentExposure: DeploymentExposure =
    deploymentMode === "local_trusted"
      ? "private"
      : (deploymentExposureFromEnv ?? fileConfig?.server.exposure ?? "private");
  const bindFromEnvRaw = process.env.PAPERCLIP_BIND;
  const bindFromEnv =
    bindFromEnvRaw && BIND_MODES.includes(bindFromEnvRaw as BindMode)
      ? (bindFromEnvRaw as BindMode)
      : null;
  const configuredHost = process.env.HOST ?? fileConfig?.server.host ?? "127.0.0.1";
  const tailnetBindHost = detectTailnetBindHost();
  const bind =
    bindFromEnv ??
    fileConfig?.server.bind ??
    inferBindModeFromHost(configuredHost, { tailnetBindHost });
  const customBindHost = process.env.PAPERCLIP_BIND_HOST ?? fileConfig?.server.customBindHost;
  const authBaseUrlModeFromEnvRaw = process.env.PAPERCLIP_AUTH_BASE_URL_MODE;
  const authBaseUrlModeFromEnv =
    authBaseUrlModeFromEnvRaw &&
    AUTH_BASE_URL_MODES.includes(authBaseUrlModeFromEnvRaw as AuthBaseUrlMode)
      ? (authBaseUrlModeFromEnvRaw as AuthBaseUrlMode)
      : null;
  const publicUrlFromEnv = process.env.PAPERCLIP_PUBLIC_URL;
  const configuredAuthPublicBaseUrlRaw = [
    process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL,
    process.env.BETTER_AUTH_URL,
    process.env.BETTER_AUTH_BASE_URL,
    publicUrlFromEnv,
    fileConfig?.auth?.publicBaseUrl,
  ].find((value): value is string => typeof value === "string" && value.trim().length > 0);
  const managedRuntimePublicUrl = process.env.PAPERCLIP_MANAGED_RUNTIME_PUBLIC_URL?.trim() || undefined;
  const authPublicBaseUrlRaw = configuredAuthPublicBaseUrlRaw ?? managedRuntimePublicUrl;
  const authPublicBaseUrl = authPublicBaseUrlRaw?.trim() || undefined;
  const authBaseUrlMode: AuthBaseUrlMode =
    authBaseUrlModeFromEnv ??
    (configuredAuthPublicBaseUrlRaw === undefined && managedRuntimePublicUrl
      ? "explicit"
      : fileConfig?.auth?.baseUrlMode ?? (authPublicBaseUrl ? "explicit" : "auto"));
  const disableSignUpFromEnv = process.env.PAPERCLIP_AUTH_DISABLE_SIGN_UP;
  const authDisableSignUp: boolean =
    disableSignUpFromEnv !== undefined
      ? disableSignUpFromEnv === "true"
      : (fileConfig?.auth?.disableSignUp ?? false);
  const allowedHostnamesFromEnvRaw = process.env.PAPERCLIP_ALLOWED_HOSTNAMES;
  const allowedHostnamesFromEnv = allowedHostnamesFromEnvRaw
    ? allowedHostnamesFromEnvRaw
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0)
    : null;
  const publicUrlHostname = authPublicBaseUrl
    ? (() => {
      try {
        return new URL(authPublicBaseUrl).hostname.trim().toLowerCase();
      } catch {
        return null;
      }
    })()
    : null;
  const allowedHostnames = Array.from(
    new Set(
      [
        ...(allowedHostnamesFromEnv ?? fileConfig?.server.allowedHostnames ?? []),
        ...(publicUrlHostname ? [publicUrlHostname] : []),
      ]
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
  const companyDeletionEnvRaw = process.env.PAPERCLIP_ENABLE_COMPANY_DELETION;
  const companyDeletionEnabled =
    companyDeletionEnvRaw !== undefined
      ? companyDeletionEnvRaw === "true"
      : deploymentMode === "local_trusted";
  const databaseBackupEnabled =
    process.env.PAPERCLIP_DB_BACKUP_ENABLED !== undefined
      ? process.env.PAPERCLIP_DB_BACKUP_ENABLED === "true"
      : (fileDatabaseBackup?.enabled ?? true);
  const databaseBackupIntervalMinutes = Math.max(
    1,
    Number(process.env.PAPERCLIP_DB_BACKUP_INTERVAL_MINUTES) ||
      fileDatabaseBackup?.intervalMinutes ||
      60,
  );
  const databaseBackupRetentionDays = Math.max(
    1,
    Number(process.env.PAPERCLIP_DB_BACKUP_RETENTION_DAYS) ||
      fileDatabaseBackup?.retentionDays ||
      7,
  );
  const databaseBackupDir = resolveHomeAwarePath(
    process.env.PAPERCLIP_DB_BACKUP_DIR ??
      fileDatabaseBackup?.dir ??
      resolveDefaultBackupDir(),
  );
  // The terminal-workspace reaper waits this many days after an issue tree
  // becomes terminal before it archives the workspace. A person can reopen the
  // work inside this window. A value of 0 disables the cooldown and restores
  // immediate reaping. A negative or non-numeric value falls back to the
  // default. The day granularity obeys the PAPERCLIP_DB_BACKUP_RETENTION_DAYS
  // precedent above. The default is 1 day: regenerable files are compacted
  // after a few hours anyway, so a longer hold only keeps source checkouts of
  // delivered work, and a recurring task produces one workspace per run.
  const workspaceReaperCooldownDaysEnv =
    process.env.PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS?.trim();
  const workspaceReaperCooldownDaysRaw = Number(workspaceReaperCooldownDaysEnv);
  const workspaceReaperCooldownDays =
    workspaceReaperCooldownDaysEnv
      && Number.isFinite(workspaceReaperCooldownDaysRaw)
      && workspaceReaperCooldownDaysRaw >= 0
      ? workspaceReaperCooldownDaysRaw
      : 1;
  // The terminal-workspace reaper removes regenerable files (installed
  // dependencies, build output, tool caches) from a terminal workspace this
  // many hours after its issue tree becomes terminal. The worktree and every
  // source file stay; a resumed task regenerates the files when its workspace
  // is provisioned again. 0 compacts on the next sweep. A negative, empty, or
  // non-numeric value falls back to the default of 1 hour.
  // PAPERCLIP_WORKSPACE_COMPACTION_ENABLED=false turns compaction off.
  const workspaceCompactionDelayHoursEnv =
    process.env.PAPERCLIP_WORKSPACE_COMPACTION_DELAY_HOURS?.trim();
  const workspaceCompactionDelayHoursRaw = Number(workspaceCompactionDelayHoursEnv);
  const workspaceCompactionDelayHours =
    process.env.PAPERCLIP_WORKSPACE_COMPACTION_ENABLED?.trim().toLowerCase() === "false"
      ? null
      : workspaceCompactionDelayHoursEnv
          && Number.isFinite(workspaceCompactionDelayHoursRaw)
          && workspaceCompactionDelayHoursRaw >= 0
        ? workspaceCompactionDelayHoursRaw
        : 1;
  // Skill version retention removes materialized version directories under
  // `skills/<companyId>/__versions__/` that no current version, agent pin, or
  // live run uses. It keeps this many newest versions per skill as a warm
  // cache. A version directory used within the grace window also stays. A
  // removed directory is written again from its version row on next use.
  // Negative, empty, or non-numeric values fall back to the defaults.
  const nonNegativeIntegerEnv = (name: string, fallback: number) => {
    const raw = process.env[name]?.trim();
    const value = Number(raw);
    return raw && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
  };
  const skillVersionRetentionKeepNewest = nonNegativeIntegerEnv("PAPERCLIP_SKILL_VERSION_RETENTION_KEEP", 0);
  const skillVersionRetentionGraceMinutes = nonNegativeIntegerEnv("PAPERCLIP_SKILL_VERSION_RETENTION_GRACE_MINUTES", 60);
  const nativeHarnessBackupExpirationDays = Math.max(1, nonNegativeIntegerEnv("PAPERCLIP_NATIVE_HARNESS_BACKUP_EXPIRATION_DAYS", 7));
  const nativeRunnerEvidenceRetentionDays = Math.max(1, nonNegativeIntegerEnv("PAPERCLIP_NATIVE_RUNNER_EVIDENCE_RETENTION_DAYS", 7));
  const nativeWorkspaceSyncRetentionDays = Math.max(1, nonNegativeIntegerEnv("PAPERCLIP_NATIVE_WORKSPACE_SYNC_RETENTION_DAYS", 7));
  const gitRestorePointRetentionDays = Math.max(1, nonNegativeIntegerEnv("PAPERCLIP_GIT_RESTORE_POINT_RETENTION_DAYS", 90));
  const gitRestorePointTerminalDelayDays = nonNegativeIntegerEnv("PAPERCLIP_GIT_RESTORE_POINT_TERMINAL_DELAY_DAYS", 3);
  const gitRestorePointIdleDays = nonNegativeIntegerEnv("PAPERCLIP_GIT_RESTORE_POINT_IDLE_DAYS", 7);
  const taskDirectoryOrphanGraceDays = Math.max(1, nonNegativeIntegerEnv("PAPERCLIP_TASK_DIRECTORY_ORPHAN_GRACE_DAYS", 7));
  const bindValidationErrors = validateConfiguredBindMode({
    deploymentMode,
    deploymentExposure,
    bind,
    host: configuredHost,
    customBindHost,
  });
  if (bindValidationErrors.length > 0) {
    throw new Error(bindValidationErrors[0]);
  }
  const resolvedBind = resolveRuntimeBind({
    bind,
    host: configuredHost,
    customBindHost,
    tailnetBindHost,
  });
  if (resolvedBind.errors.length > 0) {
    throw new Error(resolvedBind.errors[0]);
  }

  return {
    deploymentMode,
    deploymentExposure,
    bind: resolvedBind.bind,
    customBindHost: resolvedBind.customBindHost,
    host: resolvedBind.host,
    port: Number(process.env.PORT) || fileConfig?.server.port || 3100,
    allowedHostnames,
    authBaseUrlMode,
    authPublicBaseUrl,
    chatWebhookPublicBaseUrl: parseChatWebhookPublicBaseUrl(
      process.env.PAPERCLIP_CHAT_WEBHOOK_PUBLIC_URL,
    ),
    authDisableSignUp,
    databaseMode: fileDatabaseMode,
    databaseUrl: process.env.DATABASE_URL ?? fileDbUrl,
    databaseMigrationUrl: process.env.DATABASE_MIGRATION_URL,
    embeddedPostgresDataDir: resolveHomeAwarePath(
      fileConfig?.database.embeddedPostgresDataDir ?? resolveDefaultEmbeddedPostgresDir(),
    ),
    embeddedPostgresPort: fileConfig?.database.embeddedPostgresPort ?? 54329,
    databaseBackupEnabled,
    databaseBackupIntervalMinutes,
    databaseBackupRetentionDays,
    databaseBackupDir,
    gitCacheExpirationEnabled: process.env.PAPERCLIP_GIT_CACHE_EXPIRATION_ENABLED === "true",
    gitBaseExpirationEnabled: process.env.PAPERCLIP_GIT_BASE_EXPIRATION_ENABLED === "true",
    gitCacheExpirationDryRun: process.env.PAPERCLIP_GIT_CACHE_EXPIRATION_DRY_RUN !== "false",
    isolatedSourceRehomeEnabled: process.env.PAPERCLIP_ISOLATED_SOURCE_REHOME_ENABLED === "true",
    isolatedSourceRehomeDryRun: process.env.PAPERCLIP_ISOLATED_SOURCE_REHOME_DRY_RUN === "true",
    nestedCloneMigrationEnabled: process.env.PAPERCLIP_NESTED_CLONE_MIGRATION_ENABLED === "true",
    nestedCloneMigrationDryRun: process.env.PAPERCLIP_NESTED_CLONE_MIGRATION_DRY_RUN === "true",
    workspaceReaperCooldownDays,
    workspaceCompactionDelayHours,
    skillVersionRetentionEnabled: process.env.PAPERCLIP_SKILL_VERSION_RETENTION_ENABLED !== "false",
    skillVersionRetentionDryRun: process.env.PAPERCLIP_SKILL_VERSION_RETENTION_DRY_RUN === "true",
    skillVersionRetentionKeepNewest,
    skillVersionRetentionGraceMinutes,
    nativeHarnessBackupExpirationEnabled: process.env.PAPERCLIP_NATIVE_HARNESS_BACKUP_EXPIRATION_ENABLED !== "false",
    nativeHarnessBackupExpirationDryRun: process.env.PAPERCLIP_NATIVE_HARNESS_BACKUP_EXPIRATION_DRY_RUN === "true",
    nativeHarnessBackupExpirationDays,
    nativeRunnerEvidenceRetentionDays,
    nativeWorkspaceSyncRetentionEnabled: process.env.PAPERCLIP_NATIVE_WORKSPACE_SYNC_RETENTION_ENABLED !== "false",
    nativeWorkspaceSyncRetentionDryRun: process.env.PAPERCLIP_NATIVE_WORKSPACE_SYNC_RETENTION_DRY_RUN === "true",
    nativeWorkspaceSyncRetentionDays,
    gitRestorePointRetentionDays,
    gitRestorePointsEnabled: process.env.PAPERCLIP_GIT_RESTORE_POINTS_ENABLED === "true",
    gitRestorePointTerminalDelayDays,
    gitRestorePointIdleDays,
    taskDirectoryRetentionEnabled: process.env.PAPERCLIP_TASK_DIRECTORY_RETENTION_ENABLED === "true",
    taskDirectoryRetentionDryRun: process.env.PAPERCLIP_TASK_DIRECTORY_RETENTION_DRY_RUN !== "false",
    taskDirectoryOrphanGraceDays,
    serveUi:
      process.env.SERVE_UI !== undefined
        ? process.env.SERVE_UI === "true"
        : fileConfig?.server.serveUi ?? true,
    uiDevMiddleware: process.env.PAPERCLIP_UI_DEV_MIDDLEWARE === "true",
    secretsProvider,
    secretsStrictMode,
    secretsMasterKeyFilePath:
      resolveHomeAwarePath(
        process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE ??
          fileSecrets?.localEncrypted.keyFilePath ??
          resolveDefaultSecretsKeyFilePath(),
      ),
    storageProvider,
    storageLocalDiskBaseDir,
    storageS3Bucket,
    storageS3Region,
    storageS3Endpoint,
    storageS3Prefix,
    storageS3ForcePathStyle,
    feedbackExportBackendUrl,
    feedbackExportBackendToken,
    heartbeatSchedulerEnabled: process.env.HEARTBEAT_SCHEDULER_ENABLED !== "false",
    heartbeatSchedulerIntervalMs: Math.max(10000, Number(process.env.HEARTBEAT_SCHEDULER_INTERVAL_MS) || 30000),
    companyDeletionEnabled,
    telemetryEnabled: fileConfig?.telemetry?.enabled ?? true,
    announcementsEnabled: process.env.PAPERCLIP_ANNOUNCEMENTS_ENABLED !== "false",
    announcementsFeedUrl: process.env.PAPERCLIP_ANNOUNCEMENTS_FEED_URL?.trim() || "https://pages.paperclip.ing/announcements/v1/current.json",
  };
}
