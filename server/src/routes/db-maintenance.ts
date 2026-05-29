import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { assertBoard } from "./authz.js";
import { getActorInfo } from "./authz.js";
import { logger } from "../middleware/logger.js";

interface TableStat {
  tableName: string;
  totalBytes: number;
  tableBytes: number;
  indexBytes: number;
  toastBytes: number;
  liveTuples: number;
  deadTuples: number;
  lastVacuum: string | null;
  lastAutoVacuum: string | null;
  lastAnalyze: string | null;
}

interface DiagnosticsResult {
  requestId: string;
  requestedAt: string;
  completedAt: string;
  actor: {
    actorType: string;
    actorId: string | null;
  };
  database: {
    name: string;
    totalBytes: number;
    totalBytesHuman: string;
  };
  walSize: {
    bytes: number | null;
    human: string | null;
  };
  tables: TableStat[];
  autovacuumStatus: {
    active: boolean;
    runningWorkers: Array<{ pid: number; relname: string; phase: string; blockedBy: number | null }>;
  };
}

interface MaintenanceResult {
  requestId: string;
  requestedAt: string;
  completedAt: string;
  actor: {
    actorType: string;
    actorId: string | null;
  };
  operation: string;
  success: boolean;
  error: string | null;
  beforeSizeBytes: number | null;
  afterSizeBytes: number | null;
  durationMs: number;
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function dbMaintenanceRoutes(db: Db) {
  const router = Router();

  router.get("/db/diagnostics", async (req, res) => {
    assertBoard(req);
    const actor = getActorInfo(req);
    const requestId = crypto.randomUUID();
    const requestedAt = new Date().toISOString();

    try {
      const [dbSizeRow] = await db.execute<{ db_name: string; db_bytes: string }>(
        sql`SELECT current_database() AS db_name, pg_database_size(current_database()) AS db_bytes`,
      );

      const tableRows = await db.execute<{
        table_name: string;
        total_bytes: string;
        table_bytes: string;
        index_bytes: string;
        toast_bytes: string;
        live_tup: string;
        dead_tup: string;
        last_vacuum: string | null;
        last_autovacuum: string | null;
        last_analyze: string | null;
      }>(sql`
        SELECT
          c.relname AS table_name,
          pg_total_relation_size(c.oid)::text AS total_bytes,
          pg_relation_size(c.oid)::text AS table_bytes,
          (pg_total_relation_size(c.oid) - pg_relation_size(c.oid) - COALESCE(pg_relation_size(c.reltoastrelid), 0))::text AS index_bytes,
          COALESCE(pg_relation_size(c.reltoastrelid), 0)::text AS toast_bytes,
          COALESCE(s.n_live_tup, 0)::text AS live_tup,
          COALESCE(s.n_dead_tup, 0)::text AS dead_tup,
          s.last_vacuum::text,
          s.last_autovacuum::text,
          s.last_analyze::text
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_stat_user_tables s ON s.relname = c.relname AND s.schemaname = n.nspname
        WHERE c.relkind = 'r' AND n.nspname = 'public'
        ORDER BY pg_total_relation_size(c.oid) DESC
        LIMIT 30
      `);

      let walSizeBytes: number | null = null;
      try {
        const [walRow] = await db.execute<{ wal_bytes: string }>(
          sql`SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0')::text AS wal_bytes`,
        );
        walSizeBytes = walRow ? Number(walRow.wal_bytes) : null;
      } catch {
        // WAL size query may not work on all Postgres versions
      }

      const avWorkerRows = await db.execute<{
        pid: string;
        relname: string;
        phase: string;
        blocked_by: string | null;
      }>(sql`
        SELECT
          p.pid::text,
          a.query AS relname,
          COALESCE(av.phase, 'running') AS phase,
          pg_blocking_pids(p.pid)[1]::text AS blocked_by
        FROM pg_stat_activity p
        LEFT JOIN pg_stat_progress_vacuum av ON av.pid = p.pid
        WHERE p.application_name = 'autovacuum worker'
        LIMIT 10
      `);

      const completedAt = new Date().toISOString();
      const totalBytes = Number(dbSizeRow.db_bytes);

      const result: DiagnosticsResult = {
        requestId,
        requestedAt,
        completedAt,
        actor: {
          actorType: actor.actorType,
          actorId: actor.actorId,
        },
        database: {
          name: dbSizeRow.db_name,
          totalBytes,
          totalBytesHuman: humanBytes(totalBytes),
        },
        walSize: {
          bytes: walSizeBytes,
          human: walSizeBytes !== null ? humanBytes(walSizeBytes) : null,
        },
        tables: tableRows.map((r) => ({
          tableName: r.table_name,
          totalBytes: Number(r.total_bytes),
          tableBytes: Number(r.table_bytes),
          indexBytes: Number(r.index_bytes),
          toastBytes: Number(r.toast_bytes),
          liveTuples: Number(r.live_tup),
          deadTuples: Number(r.dead_tup),
          lastVacuum: r.last_vacuum,
          lastAutoVacuum: r.last_autovacuum,
          lastAnalyze: r.last_analyze,
        })),
        autovacuumStatus: {
          active: avWorkerRows.length > 0,
          runningWorkers: avWorkerRows.map((r) => ({
            pid: Number(r.pid),
            relname: r.relname,
            phase: r.phase,
            blockedBy: r.blocked_by ? Number(r.blocked_by) : null,
          })),
        },
      };

      logger.info(
        { requestId, actorType: actor.actorType, actorId: actor.actorId, dbSizeBytes: totalBytes },
        "db.diagnostics: read-only diagnostics collected",
      );

      res.json(result);
    } catch (err) {
      logger.error({ err, requestId }, "db.diagnostics: query failed");
      res.status(500).json({ error: "diagnostics_failed", requestId });
    }
  });

  router.post("/db/maintenance", async (req, res) => {
    assertBoard(req);
    const actor = getActorInfo(req);
    const requestId = crypto.randomUUID();
    const requestedAt = new Date().toISOString();
    const body = req.body as Record<string, unknown>;
    const operation = typeof body.operation === "string" ? body.operation : "";

    const ALLOWED_OPERATIONS = ["vacuum_analyze"] as const;
    type AllowedOp = (typeof ALLOWED_OPERATIONS)[number];

    if (!ALLOWED_OPERATIONS.includes(operation as AllowedOp)) {
      res.status(400).json({
        error: "invalid_operation",
        allowed: ALLOWED_OPERATIONS,
        requestId,
      });
      return;
    }

    let beforeSizeBytes: number | null = null;
    let afterSizeBytes: number | null = null;
    const startMs = Date.now();

    try {
      const [beforeRow] = await db.execute<{ db_bytes: string }>(
        sql`SELECT pg_database_size(current_database()) AS db_bytes`,
      );
      beforeSizeBytes = Number(beforeRow.db_bytes);

      await db.execute(sql`VACUUM (ANALYZE, VERBOSE false)`);

      const [afterRow] = await db.execute<{ db_bytes: string }>(
        sql`SELECT pg_database_size(current_database()) AS db_bytes`,
      );
      afterSizeBytes = Number(afterRow.db_bytes);

      const durationMs = Date.now() - startMs;
      const completedAt = new Date().toISOString();

      logger.info(
        {
          requestId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          operation,
          beforeSizeBytes,
          afterSizeBytes,
          durationMs,
        },
        "db.maintenance: completed",
      );

      const result: MaintenanceResult = {
        requestId,
        requestedAt,
        completedAt,
        actor: { actorType: actor.actorType, actorId: actor.actorId },
        operation,
        success: true,
        error: null,
        beforeSizeBytes,
        afterSizeBytes,
        durationMs,
      };

      res.json(result);
    } catch (err) {
      const durationMs = Date.now() - startMs;
      const completedAt = new Date().toISOString();
      const errorMsg = err instanceof Error ? err.message : String(err);

      logger.error(
        { err, requestId, actorType: actor.actorType, actorId: actor.actorId, operation },
        "db.maintenance: operation failed",
      );

      res.status(500).json({
        requestId,
        requestedAt,
        completedAt,
        actor: { actorType: actor.actorType, actorId: actor.actorId },
        operation,
        success: false,
        error: errorMsg,
        beforeSizeBytes,
        afterSizeBytes,
        durationMs,
      } satisfies MaintenanceResult);
    }
  });

  return router;
}
