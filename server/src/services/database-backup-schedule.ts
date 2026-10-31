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

/**
 * Delay before the first scheduled backup after boot. The schedule is anchored
 * to the previous dump, not to process start, so restarts closer together than
 * the interval cannot starve backups. An overdue (or missing) backup runs after
 * `minDelayMs` to let startup settle.
 */
export function computeFirstScheduledBackupDelayMs(opts: {
  latestBackupMtimeMs: number | null;
  nowMs: number;
  intervalMs: number;
  minDelayMs?: number;
}): number {
  const intervalMs = Math.max(1, opts.intervalMs);
  const minDelayMs = Math.min(opts.minDelayMs ?? DEFAULT_FIRST_BACKUP_MIN_DELAY_MS, intervalMs);
  if (opts.latestBackupMtimeMs === null) return minDelayMs;
  const dueInMs = opts.latestBackupMtimeMs + intervalMs - opts.nowMs;
  // A future mtime (clock skew) must not push the first run past one interval.
  return Math.min(Math.max(minDelayMs, dueInMs), intervalMs);
}
