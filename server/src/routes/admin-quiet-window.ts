import { Router, type Request as ExpressRequest } from "express";
import type { Db } from "@paperclipai/db";
import { count, inArray, sql } from "drizzle-orm";
import { heartbeatRuns } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/**
 * Loopback-first administrative probe at `/api/admin/quiet-window`.
 *
 * Designed for the roclaw `paperclip-gce-deployer` pull-based deploy unit:
 * the timer hits this endpoint every ~1 minute and only issues
 * `systemctl --user restart paperclip.service` when `safeToRestart === true`.
 *
 * Shape:
 * ```
 * {
 *   checkedOutCount: number,
 *   oldestRunStartedAt: string | null, // ISO timestamp
 *   safeToRestart: boolean             // checkedOutCount === 0
 * }
 * ```
 *
 * Access rules:
 * - Loopback callers (127.0.0.1, ::1, ::ffff:127.0.0.1, or unix socket) are
 *   always allowed.
 * - Non-loopback callers must be an authenticated board actor whose grant
 *   did not come from the `local_trusted` implicit-board path. This prevents
 *   the Tailscale-exposed `local_trusted` deployment from silently letting
 *   any LAN/Tailscale caller hit the probe.
 *
 * Source: `heartbeatRuns` where `status in ('queued', 'running')`. This
 * mirrors `activeRunCount` already computed in `health.ts`, but in a
 * dedicated, stable-shape endpoint the deployer can scrape cheaply.
 */

const LOOPBACK_ADDRESSES = new Set([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
]);

function isLoopbackRequest(req: ExpressRequest): boolean {
  const ip = req.ip;
  if (typeof ip === "string" && LOOPBACK_ADDRESSES.has(ip)) return true;

  const socketAddress = req.socket.remoteAddress;
  if (typeof socketAddress === "string" && LOOPBACK_ADDRESSES.has(socketAddress)) {
    return true;
  }

  // Unix-domain sockets and tests using `request(app)` won't have a remote
  // address. Treat absent remote-address as loopback — it cannot have come
  // from off-host.
  if (!socketAddress && (!ip || ip === "")) return true;

  return false;
}

function isAuthenticatedAdmin(req: ExpressRequest): boolean {
  const actor = "actor" in req ? req.actor : null;
  if (!actor || actor.type !== "board") return false;
  // The `local_trusted` deployment mode auto-grants every request as
  // `board` via `local_implicit`. That's fine for loopback, but we don't
  // want it counting as an authenticated admin for off-host calls.
  if ((actor as { source?: string }).source === "local_implicit") return false;
  return true;
}

export function adminQuietWindowRoutes(db?: Db) {
  const router = Router();

  router.get("/", async (req, res) => {
    if (!isLoopbackRequest(req) && !isAuthenticatedAdmin(req)) {
      res.status(403).json({ error: "loopback_only" });
      return;
    }

    if (!db) {
      // No DB wired (test/bootstrap): nothing is checked out, by definition.
      res.json({
        checkedOutCount: 0,
        oldestRunStartedAt: null,
        safeToRestart: true,
      });
      return;
    }

    try {
      const rows = await db
        .select({
          checkedOutCount: count(),
          oldestStartedAt: sql<Date | string | null>`MIN(${heartbeatRuns.startedAt})`,
        })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.status, ["queued", "running"]));

      const checkedOutCount = Number(rows[0]?.checkedOutCount ?? 0);
      const oldestRaw = rows[0]?.oldestStartedAt ?? null;
      const oldestRunStartedAt =
        oldestRaw instanceof Date
          ? oldestRaw.toISOString()
          : typeof oldestRaw === "string" && oldestRaw.length > 0
            ? new Date(oldestRaw).toISOString()
            : null;

      res.json({
        checkedOutCount,
        oldestRunStartedAt,
        safeToRestart: checkedOutCount === 0,
      });
    } catch (error) {
      logger.warn({ err: error }, "quiet-window probe database query failed");
      res.status(503).json({ error: "database_unreachable" });
    }
  });

  return router;
}
