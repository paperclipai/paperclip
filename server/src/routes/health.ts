import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { count, sql } from "drizzle-orm";
import { instanceUserRoles } from "@paperclipai/db";
import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import { badRequest } from "../errors.js";
import { subsystemHealthService } from "../services/index.js";
import { assertCompanyAccess } from "./authz.js";

export function healthRoutes(
  db?: Db,
  opts: {
    databaseConnectionString?: string | null;
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    authReady: boolean;
    companyDeletionEnabled: boolean;
  } = {
    databaseConnectionString: null,
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    authReady: true,
    companyDeletionEnabled: true,
  },
) {
  const router = Router();
  const diagnostics = db
    ? subsystemHealthService(db, {
        databaseConnectionString: opts.databaseConnectionString ?? null,
        deploymentMode: opts.deploymentMode,
        deploymentExposure: opts.deploymentExposure,
        authReady: opts.authReady,
        companyDeletionEnabled: opts.companyDeletionEnabled,
      })
    : null;

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

  router.get("/subsystems", async (req, res) => {
    if (!db || !diagnostics) {
      res.status(503).json({ error: "Subsystem diagnostics are unavailable without a database." });
      return;
    }

    const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : "";
    if (!companyId) {
      throw badRequest("companyId query parameter is required");
    }
    assertCompanyAccess(req, companyId);

    const snapshot = await diagnostics.getSnapshot({ companyId });
    res.json(snapshot);
  });

  return router;
}
