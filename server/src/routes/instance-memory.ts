import { Router, type RequestHandler } from "express";
import Database from "better-sqlite3";

const DEFAULT_DB = "/Volumes/SSD/projects/Peper/mem0-shim/history.db";
const SHIM_HEALTH_URL = `${process.env.MEM0_SHIM_URL?.replace(/\/$/, "") ?? "http://127.0.0.1:7777"}/health`;

type MemoryStatusPill = "green" | "yellow" | "red";

function utcDayKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function lastUtcDayKeys(days: number) {
  const keys: string[] = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = new Date(today);
    day.setUTCDate(today.getUTCDate() - i);
    keys.push(utcDayKey(day));
  }
  return keys;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))] ?? null;
}

export function instanceMemoryRoutes() {
  const router = Router();
  const dbPath = process.env.MEM0_HISTORY_DB_PATH ?? DEFAULT_DB;

  const requireBoardOrAgent: RequestHandler = (req, res, next) => {
    if (req.actor.type !== "board" && req.actor.type !== "agent") {
      res.status(403).json({ error: "Board or agent only" });
      return;
    }
    next();
  };

  const requireBoard: RequestHandler = (req, res, next) => {
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board only" });
      return;
    }
    next();
  };

  router.get("/health", requireBoardOrAgent, async (_req, res) => {
    let shimUp = false;
    let shimError: string | null = null;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const r = await fetch(SHIM_HEALTH_URL, { signal: ctrl.signal });
      clearTimeout(t);
      shimUp = r.ok;
      if (!r.ok) shimError = `shim returned ${r.status}`;
    } catch (e) {
      shimError = (e as Error).message;
    }

    let stats: {
      total24h: number;
      distinctActors24h: number;
      lastWriteAt: string | null;
      topActors: { actorId: string; count: number }[];
    } | null = null;
    let dbError: string | null = null;
    try {
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        const total = db
          .prepare(
            `SELECT COUNT(*) AS n FROM history
             WHERE created_at > datetime('now','-1 day')`,
          )
          .get() as { n: number };

        const distinct = db
          .prepare(
            `SELECT COUNT(DISTINCT actor_id) AS n FROM history
             WHERE created_at > datetime('now','-1 day')
               AND actor_id IS NOT NULL
               AND actor_id <> ''`,
          )
          .get() as { n: number };

        const last = db
          .prepare(`SELECT MAX(created_at) AS t FROM history`)
          .get() as { t: string | null };

        const top = db
          .prepare(
            `SELECT COALESCE(NULLIF(actor_id, ''), '<unattributed>') AS actor_id,
                    COUNT(*) AS count
               FROM history
              WHERE created_at > datetime('now','-1 day')
              GROUP BY actor_id
              ORDER BY count DESC
              LIMIT 5`,
          )
          .all() as { actor_id: string; count: number }[];

        stats = {
          total24h: total.n,
          distinctActors24h: distinct.n,
          lastWriteAt: last.t,
          topActors: top.map((r) => ({ actorId: r.actor_id, count: r.count })),
        };
      } finally {
        db.close();
      }
    } catch (e) {
      dbError = (e as Error).message;
    }

    let pill: "green" | "yellow" | "red";
    let reason: string | null = null;
    if (!shimUp || dbError) {
      pill = "red";
      reason = !shimUp ? `shim down: ${shimError ?? "unreachable"}` : `db read failed: ${dbError}`;
    } else if (!stats || stats.distinctActors24h < 5) {
      pill = "yellow";
      reason = stats
        ? `only ${stats.distinctActors24h} distinct actors in last 24h`
        : "no stats";
    } else {
      pill = "green";
    }

    res.json({
      shim: { up: shimUp, error: shimError, url: SHIM_HEALTH_URL },
      stats,
      dbError,
      pill,
      reason,
      generatedAt: new Date().toISOString(),
    });
  });

  router.get("/dashboard", requireBoard, async (_req, res) => {
    let db: Database.Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });

      const days = lastUtcDayKeys(14);
      const writeRows = db
        .prepare(
          `SELECT date(created_at) AS day,
                  COALESCE(NULLIF(actor_id, ''), '<unattributed>') AS actor_id,
                  COUNT(*) AS count
             FROM history
            WHERE event = 'ADD'
              AND julianday(created_at) >= julianday('now', '-13 days', 'start of day')
            GROUP BY day, actor_id
            ORDER BY day ASC, actor_id ASC`,
        )
        .all() as { day: string; actor_id: string; count: number }[];

      const actorIds = [...new Set(writeRows.map((row) => row.actor_id))].sort();
      const byKey = new Map(writeRows.map((row) => [`${row.day}:${row.actor_id}`, row.count]));
      const writesPerAgentPerDay = days.map((day) => ({
        day,
        actors: actorIds.map((actorId) => ({
          actorId,
          count: byKey.get(`${day}:${actorId}`) ?? 0,
        })),
        total: actorIds.reduce((sum, actorId) => sum + (byKey.get(`${day}:${actorId}`) ?? 0), 0),
      }));

      const searchSummary = db
        .prepare(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok,
                  SUM(CASE WHEN status = 'ok' AND result_count > 0 THEN 1 ELSE 0 END) AS hits
             FROM search_log
            WHERE julianday(created_at) >= julianday('now', '-24 hours')`,
        )
        .get() as { total: number; ok: number | null; hits: number | null };

      const latencyRows = db
        .prepare(
          `SELECT latency_ms AS latencyMs
             FROM search_log
            WHERE status = 'ok'
              AND julianday(created_at) >= julianday('now', '-24 hours')`,
        )
        .all() as { latencyMs: number }[];
      const latencies = latencyRows.map((row) => row.latencyMs);
      const totalSearches = searchSummary.total ?? 0;
      const hitSearches = searchSummary.hits ?? 0;

      const lastHealth = db
        .prepare(
          `SELECT created_at AS createdAt,
                  latency_ms AS latencyMs,
                  status,
                  components_json AS componentsJson,
                  error
             FROM health_ping_log
            ORDER BY julianday(created_at) DESC
            LIMIT 1`,
        )
        .get() as
        | {
            createdAt: string;
            latencyMs: number;
            status: string;
            componentsJson: string;
            error: string | null;
          }
        | undefined;

      let healthPill: MemoryStatusPill = "yellow";
      let healthReason: string | null = "no health pings captured";
      let components: Record<string, unknown> = {};
      if (lastHealth) {
        try {
          components = JSON.parse(lastHealth.componentsJson || "{}") as Record<string, unknown>;
        } catch {
          components = {};
        }
        const ageMs = Date.now() - new Date(lastHealth.createdAt).getTime();
        if (lastHealth.status !== "ok") {
          healthPill = "red";
          healthReason = lastHealth.error || `last health status was ${lastHealth.status}`;
        } else if (!Number.isFinite(ageMs) || ageMs > 10 * 60 * 1000) {
          healthPill = "yellow";
          healthReason = "last health ping is older than 10 minutes";
        } else {
          healthPill = "green";
          healthReason = null;
        }
      }

      res.json({
        generatedAt: new Date().toISOString(),
        source: { dbPath, healthUrl: SHIM_HEALTH_URL },
        writesPerAgentPerDay,
        recall: {
          windowHours: 24,
          totalSearches,
          hitSearches,
          hitRate: totalSearches > 0 ? hitSearches / totalSearches : null,
          latencyMs: {
            p50: percentile(latencies, 50),
            p95: percentile(latencies, 95),
          },
        },
        topRecalledMemoryKeys: {
          available: false,
          reason: "search_log records result counts but not returned memory IDs yet",
          rows: [],
        },
        health: {
          pill: healthPill,
          reason: healthReason,
          last: lastHealth
            ? {
                createdAt: lastHealth.createdAt,
                latencyMs: lastHealth.latencyMs,
                status: lastHealth.status,
                components,
                error: lastHealth.error,
              }
            : null,
        },
      });
    } catch (e) {
      res.status(500).json({
        error: "Failed to read memory dashboard",
        detail: (e as Error).message,
        generatedAt: new Date().toISOString(),
      });
    } finally {
      db?.close();
    }
  });

  return router;
}
