import { Router } from "express";
import { readdirSync, statSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Db } from "@paperclipai/db";
import { count, sql } from "drizzle-orm";
import { instanceUserRoles } from "@paperclipai/db";
import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";

export function healthRoutes(
  db?: Db,
  opts: {
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    authReady: boolean;
    companyDeletionEnabled: boolean;
  } = {
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    authReady: true,
    companyDeletionEnabled: true,
  },
) {
  const router = Router();

  router.get("/", async (_req, res) => {
    if (!db) {
      res.json({ status: "ok" });
      return;
    }

    let bootstrapStatus: "ready" | "bootstrap_pending" = "ready";
    if (opts.deploymentMode === "authenticated") {
      const roleCount = await db
        .select({ count: count() })
        .from(instanceUserRoles)
        .where(sql`${instanceUserRoles.role} = 'instance_admin'`)
        .then((rows) => Number(rows[0]?.count ?? 0));
      bootstrapStatus = roleCount > 0 ? "ready" : "bootstrap_pending";
    }

    res.json({
      status: "ok",
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      bootstrapStatus,
      features: {
        companyDeletionEnabled: opts.companyDeletionEnabled,
      },
    });
  });

  // Temporary: list backup files for data recovery
  router.get("/backups", (_req, res) => {
    const candidates = [
      "/paperclip/instances/default/data/backups",
      "/paperclip/data/backups",
      "/paperclip/backups",
    ];
    for (const dir of candidates) {
      if (existsSync(dir)) {
        const files = readdirSync(dir)
          .filter((f) => f.endsWith(".sql"))
          .map((f) => {
            const stat = statSync(resolve(dir, f));
            return { name: f, size: stat.size, modified: stat.mtime.toISOString() };
          })
          .sort((a, b) => b.modified.localeCompare(a.modified));
        res.json({ backupDir: dir, files });
        return;
      }
    }
    res.json({ backupDir: null, files: [], searched: candidates });
  });

  return router;
}
