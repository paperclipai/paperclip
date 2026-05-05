import { Router } from "express";
import Database from "better-sqlite3";

const DEFAULT_DB = "/Volumes/SSD/projects/Peper/mem0-shim/history.db";
const SHIM_HEALTH_URL = `${process.env.MEM0_SHIM_URL?.replace(/\/$/, "") ?? "http://127.0.0.1:7777"}/health`;

export function instanceMemoryRoutes() {
  const router = Router();
  const dbPath = process.env.MEM0_HISTORY_DB_PATH ?? DEFAULT_DB;

  router.use((req, res, next) => {
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board only" });
      return;
    }
    next();
  });

  router.get("/health", async (_req, res) => {
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

  return router;
}
