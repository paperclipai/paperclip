import type { FeedbackDataSharingPreference } from "./feedback.js";

export const DAILY_RETENTION_PRESETS = [3, 7, 14] as const;
export const WEEKLY_RETENTION_PRESETS = [1, 2, 4] as const;
export const MONTHLY_RETENTION_PRESETS = [1, 3, 6] as const;

export interface BackupRetentionPolicy {
  dailyDays: (typeof DAILY_RETENTION_PRESETS)[number];
  weeklyWeeks: (typeof WEEKLY_RETENTION_PRESETS)[number];
  monthlyMonths: (typeof MONTHLY_RETENTION_PRESETS)[number];
}

export const DEFAULT_BACKUP_RETENTION: BackupRetentionPolicy = {
  dailyDays: 7,
  weeklyWeeks: 4,
  monthlyMonths: 1,
};

export type InstanceUpdateChannel = "stable";

export interface InstanceUpdateSettings {
  channel: InstanceUpdateChannel;
  updateChecksEnabled: boolean;
  dismissedVersion: string | null;
  dismissedAt: string | null;
}

export const DEFAULT_INSTANCE_UPDATE_SETTINGS: InstanceUpdateSettings = {
  channel: "stable",
  updateChecksEnabled: true,
  dismissedVersion: null,
  dismissedAt: null,
};

export type InstanceUpdateStatusState =
  | "up_to_date"
  | "update_available"
  | "disabled"
  | "offline"
  | "unknown";

export interface InstanceInstallContext {
  currentVersion: string;
  gitRepositoryRoot: string | null;
  gitBranch: string | null;
  gitSha: string | null;
  gitDirty: boolean | null;
}

export interface InstancePreUpdateBackupManifest {
  version: 1;
  id: string;
  status: "succeeded" | "failed";
  createdAt: string;
  currentVersion: string;
  targetVersion: string | null;
  backupDir: string;
  databaseBackupFile: string | null;
  externalStorageAcknowledged: boolean;
  storage: {
    provider: "local_disk" | "s3";
    localDiskPath: string | null;
    s3Bucket: string | null;
    s3Region: string | null;
    s3Endpoint: string | null;
    s3Prefix: string | null;
  };
  install: InstanceInstallContext;
  included: {
    database: boolean;
    configFiles: boolean;
    localStorage: boolean;
    secretsKey: boolean;
    pluginInventory: boolean;
    externalAdapterInventory: boolean;
    gitMetadata: boolean;
  };
  counts: {
    pluginCount: number;
    externalAdapterCount: number;
    copiedFileCount: number;
    copiedBytes: number;
  };
  checksums: Record<string, string>;
  warnings: string[];
  error: string | null;
}

export interface InstancePreUpdateBackupSummary {
  id: string;
  status: "succeeded" | "failed";
  createdAt: string;
  currentVersion: string;
  targetVersion: string | null;
  backupDir: string;
  manifestPath: string;
  databaseBackupFile: string | null;
  externalStorageAcknowledged: boolean;
  storageProvider: "local_disk" | "s3";
  warnings: string[];
  error: string | null;
}

export type InstancePreUpdateBackupInvalidReason =
  | "none"
  | "missing"
  | "failed"
  | "stale"
  | "target_mismatch"
  | "external_storage_unverified";

export interface InstancePreUpdateBackupStatus {
  required: boolean;
  valid: boolean;
  reason: InstancePreUpdateBackupInvalidReason;
  targetVersion: string | null;
  expiresAt: string | null;
  latest: InstancePreUpdateBackupSummary | null;
  externalStorageRequiresAcknowledgement: boolean;
}

export interface InstanceUpdateStatus {
  status: InstanceUpdateStatusState;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  checkedAt: string | null;
  nextCheckAt: string | null;
  checkSource: "npm" | "github" | "cache" | null;
  error: string | null;
  settings: InstanceUpdateSettings;
  install: InstanceInstallContext;
  backup: InstancePreUpdateBackupStatus;
  banner: {
    shouldShow: boolean;
    tone: "info" | "warn" | null;
    reasons: string[];
  };
}

export interface InstanceGeneralSettings {
  censorUsernameInLogs: boolean;
  keyboardShortcuts: boolean;
  feedbackDataSharingPreference: FeedbackDataSharingPreference;
  backupRetention: BackupRetentionPolicy;
  updateSettings: InstanceUpdateSettings;
}

export interface InstanceExperimentalSettings {
  enableIsolatedWorkspaces: boolean;
  autoRestartDevServerWhenIdle: boolean;
}

export interface InstanceSettings {
  id: string;
  general: InstanceGeneralSettings;
  experimental: InstanceExperimentalSettings;
  createdAt: Date;
  updatedAt: Date;
}
