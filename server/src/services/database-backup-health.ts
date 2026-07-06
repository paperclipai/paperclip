import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

export type DatabaseBackupHealthWarningCode =
  | "database_backup_check_failed"
  | "database_backup_clock_skew"
  | "database_backup_corrupt"
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
  now?: Date;
};

function roundHours(value: number): number {
  return Math.round(value * 10) / 10;
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function readLastFailure(alertFile: string | undefined) {
  if (!alertFile) return null;

  try {
    const [alertStat, contents] = await Promise.all([
      stat(alertFile),
      readFile(alertFile, "utf8"),
    ]);
    const message = contents.trim().split(/\r?\n/)[0] || "Database backup failure marker is present.";
    return {
      path: alertFile,
      mtime: new Date(alertStat.mtimeMs).toISOString(),
      message,
    };
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

type ArchiveIntegrityCacheEntry = { size: number; mtimeMs: number; complete: boolean };

const archiveIntegrityCache = new Map<string, ArchiveIntegrityCacheEntry>();

// A complete gzip stream ends with a valid CRC/length trailer, so a full
// decompress pass proves the producer finished writing — including external
// backup jobs that stream straight to `<name>.sql.gz` without Paperclip's
// `.partial` staging convention. Verdicts are cached by (size, mtime) so
// repeated /health polls do not re-decompress unchanged archives.
async function isCompleteGzipArchive(
  fullPath: string,
  size: number,
  mtimeMs: number,
): Promise<boolean> {
  const cached = archiveIntegrityCache.get(fullPath);
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached.complete;

  let complete = false;
  try {
    await pipeline(
      createReadStream(fullPath),
      createGunzip(),
      new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
    );
    complete = true;
  } catch {
    complete = false;
  }
  archiveIntegrityCache.set(fullPath, { size, mtimeMs, complete });
  return complete;
}

type LatestBackupScan = {
  latest: NonNullable<DatabaseBackupHealthStatus["latestBackup"]> | null;
  corruptNames: string[];
};

async function findLatestBackup(backupDir: string, nowMs: number): Promise<LatestBackupScan> {
  let names: string[];
  try {
    names = await readdir(backupDir);
  } catch (error) {
    if (isMissingFileError(error)) return { latest: null, corruptNames: [] };
    throw error;
  }

  const candidates: { fullPath: string; mtimeMs: number; size: number }[] = [];
  for (const name of names) {
    if (!name.endsWith(".sql.gz")) continue;
    const fullPath = join(backupDir, name);
    let fileStat;
    try {
      fileStat = await stat(fullPath);
    } catch (error) {
      if (isMissingFileError(error)) continue;
      throw error;
    }
    // Zero-byte archives are failed dumps; in-progress `.sql.gz.partial`
    // staging files are excluded by the extension filter above.
    if (fileStat.size === 0) continue;
    candidates.push({ fullPath, mtimeMs: fileStat.mtimeMs, size: fileStat.size });
  }

  const candidatePaths = new Set(candidates.map((candidate) => candidate.fullPath));
  for (const key of archiveIntegrityCache.keys()) {
    if (key.startsWith(backupDir) && !candidatePaths.has(key)) {
      archiveIntegrityCache.delete(key);
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const corruptNames: string[] = [];
  for (const candidate of candidates) {
    if (await isCompleteGzipArchive(candidate.fullPath, candidate.size, candidate.mtimeMs)) {
      return {
        latest: {
          name: basename(candidate.fullPath),
          path: candidate.fullPath,
          mtime: new Date(candidate.mtimeMs).toISOString(),
          ageHours: roundHours((nowMs - candidate.mtimeMs) / 3_600_000),
          sizeBytes: candidate.size,
        },
        corruptNames,
      };
    }
    corruptNames.push(basename(candidate.fullPath));
  }

  return { latest: null, corruptNames };
}

export async function inspectDatabaseBackupHealth(
  opts: InspectDatabaseBackupHealthOptions,
): Promise<DatabaseBackupHealthStatus> {
  const warnings: DatabaseBackupHealthWarning[] = [];
  const now = opts.now ?? new Date();
  const maxAgeHours =
    Number.isFinite(opts.maxAgeHours) && opts.maxAgeHours > 0 ? opts.maxAgeHours : 1;

  let latestBackup: DatabaseBackupHealthStatus["latestBackup"] = null;
  let lastFailure: DatabaseBackupHealthStatus["lastFailure"] = null;

  try {
    const [scan, failure] = await Promise.all([
      findLatestBackup(opts.backupDir, now.getTime()),
      readLastFailure(opts.alertFile),
    ]);
    latestBackup = scan.latest;
    lastFailure = failure;

    if (!latestBackup) {
      warnings.push({
        code: "database_backup_missing",
        message: `No complete non-empty .sql.gz database backups found in ${opts.backupDir}.`,
      });
    } else if (latestBackup.ageHours < 0) {
      warnings.push({
        code: "database_backup_clock_skew",
        message: `Latest database backup timestamp ${latestBackup.mtime} is in the future; backup freshness cannot be verified (check system clock).`,
      });
    } else if (latestBackup.ageHours > maxAgeHours) {
      warnings.push({
        code: "database_backup_stale",
        message: `Latest database backup is ${latestBackup.ageHours}h old, exceeding ${maxAgeHours}h.`,
      });
    }

    if (scan.corruptNames.length > 0) {
      warnings.push({
        code: "database_backup_corrupt",
        message: `Ignored ${scan.corruptNames.length} truncated/corrupt .sql.gz backup archive(s) with incomplete gzip streams: ${scan.corruptNames.join(", ")}.`,
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
