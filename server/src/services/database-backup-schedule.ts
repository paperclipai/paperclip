import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_FIRST_BACKUP_MIN_DELAY_MS = 5 * 60 * 1000;

export type LatestServerBackup = {
  name: string;
  mtimeMs: number;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Newest completed dump written by the server's own backup runner
 * (`<prefix>-YYYYMMDD-HHMMSS[-<checkpoint-id>].sql.gz`). Hand-named dumps
 * (e.g. `<prefix>-pre-deploy-...`) and in-progress `.sql` files are ignored.
 * Reads are asynchronous so slow backup storage cannot stall the event loop;
 * a missing directory resolves to null and any other read error rejects.
 */
export async function findLatestServerBackup(
  backupDir: string,
  filenamePrefix = "paperclip",
): Promise<LatestServerBackup | null> {
  const pattern = new RegExp(
    `^${escapeRegExp(filenamePrefix)}-\\d{8}-\\d{6}(?:-[0-9a-f-]+)?\\.sql\\.gz$`,
  );
  let names: string[];
  try {
    names = await readdir(backupDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let latest: LatestServerBackup | null = null;
  for (const name of names) {
    if (!pattern.test(name)) continue;
    const info = await stat(join(backupDir, name));
    if (!info.isFile()) continue;
    if (!latest || info.mtimeMs > latest.mtimeMs) {
      latest = { name, mtimeMs: info.mtimeMs };
    }
  }
  return latest;
}

export const DEFAULT_INTERRUPTED_BACKUP_BACKOFF_MS = 60 * 60 * 1000;

export type InterruptedServerBackups = {
  count: number;
  newestMtimeMs: number | null;
};

/**
 * Leftovers of server-named backup attempts newer than the latest completed
 * dump. The JavaScript engine streams `<name>.sql` before gzipping it into
 * `<name>.sql.gz`, and a staged writer may use `<name>.sql.gz.partial`; both
 * are unlinked on a handled failure, so each one left behind is an attempt
 * whose process died mid-dump (out of memory, kill). A dump killed during
 * compression leaves an older `.sql` next to the newer `.sql.gz`, which then
 * anchors the schedule instead, so it is not counted here.
 * Pass `latestBackupMtimeMs: null` to count every leftover.
 */
export async function findInterruptedServerBackups(
  backupDir: string,
  latestBackupMtimeMs: number | null,
  filenamePrefix = "paperclip",
): Promise<InterruptedServerBackups> {
  const pattern = new RegExp(
    `^${escapeRegExp(filenamePrefix)}-\\d{8}-\\d{6}(?:-[0-9a-f-]+)?\\.sql(?:\\.gz\\.partial)?$`,
  );
  let names: string[];
  try {
    names = await readdir(backupDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { count: 0, newestMtimeMs: null };
    throw err;
  }
  let count = 0;
  let newestMtimeMs: number | null = null;
  for (const name of names) {
    if (!pattern.test(name)) continue;
    const info = await stat(join(backupDir, name));
    if (!info.isFile()) continue;
    if (latestBackupMtimeMs !== null && info.mtimeMs <= latestBackupMtimeMs) continue;
    count += 1;
    if (newestMtimeMs === null || info.mtimeMs > newestMtimeMs) newestMtimeMs = info.mtimeMs;
  }
  return { count, newestMtimeMs };
}

/**
 * Delay before the first scheduled backup after boot. The schedule is anchored
 * to the previous dump, not to process start, so restarts closer together than
 * the interval cannot starve backups. An overdue (or missing) backup runs after
 * `minDelayMs` to let startup settle, unless recent attempts died mid-dump. Then
 * the retry backs off from the last interrupted attempt (1h, 2h, 4h, ... capped
 * at one interval), so a backup that kills the process cannot turn every boot
 * into another crash.
 */
export function computeFirstScheduledBackupDelayMs(opts: {
  latestBackupMtimeMs: number | null;
  nowMs: number;
  intervalMs: number;
  minDelayMs?: number;
  interruptedCount?: number;
  lastInterruptedAtMs?: number | null;
  interruptedBackoffMs?: number;
}): number {
  const intervalMs = Math.max(1, opts.intervalMs);
  const minDelayMs = Math.min(opts.minDelayMs ?? DEFAULT_FIRST_BACKUP_MIN_DELAY_MS, intervalMs);
  let delayMs = minDelayMs;
  if (opts.latestBackupMtimeMs !== null) {
    delayMs = Math.max(minDelayMs, opts.latestBackupMtimeMs + intervalMs - opts.nowMs);
  }
  const interruptedCount = opts.interruptedCount ?? 0;
  if (interruptedCount > 0 && opts.lastInterruptedAtMs != null) {
    const baseMs = opts.interruptedBackoffMs ?? DEFAULT_INTERRUPTED_BACKUP_BACKOFF_MS;
    const backoffMs = Math.min(intervalMs, baseMs * 2 ** Math.min(interruptedCount - 1, 30));
    delayMs = Math.max(delayMs, opts.lastInterruptedAtMs + backoffMs - opts.nowMs);
  }
  // A future mtime (clock skew) must not push the first run past one interval.
  return Math.min(delayMs, intervalMs);
}
