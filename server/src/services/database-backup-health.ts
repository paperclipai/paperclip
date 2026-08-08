import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export type DatabaseBackupHealthWarningCode =
  | "database_backup_check_failed"
  | "database_backup_last_failure"
  | "database_backup_missing"
  | "database_backup_stale"
  | "database_backup_too_small";

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
  minSizeBytes?: number;
  alertFile?: string;
  alertFiles?: string[];
  now?: Date;
};

// A gzip pipeline killed mid-run leaves a header-only .sql.gz of a few dozen
// bytes; any real backup of a migrated database compresses to far more than
// this floor. The relative check catches fresh-but-hollow backups that clear
// the floor yet collapsed versus recent history.
const DEFAULT_MIN_BACKUP_SIZE_BYTES = 1024;
const RECENT_BACKUP_MEDIAN_SAMPLE = 8;
const MIN_BACKUPS_FOR_MEDIAN_CHECK = 3;
const MEDIAN_SIZE_WARNING_FRACTION = 0.1;

function roundHours(value: number): number {
  return Math.round(value * 10) / 10;
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
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

function listBackups(backupDir: string) {
  if (!existsSync(backupDir)) return [];

  return readdirSync(backupDir)
    .filter((name) => name.endsWith(".sql.gz"))
    .map((name) => {
      const fullPath = join(backupDir, name);
      const stat = statSync(fullPath);
      return { fullPath, name, stat };
    })
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
}

function findLatestBackup(backups: ReturnType<typeof listBackups>, nowMs: number) {
  const latest = backups[0];
  if (!latest) return null;

  return {
    name: basename(latest.fullPath),
    path: latest.fullPath,
    mtime: new Date(latest.stat.mtimeMs).toISOString(),
    ageHours: roundHours((nowMs - latest.stat.mtimeMs) / 3_600_000),
    sizeBytes: latest.stat.size,
  };
}

/**
 * Groups backups into streams by filename prefix (`paperclip-20260803-071500.sql.gz`
 * → `paperclip`). Sweep and retention treat each prefix as its own stream, so
 * the median comparison must too — a shared directory can hold e.g. CLI and
 * scheduled backups of very different sizes, and mixing them would let one
 * stream mask or fake a collapse in the other. Names without the timestamp
 * pattern fall back to the full name, i.e. they never share a stream.
 */
function backupStreamKey(name: string): string {
  return name.replace(/-\d{8}-\d{6}\.sql\.gz$/, "");
}

function findImplausibleSizeWarning(
  backups: ReturnType<typeof listBackups>,
  latestBackup: NonNullable<DatabaseBackupHealthStatus["latestBackup"]>,
  minSizeBytes: number,
): DatabaseBackupHealthWarning | null {
  if (latestBackup.sizeBytes < minSizeBytes) {
    return {
      code: "database_backup_too_small",
      message: `Latest database backup ${latestBackup.name} is ${latestBackup.sizeBytes} bytes, below the minimum plausible size of ${minSizeBytes} bytes.`,
    };
  }

  const latestStream = backupStreamKey(latestBackup.name);
  const priorSizes = backups
    .slice(1)
    .filter((entry) => backupStreamKey(entry.name) === latestStream)
    .slice(0, RECENT_BACKUP_MEDIAN_SAMPLE)
    .map((entry) => entry.stat.size);
  if (priorSizes.length < MIN_BACKUPS_FOR_MEDIAN_CHECK) return null;

  const median = medianOf(priorSizes);
  if (latestBackup.sizeBytes >= median * MEDIAN_SIZE_WARNING_FRACTION) return null;

  return {
    code: "database_backup_too_small",
    message: `Latest database backup ${latestBackup.name} is ${latestBackup.sizeBytes} bytes, under 10% of the recent median backup size of ${Math.round(median)} bytes.`,
  };
}

export function inspectDatabaseBackupHealth(
  opts: InspectDatabaseBackupHealthOptions,
): DatabaseBackupHealthStatus {
  const warnings: DatabaseBackupHealthWarning[] = [];
  const now = opts.now ?? new Date();
  const maxAgeHours = Math.max(1, opts.maxAgeHours);
  const minSizeBytes = Math.max(1, opts.minSizeBytes ?? DEFAULT_MIN_BACKUP_SIZE_BYTES);

  let latestBackup: DatabaseBackupHealthStatus["latestBackup"] = null;
  let lastFailure: DatabaseBackupHealthStatus["lastFailure"] = null;

  try {
    const backups = listBackups(opts.backupDir);
    latestBackup = findLatestBackup(backups, now.getTime());
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

    // A fresh-but-empty backup passes the age check while being useless for
    // restore, so plausible size is verified independently of staleness.
    if (latestBackup) {
      const sizeWarning = findImplausibleSizeWarning(backups, latestBackup, minSizeBytes);
      if (sizeWarning) warnings.push(sizeWarning);
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
