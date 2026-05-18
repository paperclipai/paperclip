import { promises as fs } from "node:fs";
import path from "node:path";
import { and, lt, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  financeEvents,
  costEvents,
  activityLog,
  heartbeatRunEvents,
  heartbeatRuns,
  agentWakeupRequests,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import type { Config } from "../config.js";
import { scrubExpiredDirectExecPayloads } from "./direct-exec.js";

/** Maximum rows to delete per batch to avoid long-running transactions. */
const DELETE_BATCH_SIZE = 5_000;

/** Maximum number of batches per table per sweep. */
const MAX_ITERATIONS = 100;

/** Maximum number of orphan files to process per sweep. */
const MAX_ORPHAN_FILES = 10_000;

/** Heartbeat run statuses that indicate an in-progress run — never prune these. */
const ACTIVE_STATUSES = ["queued", "running"];

let sweepInFlight = false;

function cutoffDate(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

/**
 * Batch-delete rows from a single table that match a condition.
 * Uses a LIMIT-scoped subquery (AD1) for bounded transaction sizes.
 * Returns the total number of rows deleted.
 */
async function batchDelete(
  db: Db,
  tableName: string,
  deleteStatement: () => Promise<number>,
): Promise<number> {
  let totalDeleted = 0;
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    const deleted = await deleteStatement();
    totalDeleted += deleted;
    iterations++;
    if (deleted < DELETE_BATCH_SIZE) break;
  }

  if (iterations >= MAX_ITERATIONS) {
    logger.warn(
      { table: tableName, totalDeleted, iterations },
      "Retention hit iteration limit; some rows may remain",
    );
  }

  if (totalDeleted > 0) {
    logger.info({ table: tableName, totalDeleted }, "Pruned expired rows");
  }

  return totalDeleted;
}

/**
 * Resolve a logRef path safely within the run-logs base directory.
 * Returns null if the path would escape the base, or if it's a symlink.
 */
async function safeResolveLogFile(basePath: string, logRef: string): Promise<string | null> {
  const resolved = path.resolve(basePath, logRef);
  const base = path.resolve(basePath) + path.sep;
  if (!resolved.startsWith(base) && resolved !== path.resolve(basePath)) {
    return null;
  }
  try {
    const stat = await fs.lstat(resolved);
    if (stat.isSymbolicLink()) return null;
    return resolved;
  } catch {
    return null; // ENOENT — already gone
  }
}

/**
 * DB-driven file deletion (AD6 Stage 1).
 * Deletes log files referenced by heartbeat_runs rows that were just deleted.
 */
async function deleteLogFiles(basePath: string, logRefs: string[]): Promise<number> {
  let deleted = 0;
  for (const logRef of logRefs) {
    const filePath = await safeResolveLogFile(basePath, logRef);
    if (!filePath) continue;
    try {
      await fs.unlink(filePath);
      deleted++;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn({ err, logRef }, "Failed to delete run log file");
      }
    }
  }
  return deleted;
}

/**
 * Orphan file sweep (AD6 Stage 2).
 * Walks the run-logs directory and removes old .ndjson files
 * that no longer have corresponding DB rows.
 */
async function sweepRunLogFiles(basePath: string, cutoffMs: number): Promise<number> {
  let deleted = 0;
  let filesScanned = 0;

  async function walk(dir: string): Promise<void> {
    if (filesScanned >= MAX_ORPHAN_FILES) return;

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // directory doesn't exist or unreadable
    }

    for (const entry of entries) {
      if (filesScanned >= MAX_ORPHAN_FILES) return;
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
        // Try cleaning empty directory
        try {
          await fs.rmdir(fullPath);
        } catch {
          // not empty or already removed
        }
      } else if (entry.isFile() && entry.name.endsWith(".ndjson")) {
        filesScanned++;
        if (entry.isSymbolicLink()) continue;
        try {
          const stat = await fs.stat(fullPath);
          if (stat.mtimeMs < cutoffMs) {
            await fs.unlink(fullPath);
            deleted++;
          }
        } catch {
          // skip on error
        }
      }
    }
  }

  try {
    await walk(basePath);
  } catch {
    // basePath doesn't exist — nothing to sweep
  }

  if (deleted > 0) {
    logger.info({ deleted, filesScanned }, "Swept orphan run log files");
  }

  return deleted;
}

/**
 * Main retention function: prune expired data from all operational tables
 * in FK-safe order (plan spec T3.2), then clean up associated files.
 */
export async function pruneRunData(
  db: Db,
  config: Config,
  options?: { runLogBasePath?: string },
): Promise<void> {
  logger.info("Retention sweep started");
  const runLogBasePath = options?.runLogBasePath
    ? path.resolve(options.runLogBasePath)
    : path.resolve(resolvePaperclipInstanceRoot(), "data", "run-logs");

  const directExecScrub = await scrubExpiredDirectExecPayloads(db);
  if (directExecScrub.scrubbedThreadIds.length > 0) {
    logger.info(
      {
        scrubbedThreads: directExecScrub.scrubbedThreadIds.length,
        scrubbedContextBundles: directExecScrub.scrubbedContextBundleCount,
      },
      "Scrubbed expired direct-exec payload fields",
    );
  }

  // 1. finance_events (occurredAt, financeEventsDays)
  const financeCutoff = cutoffDate(config.retentionFinanceEventsDays);
  await batchDelete(db, "finance_events", async () => {
    const subquery = db
      .select({ id: financeEvents.id })
      .from(financeEvents)
      .where(lt(financeEvents.occurredAt, financeCutoff))
      .limit(DELETE_BATCH_SIZE);
    return db
      .delete(financeEvents)
      .where(sql`${financeEvents.id} IN (${subquery})`)
      .returning({ id: financeEvents.id })
      .then((rows) => rows.length);
  });

  // 2. cost_events (occurredAt, costEventsDays) with NOT EXISTS finance_events guard (AD2)
  const costCutoff = cutoffDate(config.retentionCostEventsDays);
  await batchDelete(db, "cost_events", async () => {
    const subquery = db
      .select({ id: costEvents.id })
      .from(costEvents)
      .where(
        and(
          lt(costEvents.occurredAt, costCutoff),
          sql`NOT EXISTS (SELECT 1 FROM finance_events WHERE finance_events.cost_event_id = ${costEvents.id})`,
        ),
      )
      .limit(DELETE_BATCH_SIZE);
    return db
      .delete(costEvents)
      .where(sql`${costEvents.id} IN (${subquery})`)
      .returning({ id: costEvents.id })
      .then((rows) => rows.length);
  });

  // 3. activity_log (createdAt, activityLogDays)
  const activityCutoff = cutoffDate(config.retentionActivityLogDays);
  await batchDelete(db, "activity_log", async () => {
    const subquery = db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(lt(activityLog.createdAt, activityCutoff))
      .limit(DELETE_BATCH_SIZE);
    return db
      .delete(activityLog)
      .where(sql`${activityLog.id} IN (${subquery})`)
      .returning({ id: activityLog.id })
      .then((rows) => rows.length);
  });

  // 4. heartbeat_run_events (createdAt, heartbeatRunEventsDays) — independent early pruning (AD3)
  const eventsCutoff = cutoffDate(config.retentionHeartbeatRunEventsDays);
  await batchDelete(db, "heartbeat_run_events", async () => {
    const subquery = db
      .select({ id: heartbeatRunEvents.id })
      .from(heartbeatRunEvents)
      .where(lt(heartbeatRunEvents.createdAt, eventsCutoff))
      .limit(DELETE_BATCH_SIZE);
    return db
      .delete(heartbeatRunEvents)
      .where(sql`${heartbeatRunEvents.id} IN (${subquery})`)
      .returning({ id: heartbeatRunEvents.id })
      .then((rows) => rows.length);
  });

  // 5. heartbeat_runs — terminal-status filter + COALESCE timestamp (AD8)
  //    Collect logRef from .returning() for DB-driven file deletion (AD6 Stage 1)
  const runsCutoff = cutoffDate(config.retentionHeartbeatRunsDays);
  const runsCutoffIso = runsCutoff.toISOString();
  const allLogRefs: string[] = [];
  await batchDelete(db, "heartbeat_runs", async () => {
    const subquery = db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(
        and(
          notInArray(heartbeatRuns.status, ACTIVE_STATUSES),
          sql`COALESCE(${heartbeatRuns.finishedAt}, ${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}) < ${runsCutoffIso}::timestamptz`,
        ),
      )
      .limit(DELETE_BATCH_SIZE);
    const rows = await db
      .delete(heartbeatRuns)
      .where(sql`${heartbeatRuns.id} IN (${subquery})`)
      .returning({ id: heartbeatRuns.id, logRef: heartbeatRuns.logRef });
    for (const row of rows) {
      if (row.logRef) allLogRefs.push(row.logRef);
    }
    return rows.length;
  });

  // AD6 Stage 1: delete log files from returned logRefs
  if (allLogRefs.length > 0) {
    const filesDeleted = await deleteLogFiles(runLogBasePath, allLogRefs);
    if (filesDeleted > 0) {
      logger.info({ filesDeleted }, "Deleted run log files (DB-driven)");
    }
  }

  // 6. agent_wakeup_requests (createdAt, agentWakeupRequestsDays) with NOT EXISTS guard (AD2)
  const wakeupCutoff = cutoffDate(config.retentionAgentWakeupRequestsDays);
  await batchDelete(db, "agent_wakeup_requests", async () => {
    const subquery = db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(
        and(
          lt(agentWakeupRequests.createdAt, wakeupCutoff),
          sql`NOT EXISTS (SELECT 1 FROM heartbeat_runs WHERE heartbeat_runs.wakeup_request_id = ${agentWakeupRequests.id})`,
        ),
      )
      .limit(DELETE_BATCH_SIZE);
    return db
      .delete(agentWakeupRequests)
      .where(sql`${agentWakeupRequests.id} IN (${subquery})`)
      .returning({ id: agentWakeupRequests.id })
      .then((rows) => rows.length);
  });

  // AD6 Stage 2: orphan file sweep
  const fileCutoffMs = cutoffDate(config.retentionRunLogFilesDays).getTime();
  await sweepRunLogFiles(runLogBasePath, fileCutoffMs);

  logger.info("Retention sweep completed");
}

/**
 * Start periodic run data retention.
 * Runs immediately on startup, then at the configured interval.
 * Returns a cleanup function to stop the interval.
 */
export function startRunDataRetention(db: Db, config: Config): () => void {
  const intervalMs = config.retentionIntervalMinutes * 60 * 1_000;

  async function sweep() {
    if (sweepInFlight) {
      logger.warn("Retention sweep already in flight, skipping");
      return;
    }
    sweepInFlight = true;
    try {
      await pruneRunData(db, config);
    } catch (err) {
      logger.warn({ err }, "Run data retention sweep failed");
    } finally {
      sweepInFlight = false;
    }
  }

  const timer = setInterval(() => {
    sweep().catch(() => {});
  }, intervalMs);

  // Run once immediately
  sweep().catch(() => {});

  return () => clearInterval(timer);
}

/** @internal — Exposed for test verification of the in-flight guard only. */
export function __testing_setSweepInFlight(value: boolean): void {
  sweepInFlight = value;
}
