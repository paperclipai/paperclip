import { existsSync, readFileSync } from "node:fs";
import {
  DEFAULT_RECOVERY_STATUS_FILE,
  evaluateRecoveryStatus,
  type RecoveryStatusFile,
  type RecoveryStatusSnapshot,
  type RecoveryVaultSummary,
} from "@paperclipai/shared";
import { loadConfig } from "../config.js";
import { resolveDefaultRecoveryStatusPath } from "../home-paths.js";

function normalizePrefix(prefix: string | null | undefined): string {
  return (prefix ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

function loadRecoveryVaultSummaryFromEnv(env: NodeJS.ProcessEnv = process.env): RecoveryVaultSummary | null {
  const bucket = env.PAPERCLIP_RECOVERY_VAULT_BUCKET?.trim();
  const region = env.PAPERCLIP_RECOVERY_VAULT_REGION?.trim();
  if (!bucket && !region) return null;
  if (!bucket || !region) return null;
  return {
    bucket,
    region,
    endpoint: env.PAPERCLIP_RECOVERY_VAULT_ENDPOINT?.trim() || null,
    prefix: normalizePrefix(env.PAPERCLIP_RECOVERY_VAULT_PREFIX),
  };
}

function mergeRecoveryStatus(raw: unknown): RecoveryStatusFile {
  const base = structuredClone(DEFAULT_RECOVERY_STATUS_FILE);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return base;
  }

  const record = raw as Record<string, unknown>;
  return {
    version: 1,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : base.updatedAt,
    backupIntervalMinutes:
      typeof record.backupIntervalMinutes === "number" && Number.isFinite(record.backupIntervalMinutes)
        ? Math.max(1, Math.trunc(record.backupIntervalMinutes))
        : base.backupIntervalMinutes,
    storageProvider:
      record.storageProvider === "local_disk" || record.storageProvider === "s3"
        ? record.storageProvider
        : base.storageProvider,
    vault:
      record.vault && typeof record.vault === "object"
        ? {
            bucket: String((record.vault as Record<string, unknown>).bucket ?? ""),
            region: String((record.vault as Record<string, unknown>).region ?? ""),
            endpoint:
              (record.vault as Record<string, unknown>).endpoint == null
                ? null
                : String((record.vault as Record<string, unknown>).endpoint),
            prefix: String((record.vault as Record<string, unknown>).prefix ?? ""),
          }
        : null,
    latestUploadedManifest:
      record.latestUploadedManifest && typeof record.latestUploadedManifest === "object"
        ? record.latestUploadedManifest as RecoveryStatusFile["latestUploadedManifest"]
        : null,
    latestDrillAttempt:
      record.latestDrillAttempt && typeof record.latestDrillAttempt === "object"
        ? record.latestDrillAttempt as RecoveryStatusFile["latestDrillAttempt"]
        : null,
    latestVerifiedRestore:
      record.latestVerifiedRestore && typeof record.latestVerifiedRestore === "object"
        ? record.latestVerifiedRestore as RecoveryStatusFile["latestVerifiedRestore"]
        : null,
    assetCutover: {
      ...base.assetCutover,
      ...(typeof record.assetCutover === "object" && record.assetCutover !== null
        ? record.assetCutover as Record<string, unknown>
        : {}),
    },
    warnings: Array.isArray(record.warnings) ? record.warnings.map(String) : [],
  };
}

export function instanceRecoveryStatusService() {
  return {
    get(): RecoveryStatusSnapshot & { statusFilePath: string } {
      const config = loadConfig();
      const vault = loadRecoveryVaultSummaryFromEnv();
      const statusFilePath =
        process.env.PAPERCLIP_RECOVERY_STATUS_PATH?.trim() || resolveDefaultRecoveryStatusPath();

      const base = (() => {
        if (!existsSync(statusFilePath)) {
          return {
            ...structuredClone(DEFAULT_RECOVERY_STATUS_FILE),
            backupIntervalMinutes: config.databaseBackupIntervalMinutes,
            storageProvider: config.storageProvider,
            vault,
          };
        }

        try {
          const raw = JSON.parse(readFileSync(statusFilePath, "utf8"));
          return mergeRecoveryStatus(raw);
        } catch (error) {
          return {
            ...structuredClone(DEFAULT_RECOVERY_STATUS_FILE),
            backupIntervalMinutes: config.databaseBackupIntervalMinutes,
            storageProvider: config.storageProvider,
            vault,
            warnings: [
              `Recovery status file is unreadable: ${error instanceof Error ? error.message : String(error)}`,
            ],
          };
        }
      })();

      return {
        ...evaluateRecoveryStatus(
          {
            ...base,
            backupIntervalMinutes: config.databaseBackupIntervalMinutes,
            storageProvider: config.storageProvider,
            vault,
          },
        ),
        statusFilePath,
      };
    },
  };
}
