import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

export interface LogTableRetentionConfig {
  table: "activity_log" | "heartbeat_run_events" | "agent_wakeup_requests";
  days: number;
}

export interface LogTableRetentionOptions {
  intervalMs?: number;
  runOnStart?: boolean;
  retention: LogTableRetentionConfig[];
}

export interface LogTableSweepResult {
  table: string;
  partitioned: boolean;
  partitionsDropped: number;
  rowsDeleted: number;
  ensuredFuturePartitions: number;
  cutoff: Date;
}

const DELETE_BATCH_SIZE = 5_000;
const MAX_DELETE_ITERATIONS = 100;

/** Default retention windows from BTCAAAAA-37815 / BTCAAAAA-37846. */
export const DEFAULT_LOG_TABLE_RETENTION: LogTableRetentionConfig[] = [
  { table: "activity_log", days: 30 },
  { table: "heartbeat_run_events", days: 14 },
  { table: "agent_wakeup_requests", days: 14 },
];

function firstRow<T>(result: unknown): T | undefined {
  const rows = (result as { rows?: T[] })?.rows
    ?? (Array.isArray(result) ? (result as T[]) : undefined);
  return rows?.[0];
}

async function isPartitioned(db: Db, table: string): Promise<boolean> {
  const result = await db.execute(
    sql`SELECT paperclip_is_table_partitioned(${table}) AS is_partitioned`,
  );
  return Boolean(firstRow<{ is_partitioned: boolean }>(result)?.is_partitioned);
}

async function ensureUpcomingPartitions(db: Db, table: string): Promise<number> {
  const result = await db.execute(
    sql`SELECT paperclip_ensure_log_partitions_window(${table}, 0, 2) AS ensured`,
  );
  return Number(firstRow<{ ensured: number }>(result)?.ensured ?? 0);
}

async function dropOldPartitions(db: Db, table: string, cutoff: Date): Promise<number> {
  const result = await db.execute(
    sql`SELECT paperclip_drop_old_log_partitions(${table}, ${cutoff.toISOString()}::timestamptz) AS dropped`,
  );
  return Number(firstRow<{ dropped: number }>(result)?.dropped ?? 0);
}

async function deleteOldRowsBatched(db: Db, table: string, cutoff: Date): Promise<number> {
  const tableIdent = sql.identifier(table);
  const cutoffIso = cutoff.toISOString();
  let total = 0;
  for (let i = 0; i < MAX_DELETE_ITERATIONS; i += 1) {
    const result = await db.execute(sql`
      WITH expired AS (
        SELECT ctid FROM ${tableIdent}
        WHERE created_at < ${cutoffIso}::timestamptz
        LIMIT ${DELETE_BATCH_SIZE}
      )
      DELETE FROM ${tableIdent} t
      USING expired
      WHERE t.ctid = expired.ctid
      RETURNING 1 AS deleted
    `);
    const rows = (result as { rows?: unknown[] })?.rows
      ?? (Array.isArray(result) ? (result as unknown[]) : []);
    const deleted = rows.length;
    total += deleted;
    if (deleted < DELETE_BATCH_SIZE) break;
  }
  return total;
}

/**
 * Sweep one log table. Partitioned tables get cheap DROP PARTITION; non-
 * partitioned tables fall back to bounded batched DELETE so legacy installs
 * still cap their growth.
 */
export async function sweepLogTable(
  db: Db,
  config: LogTableRetentionConfig,
): Promise<LogTableSweepResult> {
  const cutoff = new Date(Date.now() - config.days * 24 * 60 * 60 * 1000);
  const partitioned = await isPartitioned(db, config.table);

  let partitionsDropped = 0;
  let rowsDeleted = 0;
  let ensuredFuturePartitions = 0;

  if (partitioned) {
    ensuredFuturePartitions = await ensureUpcomingPartitions(db, config.table);
    partitionsDropped = await dropOldPartitions(db, config.table, cutoff);
  } else {
    rowsDeleted = await deleteOldRowsBatched(db, config.table, cutoff);
  }

  return {
    table: config.table,
    partitioned,
    partitionsDropped,
    rowsDeleted,
    ensuredFuturePartitions,
    cutoff,
  };
}

export async function runLogTableRetentionSweep(
  db: Db,
  retention: LogTableRetentionConfig[],
): Promise<LogTableSweepResult[]> {
  const results: LogTableSweepResult[] = [];
  for (const entry of retention) {
    if (!Number.isFinite(entry.days) || entry.days <= 0) continue;
    try {
      const result = await sweepLogTable(db, entry);
      results.push(result);
      if (
        result.partitionsDropped > 0
        || result.rowsDeleted > 0
        || result.ensuredFuturePartitions > 0
      ) {
        logger.info({ ...result }, "log-table retention sweep");
      }
    } catch (err) {
      logger.warn({ err, table: entry.table }, "log-table retention sweep failed");
    }
  }
  return results;
}

export function startLogTableRetention(
  db: Db,
  options: LogTableRetentionOptions,
): () => void {
  const intervalMs = options.intervalMs ?? 60 * 60 * 1000;
  const runOnStart = options.runOnStart ?? true;

  const tick = () => {
    runLogTableRetentionSweep(db, options.retention).catch((err) => {
      logger.warn({ err }, "log-table retention sweep crashed");
    });
  };

  const timer = setInterval(tick, intervalMs);
  const maybeUnref = timer as unknown as { unref?: () => void };
  if (typeof maybeUnref.unref === "function") maybeUnref.unref();

  if (runOnStart) tick();

  return () => clearInterval(timer);
}
