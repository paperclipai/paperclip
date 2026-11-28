import { existsSync } from "node:fs";
import { formatDatabaseBackupResult, runDatabaseBackup, type BackupRetentionPolicy } from "@paperclipai/db";
import { conflict } from "../errors.js";
import type { InstanceDatabaseBackupRunResult, InstanceDatabaseBackupTrigger } from "../routes/instance-database-backups.js";
import { beginIdleTrackedWork } from "./task-admission.js";
import { clearIdleBackupWakeRequired, idleBackupWakeMarker, markIdleBackupWakeRequired, verifyIdleDatabaseBackup } from "./idle-database-backup.js";

type BackupLogger = {
  info: (details: object, message: string) => void;
  warn: (message: string) => void;
  error: (details: object, message: string) => void;
};

export function createDatabaseBackupOwner(options: {
  /** Static connection string, or a resolver that produces the current one per
   * run (e.g. copying a rotated file-backed password in, target-checked). */
  connectionString: string | (() => Promise<string>);
  backupDir: string;
  getRetention: () => Promise<BackupRetentionPolicy>;
  logger: BackupLogger;
}) {
  let databaseBackupInFlight = false;
  return async (
    trigger: InstanceDatabaseBackupTrigger,
  ): Promise<InstanceDatabaseBackupRunResult | null> => {
    if (databaseBackupInFlight) {
      const message = "Database backup already in progress";
      if (trigger === "scheduled") {
        options.logger.warn("Skipping scheduled database backup because a previous backup is still running");
        return null;
      }
      throw conflict(message);
    }

    databaseBackupInFlight = true;
    const finishIdleBackup = beginIdleTrackedWork();
    const startedAt = new Date();
    const startedAtMs = Date.now();
    const label = trigger === "manual" ? "Manual" : trigger === "idle" ? "Pre-sleep" : "Automatic";
    try {
      if (trigger === "idle") await markIdleBackupWakeRequired(options.backupDir);
      options.logger.info({ backupDir: options.backupDir, trigger }, `${label} database backup starting`);
      const retention = await options.getRetention();
      const verifyCheckpoint = trigger === "idle" || existsSync(idleBackupWakeMarker(options.backupDir));
      const connectionString = typeof options.connectionString === "function"
        ? await options.connectionString()
        : options.connectionString;

      const result = await runDatabaseBackup({
        connectionString,
        backupDir: options.backupDir,
        retention,
        filenamePrefix: "paperclip",
        verifyBeforePrune: verifyCheckpoint ? verifyIdleDatabaseBackup : undefined,
      });
      if (verifyCheckpoint) {
        if (trigger !== "idle") await clearIdleBackupWakeRequired(options.backupDir);
      }
      const finishedAt = new Date();
      const response: InstanceDatabaseBackupRunResult = {
        ...result,
        trigger,
        backupDir: options.backupDir,
        retention,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: Date.now() - startedAtMs,
      };
      options.logger.info(
        {
          backupFile: result.backupFile,
          sizeBytes: result.sizeBytes,
          prunedCount: result.prunedCount,
          backupDir: options.backupDir,
          retention,
          trigger,
          durationMs: response.durationMs,
        },
        `${label} database backup complete: ${formatDatabaseBackupResult(result)}`,
      );
      return response;
    } catch (err) {
      options.logger.error({ err, backupDir: options.backupDir, trigger }, `${label} database backup failed`);
      throw err;
    } finally {
      databaseBackupInFlight = false;
      finishIdleBackup();
    }
  };
}
