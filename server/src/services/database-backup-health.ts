import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export type DatabaseBackupHealthWarningCode =
  | "database_backup_check_failed"
  | "database_backup_last_failure"
  | "database_backup_missing"
  | "database_backup_stale"
  | "database_backup_truncated";

export type DatabaseBackupHealthWarning = {
  code: DatabaseBackupHealthWarningCode;
  message: string;
};

export type DatabaseBackupHealthStatus = {
  enabled: boolean;
  status: "ok" | "warning";
  backupDir: string;
  maxAgeHours: number;
  latestBackup: {
    name: string;
    path: string;
    mtime: string;
    ageHours: number;
    sizeBytes: number;
  } | null;
  lastFailure: {
    path: string;
    mtime: string;
    message: string;
  } | null;
  warnings: DatabaseBackupHealthWarning[];
};

export type InspectDatabaseBackupHealthOptions = {
  enabled: boolean;
  backupDir: string;
  maxAgeHours: number;
  alertFile?: string;
  alertFiles?: string[];
  now?: Date;
};

function roundHours(value: number): number {
  return Math.round(value * 10) / 10;
}

function alertFileCandidates(opts: InspectDatabaseBackupHealthOptions) {
  return [...new Set([
    opts.alertFile,
    ...(opts.alertFiles ?? []),
    join(opts.backupDir, "db-backup-to-s3.failure"),
    resolve(opts.backupDir, "..", "db-backup-to-s3.failure"),
  ].filter((value): value is string => Boolean(value)))];
}

function readLastFailure(alertFiles: string[]) {
  const failures = alertFiles
    .filter((alertFile) => existsSync(alertFile))
    .map((alertFile) => {
      const stat = statSync(alertFile);
      const message = readFileSync(alertFile, "utf8").trim().split(/\r?\n/)[0] ||
        "Database backup failure marker is present.";
      return {
        path: alertFile,
        mtime: new Date(stat.mtimeMs).toISOString(),
        mtimeMs: stat.mtimeMs,
        message,
      };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  const latest = failures[0];
  if (!latest) return null;
  return {
    path: latest.path,
    mtime: latest.mtime,
    message: latest.message,
  };
}

function findLatestBackup(backupDir: string, nowMs: number) {
  if (!existsSync(backupDir)) return null;

  const candidates = readdirSync(backupDir)
    .filter((name) => name.endsWith(".sql.gz"))
    .map((name) => {
      const fullPath = join(backupDir, name);
      const stat = statSync(fullPath);
      return { fullPath, name, stat };
    })
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

  const latest = candidates[0];
  if (!latest) return null;

  const otherSizes = candidates.slice(1).map((candidate) => candidate.stat.size).sort((a, b) => a - b);
  const medianOtherSizeBytes = otherSizes.length > 0
    ? otherSizes[Math.floor(otherSizes.length / 2)]!
    : null;

  return {
    name: basename(latest.fullPath),
    path: latest.fullPath,
    mtime: new Date(latest.stat.mtimeMs).toISOString(),
    ageHours: roundHours((nowMs - latest.stat.mtimeMs) / 3_600_000),
    sizeBytes: latest.stat.size,
    medianOtherSizeBytes,
    otherCount: otherSizes.length,
  };
}

// A finished dump of even an empty database carries schema and session
// boilerplate and compresses to several hundred bytes. A newest backup
// far below that — or far below the size of the backups before it — is a
// truncated artifact of a crashed backup run, not a usable backup. See
// #15351.
const TRUNCATED_ABSOLUTE_FLOOR_BYTES = 200;
const TRUNCATED_MEDIAN_FRACTION = 0.25;
const TRUNCATED_MEDIAN_MIN_SAMPLES = 3;

function isImplausiblySmall(latest: { sizeBytes: number; medianOtherSizeBytes: number | null; otherCount: number }): boolean {
  if (latest.sizeBytes < TRUNCATED_ABSOLUTE_FLOOR_BYTES) return true;
  if (
    latest.otherCount >= TRUNCATED_MEDIAN_MIN_SAMPLES &&
    latest.medianOtherSizeBytes !== null &&
    latest.medianOtherSizeBytes > 0 &&
    latest.sizeBytes < latest.medianOtherSizeBytes * TRUNCATED_MEDIAN_FRACTION
  ) {
    return true;
  }
  return false;
}

export function inspectDatabaseBackupHealth(
  opts: InspectDatabaseBackupHealthOptions,
): DatabaseBackupHealthStatus {
  const warnings: DatabaseBackupHealthWarning[] = [];
  const now = opts.now ?? new Date();
  const maxAgeHours = Math.max(1, opts.maxAgeHours);

  let latestBackup: DatabaseBackupHealthStatus["latestBackup"] = null;
  let lastFailure: DatabaseBackupHealthStatus["lastFailure"] = null;

  try {
    const found = findLatestBackup(opts.backupDir, now.getTime());
    latestBackup = found
      ? {
          name: found.name,
          path: found.path,
          mtime: found.mtime,
          ageHours: found.ageHours,
          sizeBytes: found.sizeBytes,
        }
      : null;
    lastFailure = readLastFailure(alertFileCandidates(opts));

    if (!latestBackup) {
      warnings.push({
        code: "database_backup_missing",
        message: `No .sql.gz database backups found in ${opts.backupDir}.`,
      });
    } else if (latestBackup.ageHours > maxAgeHours) {
      warnings.push({
        code: "database_backup_stale",
        message: `Latest database backup is ${latestBackup.ageHours}h old, exceeding ${maxAgeHours}h.`,
      });
    }

    if (found && isImplausiblySmall(found)) {
      warnings.push({
        code: "database_backup_truncated",
        message: `Latest database backup ${found.name} is only ${found.sizeBytes} bytes, which is implausibly small for a finished backup. It is likely a truncated artifact of a crashed backup run.`,
      });
    }

    if (lastFailure) {
      warnings.push({
        code: "database_backup_last_failure",
        message: lastFailure.message,
      });
    }
  } catch (error) {
    warnings.push({
      code: "database_backup_check_failed",
      message: `Database backup health check failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  return {
    enabled: opts.enabled,
    status: warnings.length > 0 ? "warning" : "ok",
    backupDir: opts.backupDir,
    maxAgeHours,
    latestBackup,
    lastFailure,
    warnings,
  };
}
