import { timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { and, count, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { heartbeatRuns, instanceUserRoles, invites } from "@paperclipai/db";
import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import { readPersistedDevServerStatus, toDevServerHealthStatus } from "../dev-server-status.js";
import { logger } from "../middleware/logger.js";
import { logFile } from "../middleware/logger.js";
import { estimateOpenConnections, renderPrometheusMetrics } from "../observability.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { serverVersion } from "../version.js";

function shouldExposeFullHealthDetails(deploymentMode: DeploymentMode, actorType: string | null | undefined): boolean {
  if (deploymentMode !== "authenticated") return true;
  return actorType === "board";
}

export function healthRoutes(
  db: Db | undefined,
  opts: {
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    allowedHostnames?: string[];
  },
) {
  const router = Router();

  function readLogSizeMb() {
    try {
      const stat = statSync(logFile);
      return stat.size / (1024 * 1024);
    } catch {
      return 0;
    }
  }

  router.get("/healthz", async (_req, res) => {
    const uptime = process.uptime();
    const memoryMb = process.memoryUsage().rss / (1024 * 1024);
    const openConnections = estimateOpenConnections();
    const logSizeMb = readLogSizeMb();
    let dbOk = true;

    if (db) {
      try {
        await db.execute(sql`SELECT 1`);
      } catch {
        dbOk = false;
      }
    }

    if (!dbOk) {
      res.status(503);
    }
    res.json({
      uptime,
      db_ok: dbOk,
      open_connections: openConnections,
      log_size_mb: Number(logSizeMb.toFixed(3)),
      memory_mb: Number(memoryMb.toFixed(3)),
    });
  });

  router.get("/metrics", (_req, res) => {
    const payload = renderPrometheusMetrics({
      logSizeMb: readLogSizeMb(),
      openConnections: estimateOpenConnections(),
    });
    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.send(payload);
  });

  router.get("/", async (req, res) => {
    const actorType = "actor" in req ? req.actor?.type : null;
    const exposeFullDetails = shouldExposeFullHealthDetails(
      opts.deploymentMode,
      actorType as string | null,
    );
    const deployment = {
      mode: opts.deploymentMode,
      exposure: opts.deploymentExposure,
    };
    let dbOk = true;

    if (db) {
      try {
        await db.execute(sql`SELECT 1`);
      } catch {
        dbOk = false;
      }
    }

    const base = {
      status: dbOk ? "ok" : "unhealthy",
      db_ok: dbOk,
      deployment,
      version: serverVersion,
    };

    if (!exposeFullDetails) {
      res.json(base);
      return;
    }

    const openConnections = estimateOpenConnections();
    const logSizeMb = readLogSizeMb();
    const memoryMb = process.memoryUsage().rss / (1024 * 1024);

    const details: Record<string, unknown> = {};
    if (db) {
      try {
        const [instanceSetting] = await Promise.all([
          instanceSettingsService.getBootstrapStatus(db),
        ]);
        details.bootstrap = instanceSetting;
      } catch (e) {
        logger.warn({ err: e }, "Health check details probe failed");
        details.error = "details_probe_failed";
      }
    }

    res.json({
      ...base,
      uptime: process.uptime(),
      memory_mb: Number(memoryMb.toFixed(3)),
      open_connections: openConnections,
      log_size_mb: Number(logSizeMb.toFixed(3)),
      ...details,
      dev_server: opts.deploymentExposure !== "public" ? toDevServerHealthStatus(readPersistedDevServerStatus()) : undefined,
    });
  });

  return router;
}
