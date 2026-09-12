import { closeSync, createReadStream, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createGunzip } from "node:zlib";

export type DatabaseBackupHealthWarningCode =
  | "database_backup_check_failed"
  | "database_backup_empty"
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
    empty: boolean;
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

// gzip stores the uncompressed size mod 2^32 in the last 4 bytes of the
// stream (RFC 1952 ISIZE). A backup that never received real content
// (e.g. an aborted run) is a valid, small gzip stream whose ISIZE is 0 -
// that case is otherwise indistinguishable from a healthy backup by
// looking only at the compressed file size.
async function readGzipIsEmpty(filePath: string, compressedSizeBytes: number): Promise<boolean> {
  if (compressedSizeBytes < 18) return false;
  const fd = openSync(filePath, "r");
  try {
    const trailer = Buffer.alloc(4);
    readSync(fd, trailer, 0, 4, compressedSizeBytes - 4);
    if (trailer.readUInt32LE(0) !== 0) return false;
  } finally {
    closeSync(fd);
  }

  // ISIZE is stored modulo 2^32. Confirm a zero trailer by streaming the
  // archive and stopping after the first output byte. This keeps large,
  // wrapped-ISIZE backups off the synchronous health-request path and avoids
  // materializing the compressed archive in memory.
  return await new Promise<boolean>((resolvePromise, reject) => {
    const input = createReadStream(filePath);
    const gunzip = createGunzip();
    let settled = false;

    const settle = (empty: boolean) => {
      if (settled) return;
      settled = true;
      input.destroy();
      gunzip.destroy();
      resolvePromise(empty);
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      input.destroy();
      gunzip.destroy();
      reject(error);
    };

    input.on("error", fail);
    gunzip.on("error", fail);
    gunzip.once("data", () => settle(false));
    gunzip.once("end", () => settle(true));
    input.pipe(gunzip);
  });
}

async function findLatestBackup(backupDir: string, nowMs: number) {
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

  return {
    name: basename(latest.fullPath),
    path: latest.fullPath,
    mtime: new Date(latest.stat.mtimeMs).toISOString(),
    ageHours: roundHours((nowMs - latest.stat.mtimeMs) / 3_600_000),
    sizeBytes: latest.stat.size,
    empty: await readGzipIsEmpty(latest.fullPath, latest.stat.size),
  };
}

export async function inspectDatabaseBackupHealth(
  opts: InspectDatabaseBackupHealthOptions,
): DatabaseBackupHealthStatus {
  const warnings: DatabaseBackupHealthWarning[] = [];
  const now = opts.now ?? new Date();
  const maxAgeHours = Math.max(1, opts.maxAgeHours);

  let latestBackup: DatabaseBackupHealthStatus["latestBackup"] = null;
  let lastFailure: DatabaseBackupHealthStatus["lastFailure"] = null;

  try {
    latestBackup = await findLatestBackup(opts.backupDir, now.getTime());
    lastFailure = readLastFailure(alertFileCandidates(opts));

    if (!latestBackup) {
      warnings.push({
        code: "database_backup_missing",
        message: `No .sql.gz database backups found in ${opts.backupDir}.`,
      });
    } else {
      if (latestBackup.empty) {
        warnings.push({
          code: "database_backup_empty",
          message: `Latest database backup ${latestBackup.name} contains no uncompressed data.`,
        });
      }
      if (latestBackup.ageHours > maxAgeHours) {
        warnings.push({
          code: "database_backup_stale",
          message: `Latest database backup is ${latestBackup.ageHours}h old, exceeding ${maxAgeHours}h.`,
        });
      }
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
