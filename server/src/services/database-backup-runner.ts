import {
  formatDatabaseBackupResult,
  pruneOldBackups,
  runDatabaseBackup,
  type BackupRetentionPolicy,
  type RunDatabaseBackupResult,
} from "@paperclipai/db";
import {
  ConsecutiveSkipCounter,
  evaluateBackupDiskPressure,
  type DiskPressureResult,
} from "@paperclipai/shared/disk-monitor";
import type {
  InstanceDatabaseBackupRunResult,
  InstanceDatabaseBackupTrigger,
} from "../routes/instance-database-backups.js";

const AGGRESSIVE_PRUNE_RETENTION: BackupRetentionPolicy = {
  dailyDays: 1,
  weeklyWeeks: 1,
  monthlyMonths: 0,
};

const DEFAULT_FILENAME_PREFIX = "paperclip";

export type DatabaseBackupRunnerLogger = {
  info: (obj: Record<string, unknown> | string, msg?: string) => void;
  warn: (obj: Record<string, unknown> | string, msg?: string) => void;
  error: (obj: Record<string, unknown> | string, msg?: string) => void;
};

export type DatabaseBackupRunnerBackupSettings = {
  getGeneral(): Promise<{ backupRetention: BackupRetentionPolicy }>;
};

export type DatabaseBackupRunnerDeps = {
  connectionString: string;
  backupDir: string;
  filenamePrefix?: string;
  backupSettings: DatabaseBackupRunnerBackupSettings;
  logger: DatabaseBackupRunnerLogger;
  runBackup?: typeof runDatabaseBackup;
  prune?: typeof pruneOldBackups;
  evaluateDiskPressure?: (targetPath: string) => Promise<DiskPressureResult>;
  skipCounter?: ConsecutiveSkipCounter;
  onConflict?: (message: string) => Error;
  now?: () => number;
};

export type DatabaseBackupRunnerResult =
  | (InstanceDatabaseBackupRunResult & { skipped?: false })
  | (Pick<RunDatabaseBackupResult, "backupFile" | "sizeBytes" | "prunedCount"> & {
      trigger: InstanceDatabaseBackupTrigger;
      backupDir: string;
      retention: BackupRetentionPolicy;
      startedAt: string;
      finishedAt: string;
      durationMs: number;
      skipped: true;
      skipReason: "low_disk";
      freeGiB: number;
      thresholdGiB: number;
    });

export type DatabaseBackupRunner = {
  run(trigger: InstanceDatabaseBackupTrigger): Promise<DatabaseBackupRunnerResult | null>;
};

function defaultConflict(message: string): Error {
  const err = new Error(message) as Error & { statusCode?: number };
  err.statusCode = 409;
  return err;
}

export function createDatabaseBackupRunner(deps: DatabaseBackupRunnerDeps): DatabaseBackupRunner {
  const filenamePrefix = deps.filenamePrefix ?? DEFAULT_FILENAME_PREFIX;
  const runBackup = deps.runBackup ?? runDatabaseBackup;
  const prune = deps.prune ?? pruneOldBackups;
  const evaluateDiskPressure =
    deps.evaluateDiskPressure ?? ((targetPath: string) => evaluateBackupDiskPressure({ targetPath }));
  const skipCounter = deps.skipCounter ?? new ConsecutiveSkipCounter();
  const conflict = deps.onConflict ?? defaultConflict;
  const now = deps.now ?? Date.now;
  let inFlight = false;

  return {
    async run(trigger) {
      if (inFlight) {
        const message = "Database backup already in progress";
        if (trigger === "scheduled") {
          deps.logger.warn(
            { backupDir: deps.backupDir, trigger },
            "Skipping scheduled database backup because a previous backup is still running",
          );
          return null;
        }
        throw conflict(message);
      }

      inFlight = true;
      const startedAtMs = now();
      const startedAt = new Date(startedAtMs);
      const label = trigger === "scheduled" ? "Automatic" : "Manual";

      try {
        deps.logger.info({ backupDir: deps.backupDir, trigger }, `${label} database backup starting`);

        const pressure = await evaluateDiskPressure(deps.backupDir);

        if (pressure.skip) {
          const skipState = skipCounter.recordSkip();
          deps.logger.warn(
            {
              backupDir: deps.backupDir,
              trigger,
              freeGiB: pressure.freeGiB,
              thresholdGiB: pressure.minFreeGiB,
              consecutiveSkips: skipState.count,
            },
            `backup_skipped_low_disk freeGiB=${pressure.freeGiB.toFixed(2)} thresholdGiB=${pressure.minFreeGiB}`,
          );
          if (skipState.shouldEmitPauseLog) {
            deps.logger.error(
              {
                backupDir: deps.backupDir,
                trigger,
                freeGiB: pressure.freeGiB,
                thresholdGiB: pressure.minFreeGiB,
                consecutiveSkips: skipState.count,
              },
              "backup_paused_low_disk",
            );
          }
          const finishedAtMs = now();
          return {
            trigger,
            backupDir: deps.backupDir,
            retention: AGGRESSIVE_PRUNE_RETENTION,
            startedAt: startedAt.toISOString(),
            finishedAt: new Date(finishedAtMs).toISOString(),
            durationMs: finishedAtMs - startedAtMs,
            backupFile: "",
            sizeBytes: 0,
            prunedCount: 0,
            skipped: true,
            skipReason: "low_disk" as const,
            freeGiB: pressure.freeGiB,
            thresholdGiB: pressure.minFreeGiB,
          };
        }

        skipCounter.recordSuccess();

        const generalSettings = await deps.backupSettings.getGeneral();
        const baseRetention = generalSettings.backupRetention;
        const retention = pressure.aggressivePrune ? AGGRESSIVE_PRUNE_RETENTION : baseRetention;

        if (pressure.aggressivePrune) {
          deps.logger.warn(
            {
              backupDir: deps.backupDir,
              trigger,
              freeGiB: pressure.freeGiB,
              thresholdGiB: pressure.aggressivePruneGiB,
              retention,
            },
            "aggressive_prune_triggered",
          );
        }

        const preBackupPrunedCount = prune(deps.backupDir, retention, filenamePrefix);
        deps.logger.info(
          { backupDir: deps.backupDir, trigger, preBackupPrunedCount, retention },
          "Pre-backup prune complete",
        );

        const result = await runBackup({
          connectionString: deps.connectionString,
          backupDir: deps.backupDir,
          retention,
          filenamePrefix,
        });

        const finishedAtMs = now();
        const totalPrunedCount = preBackupPrunedCount + result.prunedCount;
        const response: InstanceDatabaseBackupRunResult = {
          ...result,
          prunedCount: totalPrunedCount,
          trigger,
          backupDir: deps.backupDir,
          retention,
          startedAt: startedAt.toISOString(),
          finishedAt: new Date(finishedAtMs).toISOString(),
          durationMs: finishedAtMs - startedAtMs,
        };
        deps.logger.info(
          {
            backupFile: result.backupFile,
            sizeBytes: result.sizeBytes,
            prunedCount: totalPrunedCount,
            backupDir: deps.backupDir,
            retention,
            trigger,
            durationMs: response.durationMs,
          },
          `${label} database backup complete: ${formatDatabaseBackupResult({
            ...result,
            prunedCount: totalPrunedCount,
          })}`,
        );
        return response;
      } catch (err) {
        deps.logger.error({ err, backupDir: deps.backupDir, trigger }, `${label} database backup failed`);
        throw err;
      } finally {
        inFlight = false;
      }
    },
  };
}
