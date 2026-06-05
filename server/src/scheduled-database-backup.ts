import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * Watchdog + single-flight guard for the built-in database backup routine.
 *
 * Root cause of NET-340/NET-341: the previous implementation set a module-level
 * in-flight flag and only cleared it in a `finally`. The scheduler awaits the
 * backup, so if `runDatabaseBackup` *hangs* (its promise never settles) the
 * `finally` never runs, the flag stays set, and every subsequent scheduled tick
 * is skipped forever — only a restart recovers it.
 *
 * This runner bounds each backup with a timeout. On timeout the wrapping promise
 * rejects, so the runner always settles and the in-flight flag is always cleared,
 * letting the next scheduled tick proceed. It also sweeps orphaned uncompressed
 * `.sql` temp dumps left behind by a hung run, and raises an alarm after N
 * consecutive scheduled skips so a wedge is noticed quickly rather than silently.
 */

export type DatabaseBackupTrigger = "scheduled" | "manual";

export interface BackupRunnerLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

export class DatabaseBackupTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`Database backup timed out after ${timeoutMs}ms`);
    this.name = "DatabaseBackupTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export interface ScheduledDatabaseBackupRunnerDeps<TResult> {
  /** Performs the actual backup. Receives the trigger so callers can branch on it. */
  runBackup: (trigger: DatabaseBackupTrigger) => Promise<TResult>;
  /** Bounded watchdog timeout in milliseconds. */
  timeoutMs: number;
  /** Directory that uncompressed temp `.sql` dumps are written into. */
  backupDir: string;
  /** Filename prefix used for temp dumps (e.g. "paperclip"). */
  filenamePrefix: string;
  logger: BackupRunnerLogger;
  /** Raise an error-level alarm after this many consecutive scheduled skips. Default 3. */
  consecutiveSkipAlarmThreshold?: number;
  /** Error to throw when a non-scheduled (manual) run collides with an in-flight backup. */
  conflictError?: (message: string) => Error;
  /** Override the orphan temp-file sweep (primarily for tests). */
  sweepOrphanTempFiles?: (backupDir: string, filenamePrefix: string) => string[];
}

/** Remove uncompressed `${prefix}-*.sql` temp dumps left behind by a failed/hung run. */
export function sweepOrphanBackupTempFiles(backupDir: string, filenamePrefix: string): string[] {
  if (!existsSync(backupDir)) return [];
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(backupDir);
  } catch {
    return removed;
  }
  for (const name of entries) {
    if (name.startsWith(`${filenamePrefix}-`) && name.endsWith(".sql")) {
      const full = join(backupDir, name);
      try {
        unlinkSync(full);
        removed.push(full);
      } catch {
        // Best effort; ignore files that vanish or can't be removed.
      }
    }
  }
  return removed;
}

export interface ScheduledDatabaseBackupRunner<TResult> {
  /** Run a backup. Returns null when a scheduled run is skipped due to an in-flight backup. */
  run: (trigger: DatabaseBackupTrigger) => Promise<TResult | null>;
  readonly isInFlight: boolean;
  readonly consecutiveSkips: number;
}

export function createScheduledDatabaseBackupRunner<TResult>(
  deps: ScheduledDatabaseBackupRunnerDeps<TResult>,
): ScheduledDatabaseBackupRunner<TResult> {
  const threshold = deps.consecutiveSkipAlarmThreshold ?? 3;
  const conflictError = deps.conflictError ?? ((message: string) => new Error(message));
  const sweep = deps.sweepOrphanTempFiles ?? sweepOrphanBackupTempFiles;

  let inFlight = false;
  let consecutiveSkips = 0;

  const run = async (trigger: DatabaseBackupTrigger): Promise<TResult | null> => {
    if (inFlight) {
      if (trigger === "scheduled") {
        consecutiveSkips += 1;
        deps.logger.warn(
          { consecutiveSkips, trigger },
          "Skipping scheduled database backup because a previous backup is still running",
        );
        if (consecutiveSkips >= threshold) {
          deps.logger.error(
            { consecutiveSkips, threshold, trigger },
            `Database backup appears wedged: ${consecutiveSkips} consecutive scheduled runs skipped`,
          );
        }
        return null;
      }
      throw conflictError("Database backup already in progress");
    }

    inFlight = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await new Promise<TResult>((resolvePromise, rejectPromise) => {
        timer = setTimeout(() => {
          rejectPromise(new DatabaseBackupTimeoutError(deps.timeoutMs));
        }, deps.timeoutMs);
        // The underlying promise may never settle (the hang we are guarding
        // against); the timeout above guarantees this wrapper still settles.
        deps.runBackup(trigger).then(resolvePromise, rejectPromise);
      });
      consecutiveSkips = 0;
      return result;
    } catch (err) {
      if (err instanceof DatabaseBackupTimeoutError) {
        const removedOrphanTempFiles = sweep(deps.backupDir, deps.filenamePrefix);
        deps.logger.error(
          { timeoutMs: deps.timeoutMs, trigger, removedOrphanTempFiles },
          `Database backup timed out after ${deps.timeoutMs}ms; aborting and clearing the in-flight flag`,
        );
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      inFlight = false;
    }
  };

  return {
    run,
    get isInFlight() {
      return inFlight;
    },
    get consecutiveSkips() {
      return consecutiveSkips;
    },
  };
}
