import type { StorageProvider } from "../constants.js";

export const RECOVERY_STATES = [
  "LocalOnly",
  "VaultProvisioned",
  "AssetStorageCutoverReady",
  "RecoveryWriterHealthy",
  "ManifestPublished",
  "RestoreVerified",
  "ManifestStale",
  "AssetReplicationLagging",
  "KeySnapshotMissing",
  "RestoreDrillFailed",
  "RecoveryDegraded",
] as const;

export type RecoveryState = (typeof RECOVERY_STATES)[number];

export const RECOVERY_MANIFEST_FRESHNESS = ["missing", "fresh", "stale"] as const;
export type RecoveryManifestFreshness = (typeof RECOVERY_MANIFEST_FRESHNESS)[number];

export const RECOVERY_BACKUP_TIERS = ["hourly", "daily", "weekly", "monthly"] as const;
export type RecoveryBackupTier = (typeof RECOVERY_BACKUP_TIERS)[number];

export const RECOVERY_DRILL_STATUSES = ["passed", "failed"] as const;
export type RecoveryDrillStatus = (typeof RECOVERY_DRILL_STATUSES)[number];

export interface RecoveryVaultSummary {
  bucket: string;
  region: string;
  endpoint: string | null;
  prefix: string;
}

export interface RecoveryArtifactRef {
  objectKey: string;
  sizeBytes: number;
  sha256: string;
  uploadedAt: string;
}

export interface RecoveryBackupArtifact extends RecoveryArtifactRef {
  tier: RecoveryBackupTier;
}

export interface RecoveryKeySnapshotArtifact extends RecoveryArtifactRef {
  fingerprint: string;
  encrypted: boolean;
}

export interface RecoveryManifestRecord {
  manifestId: string;
  createdAt: string;
  manifestObjectKey: string;
  sourceBackupFile: string;
  sourceBackupCreatedAt: string | null;
  storageProvider: StorageProvider;
  assetCutoverComplete: boolean;
  assetSampleKeys: string[];
  backupArtifacts: RecoveryBackupArtifact[];
  keySnapshot: RecoveryKeySnapshotArtifact | null;
  configSnapshot: RecoveryArtifactRef | null;
  warnings: string[];
}

export interface RecoveryDrillRecord {
  drillId: string;
  manifestId: string;
  status: RecoveryDrillStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  verifiedChecks: string[];
  failures: string[];
  evidenceObjectKey: string | null;
}

export interface RecoveryAssetCutoverStatus {
  lastRunAt: string | null;
  switchedAt: string | null;
  migratedAssetCount: number;
  migratedByteCount: number;
  remainingLocalAssetCount: number;
  sampleObjectKeys: string[];
  lastError: string | null;
}

export interface RecoveryStatusFile {
  version: 1;
  updatedAt: string;
  backupIntervalMinutes: number;
  storageProvider: StorageProvider;
  vault: RecoveryVaultSummary | null;
  latestUploadedManifest: RecoveryManifestRecord | null;
  latestDrillAttempt: RecoveryDrillRecord | null;
  latestVerifiedRestore: RecoveryDrillRecord | null;
  assetCutover: RecoveryAssetCutoverStatus;
  warnings: string[];
}

export interface RecoveryStatusSnapshot extends RecoveryStatusFile {
  state: RecoveryState;
  manifestFreshness: RecoveryManifestFreshness;
  degradedReasons: string[];
}

export const DEFAULT_RECOVERY_STATUS_FILE: RecoveryStatusFile = {
  version: 1,
  updatedAt: new Date(0).toISOString(),
  backupIntervalMinutes: 60,
  storageProvider: "local_disk",
  vault: null,
  latestUploadedManifest: null,
  latestDrillAttempt: null,
  latestVerifiedRestore: null,
  assetCutover: {
    lastRunAt: null,
    switchedAt: null,
    migratedAssetCount: 0,
    migratedByteCount: 0,
    remainingLocalAssetCount: 0,
    sampleObjectKeys: [],
    lastError: null,
  },
  warnings: [],
};

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function uniq(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

export function evaluateRecoveryStatus(
  input: RecoveryStatusFile,
  now: Date = new Date(),
): RecoveryStatusSnapshot {
  const degradedReasons: string[] = [];
  const manifest = input.latestUploadedManifest;
  const latestDrill = input.latestDrillAttempt;
  const manifestCreatedAt = toDate(manifest?.createdAt);
  const staleThresholdMs = Math.max(1, input.backupIntervalMinutes) * 60 * 1000 + 15 * 60 * 1000;
  const manifestFreshness: RecoveryManifestFreshness =
    !manifestCreatedAt
      ? "missing"
      : now.getTime() - manifestCreatedAt.getTime() > staleThresholdMs
        ? "stale"
        : "fresh";

  const cutoverReady = input.assetCutover.remainingLocalAssetCount === 0 &&
    (input.storageProvider === "s3" || input.assetCutover.migratedAssetCount > 0);
  const cutoverComplete = input.storageProvider === "s3" && cutoverReady;

  if (!input.vault) {
    degradedReasons.push("Recovery vault is not configured.");
  }

  if (input.storageProvider !== "s3") {
    degradedReasons.push("Live asset storage is still local_disk; asset cutover to S3 is incomplete.");
  }

  if (input.assetCutover.remainingLocalAssetCount > 0) {
    degradedReasons.push(
      `${input.assetCutover.remainingLocalAssetCount} asset object(s) still need migration before cutover is complete.`,
    );
  }

  if (input.assetCutover.lastError) {
    degradedReasons.push(`Asset cutover error: ${input.assetCutover.lastError}`);
  }

  if (manifestFreshness === "missing") {
    degradedReasons.push("No recovery manifest has been published yet.");
  }

  if (manifestFreshness === "stale") {
    degradedReasons.push("Latest recovery manifest is older than the configured backup interval.");
  }

  if (manifest && !manifest.keySnapshot) {
    degradedReasons.push("Latest recovery manifest is missing a secrets master-key snapshot.");
  }

  if (manifest && !manifest.configSnapshot) {
    degradedReasons.push("Latest recovery manifest is missing a sanitized config snapshot.");
  }

  if (manifest && !manifest.assetCutoverComplete) {
    degradedReasons.push("Latest recovery manifest was published before asset storage cutover completed.");
  }

  if (latestDrill?.status === "failed") {
    degradedReasons.push("Latest restore drill failed.");
  }

  let state: RecoveryState;
  if (!input.vault) {
    state = "LocalOnly";
  } else if (latestDrill?.status === "failed") {
    state = "RestoreDrillFailed";
  } else if (manifest && !manifest.keySnapshot) {
    state = "KeySnapshotMissing";
  } else if (manifestFreshness === "stale") {
    state = "ManifestStale";
  } else if (input.latestVerifiedRestore?.status === "passed" && cutoverComplete && manifestFreshness === "fresh") {
    state = "RestoreVerified";
  } else if (manifestFreshness === "fresh" && cutoverComplete) {
    state = "ManifestPublished";
  } else if (cutoverReady) {
    state = manifestFreshness === "fresh" ? "RecoveryWriterHealthy" : "AssetStorageCutoverReady";
  } else if (manifestFreshness === "fresh") {
    state = "RecoveryDegraded";
  } else {
    state = "VaultProvisioned";
  }

  return {
    ...input,
    state,
    manifestFreshness,
    degradedReasons: uniq(degradedReasons),
    warnings: uniq([
      ...input.warnings,
      ...(manifest?.warnings ?? []),
    ]),
  };
}
