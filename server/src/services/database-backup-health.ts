import { readdir, readFile, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, join, resolve } from "node:path";

export type DatabaseBackupHealthWarningCode =
  | "database_backup_check_failed"
  | "database_backup_last_failure"
  | "database_backup_missing"
  | "database_backup_stale";

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

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function readLastFailure(alertFiles: string[]) {
  const failures = (await Promise.all(alertFiles.map(async (alertFile) => {
    try {
      const metadata = await stat(alertFile);
      const message = (await readFile(alertFile, "utf8")).trim().split(/\r?\n/)[0] ||
        "Database backup failure marker is present.";
      return {
        path: alertFile,
        mtime: new Date(metadata.mtimeMs).toISOString(),
        mtimeMs: metadata.mtimeMs,
        message,
      };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  })))
    .filter((failure) => failure !== null)
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  const latest = failures[0];
  if (!latest) return null;
  return {
    path: latest.path,
    mtime: latest.mtime,
    message: latest.message,
  };
}

async function findLatestBackup(backupDir: string, nowMs: number) {
  let names: string[];
  try {
    names = await readdir(backupDir);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  let latest: { fullPath: string; stat: Stats } | null = null;
  // Keep bounded parallelism so a retained history neither floods the
  // filesystem thread pool nor waits for every metadata read sequentially.
  const archives = names.filter((name) => name.endsWith(".sql.gz"));
  for (let index = 0; index < archives.length; index += 4) {
    const batch = await Promise.all(archives.slice(index, index + 4).map(async (name) => {
      const fullPath = join(backupDir, name);
      try {
        return { fullPath, stat: await stat(fullPath) };
      } catch (error) {
        // Retention can remove a listed backup while its metadata is read.
        if (isMissing(error)) return null;
        throw error;
      }
    }));
    for (const candidate of batch) {
      if (candidate && (!latest || candidate.stat.mtimeMs > latest.stat.mtimeMs)) {
        latest = candidate;
      }
    }
  }
  if (!latest) return null;

  return {
    name: basename(latest.fullPath),
    path: latest.fullPath,
    mtime: new Date(latest.stat.mtimeMs).toISOString(),
    ageHours: roundHours((nowMs - latest.stat.mtimeMs) / 3_600_000),
    sizeBytes: latest.stat.size,
  };
}

export async function inspectDatabaseBackupHealth(
  opts: InspectDatabaseBackupHealthOptions,
): Promise<DatabaseBackupHealthStatus> {
  const warnings: DatabaseBackupHealthWarning[] = [];
  const now = opts.now ?? new Date();
  const maxAgeHours = Math.max(1, opts.maxAgeHours);

  let latestBackup: DatabaseBackupHealthStatus["latestBackup"] = null;
  let lastFailure: DatabaseBackupHealthStatus["lastFailure"] = null;

  try {
    latestBackup = await findLatestBackup(opts.backupDir, now.getTime());
    lastFailure = await readLastFailure(alertFileCandidates(opts));

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
