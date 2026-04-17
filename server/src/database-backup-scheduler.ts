import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  formatDatabaseBackupResult,
  runDatabaseBackup,
  type BackupRetentionPolicy,
  type RunDatabaseBackupOptions,
  type RunDatabaseBackupResult,
} from "@paperclipai/db";

export type DatabaseBackupLogger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export type LatestDatabaseBackup = {
  backupFile: string;
  mtimeMs: number;
};

export type StartupDatabaseBackupDecision =
  | {
      shouldRun: true;
      reason: "missing" | "stale";
      latestBackup: LatestDatabaseBackup | null;
      ageMs: number | null;
    }
  | {
      shouldRun: false;
      reason: "fresh";
      latestBackup: LatestDatabaseBackup;
      ageMs: number;
    };

export type StartDatabaseBackupSchedulerOptions = {
  connectionString: string;
  backupDir: string;
  intervalMinutes: number;
  getRetention: () => Promise<BackupRetentionPolicy>;
  logger: DatabaseBackupLogger;
  filenamePrefix?: string;
  now?: () => number;
  runBackup?: (opts: RunDatabaseBackupOptions) => Promise<RunDatabaseBackupResult>;
  formatResult?: (result: RunDatabaseBackupResult) => string;
  setInterval?: (callback: () => void, delayMs: number) => ReturnType<typeof setInterval>;
};

export type DatabaseBackupScheduler = {
  interval: ReturnType<typeof setInterval>;
  startupDecision: StartupDatabaseBackupDecision;
  startupCatchUpPromise: Promise<boolean> | null;
  runScheduledBackup: () => Promise<boolean>;
};

const DEFAULT_FILENAME_PREFIX = "paperclip";

function isBackupFileName(name: string, filenamePrefix: string): boolean {
  return name.startsWith(`${filenamePrefix}-`) && (name.endsWith(".sql") || name.endsWith(".sql.gz"));
}

function backupAgeMinutes(ageMs: number | null): number | null {
  if (ageMs === null) return null;
  return Math.round((ageMs / 60_000) * 10) / 10;
}

function latestBackupFileName(latestBackup: LatestDatabaseBackup | null): string | null {
  return latestBackup ? basename(latestBackup.backupFile) : null;
}

export function findLatestSuccessfulDatabaseBackup(
  backupDir: string,
  filenamePrefix = DEFAULT_FILENAME_PREFIX,
): LatestDatabaseBackup | null {
  if (!existsSync(backupDir)) return null;

  let names: string[];
  try {
    names = readdirSync(backupDir);
  } catch {
    return null;
  }

  let latest: LatestDatabaseBackup | null = null;
  for (const name of names) {
    if (!isBackupFileName(name, filenamePrefix)) continue;

    const backupFile = resolve(backupDir, name);
    let stats;
    try {
      stats = statSync(backupFile);
    } catch {
      continue;
    }

    if (!stats.isFile()) continue;
    if (!latest || stats.mtimeMs > latest.mtimeMs) {
      latest = { backupFile, mtimeMs: stats.mtimeMs };
    }
  }

  return latest;
}

export function getStartupDatabaseBackupDecision(opts: {
  backupDir: string;
  intervalMs: number;
  filenamePrefix?: string;
  now?: () => number;
}): StartupDatabaseBackupDecision {
  const latestBackup = findLatestSuccessfulDatabaseBackup(opts.backupDir, opts.filenamePrefix);
  if (!latestBackup) {
    return { shouldRun: true, reason: "missing", latestBackup: null, ageMs: null };
  }

  const now = opts.now?.() ?? Date.now();
  const ageMs = Math.max(0, now - latestBackup.mtimeMs);
  if (ageMs >= opts.intervalMs) {
    return { shouldRun: true, reason: "stale", latestBackup, ageMs };
  }

  return { shouldRun: false, reason: "fresh", latestBackup, ageMs };
}

export function startDatabaseBackupScheduler(opts: StartDatabaseBackupSchedulerOptions): DatabaseBackupScheduler {
  const filenamePrefix = opts.filenamePrefix ?? DEFAULT_FILENAME_PREFIX;
  const backupIntervalMs = opts.intervalMinutes * 60 * 1000;
  const backup = opts.runBackup ?? runDatabaseBackup;
  const formatResult = opts.formatResult ?? formatDatabaseBackupResult;
  const setIntervalImpl = opts.setInterval ?? setInterval;
  let backupInFlight = false;

  const runAutomaticBackup = async (trigger: "scheduled" | "startup-catchup"): Promise<boolean> => {
    if (backupInFlight) {
      if (trigger === "scheduled") {
        opts.logger.warn("Skipping scheduled database backup because a previous backup is still running");
      } else {
        opts.logger.warn(
          { backupDir: opts.backupDir },
          "Skipping startup database backup catch-up because a previous backup is still running",
        );
      }
      return false;
    }

    backupInFlight = true;
    try {
      const retention = await opts.getRetention();
      const result = await backup({
        connectionString: opts.connectionString,
        backupDir: opts.backupDir,
        retention,
        filenamePrefix,
      });
      const message =
        trigger === "startup-catchup"
          ? `Startup database backup catch-up completed: ${formatResult(result)}`
          : `Automatic database backup complete: ${formatResult(result)}`;
      opts.logger.info(
        {
          backupFile: result.backupFile,
          sizeBytes: result.sizeBytes,
          prunedCount: result.prunedCount,
          backupDir: opts.backupDir,
          retention,
        },
        message,
      );
      return true;
    } catch (err) {
      const message =
        trigger === "startup-catchup"
          ? "Startup database backup catch-up failed"
          : "Automatic database backup failed";
      opts.logger.error({ err, backupDir: opts.backupDir }, message);
      return false;
    } finally {
      backupInFlight = false;
    }
  };

  opts.logger.info(
    {
      intervalMinutes: opts.intervalMinutes,
      retentionSource: "instance-settings-db",
      backupDir: opts.backupDir,
    },
    "Automatic database backups enabled",
  );

  const startupDecision = getStartupDatabaseBackupDecision({
    backupDir: opts.backupDir,
    intervalMs: backupIntervalMs,
    filenamePrefix,
    now: opts.now,
  });
  let startupCatchUpPromise: Promise<boolean> | null = null;

  if (startupDecision.shouldRun) {
    opts.logger.info(
      {
        intervalMinutes: opts.intervalMinutes,
        backupDir: opts.backupDir,
        reason: startupDecision.reason,
        newestBackupFile: latestBackupFileName(startupDecision.latestBackup),
        newestBackupAgeMinutes: backupAgeMinutes(startupDecision.ageMs),
      },
      "Startup database backup catch-up run started",
    );
    startupCatchUpPromise = runAutomaticBackup("startup-catchup");
  } else {
    opts.logger.info(
      {
        intervalMinutes: opts.intervalMinutes,
        backupDir: opts.backupDir,
        newestBackupFile: latestBackupFileName(startupDecision.latestBackup),
        newestBackupAgeMinutes: backupAgeMinutes(startupDecision.ageMs),
      },
      "Skipping startup database backup catch-up because newest backup is fresh",
    );
  }

  const interval = setIntervalImpl(() => {
    void runAutomaticBackup("scheduled");
  }, backupIntervalMs);

  return {
    interval,
    startupDecision,
    startupCatchUpPromise,
    runScheduledBackup: () => runAutomaticBackup("scheduled"),
  };
}
