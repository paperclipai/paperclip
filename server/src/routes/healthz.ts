import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { logger } from "../middleware/logger.js";
import { serverVersion } from "../version.js";

/**
 * Minimal liveness probe at `/api/healthz` — separate from the richer
 * `/api/health` route. Designed for unauthenticated loopback callers (systemd
 * timers, container orchestrators) that just need a stable shape and a
 * 200/503 verdict after a restart.
 *
 * Shape: `{ ok, version, port, uptimeSec, dbReachable }`
 *
 * - `ok` is the only field a caller is expected to assert on.
 * - 200 when reachable and (if a db is wired) the `SELECT 1` probe succeeds.
 * - 503 when the db probe fails. `ok` is `false` in that case.
 */
export function healthzRoutes(
  db?: Db,
  opts: { port?: number } = {},
) {
  const router = Router();

  router.get("/", async (_req, res) => {
    const port =
      opts.port ??
      (process.env.PAPERCLIP_LISTEN_PORT
        ? Number(process.env.PAPERCLIP_LISTEN_PORT)
        : undefined);
    const uptimeSec = Math.round(process.uptime());

    let dbReachable = true;
    if (db) {
      try {
        await db.execute(sql`SELECT 1`);
      } catch (error) {
        logger.warn({ err: error }, "healthz database probe failed");
        dbReachable = false;
      }
    }

    const body = {
      ok: dbReachable,
      version: serverVersion,
      port,
      uptimeSec,
      dbReachable,
    };

    res.status(dbReachable ? 200 : 503).json(body);
  });

  return router;
}
