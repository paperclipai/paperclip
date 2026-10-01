import { lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { pluginLogs } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/** Default retention period: 7 days. */
const DEFAULT_RETENTION_DAYS = 7;

/** Maximum rows to delete per sweep to avoid long-running transactions. */
const DELETE_BATCH_SIZE = 5_000;

/** Maximum number of batches per sweep to guard against unbounded loops. */
const MAX_ITERATIONS = 100;

/**
 * Delete plugin log rows older than `retentionDays`.
 *
 * Deletes in batches of `DELETE_BATCH_SIZE` to keep transaction sizes
 * bounded and avoid holding locks for extended periods.
 *
 * @returns The total number of rows deleted.
 */
export async function prunePluginLogs(
  db: Db,
  retentionDays: number = DEFAULT_RETENTION_DAYS,
): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);

  let totalDeleted = 0;
  let iterations = 0;

  // Delete in batches to avoid long-running transactions
  while (iterations < MAX_ITERATIONS) {
    const deleted = await db
      .delete(pluginLogs)
      .where(lt(pluginLogs.createdAt, cutoff))
      .returning({ id: pluginLogs.id })
      .then((rows) => rows.length);

    totalDeleted += deleted;
    iterations++;

    if (deleted < DELETE_BATCH_SIZE) break;
  }

  if (iterations >= MAX_ITERATIONS) {
    logger.warn(
      { totalDeleted, iterations, cutoffDate: cutoff },
      "Plugin log retention hit iteration limit; some logs may remain",
    );
  }

  if (totalDeleted > 0) {
    logger.info({ totalDeleted, retentionDays }, "Pruned expired plugin logs");
  }

  return totalDeleted;
}

/**
 * Start a periodic plugin log cleanup interval.
 *
 * @param db - Database connection
 * @param intervalMs - How often to run (default: 1 hour)
 * @param retentionDays - How many days of logs to keep (default: 7)
 * @returns A cleanup function that stops the interval
 */
export function startPluginLogRetention(
  db: Db,
  intervalMs: number = 60 * 60 * 1_000,
  retentionDays: number = DEFAULT_RETENTION_DAYS,
): () => void {
  const timer = setInterval(() => {
    prunePluginLogs(db, retentionDays).catch((err) => {
      logger.warn({ err }, "Plugin log retention sweep failed");
    });
  }, intervalMs);

  // Run once immediately on startup
  prunePluginLogs(db, retentionDays).catch((err) => {
    logger.warn({ err }, "Initial plugin log retention sweep failed");
  });

  return () => clearInterval(timer);
}
