import { Router } from "express";
import { randomBytes } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { count, sql } from "drizzle-orm";
import { instanceUserRoles } from "@paperclipai/db";
import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";

let cachedBootstrapToken: string | undefined;

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

    // Auto-generate bootstrap token if needed
    let bootstrapInviteToken = process.env.PAPERCLIP_BOOTSTRAP_INVITE_TOKEN;
    if (bootstrapStatus === "bootstrap_pending" && !bootstrapInviteToken && !cachedBootstrapToken) {
      // Generate a random token if not already created
      cachedBootstrapToken = randomBytes(32).toString("hex");
      bootstrapInviteToken = cachedBootstrapToken;
    } else if (bootstrapStatus === "bootstrap_pending") {
      bootstrapInviteToken = cachedBootstrapToken;
    }

    res.json({
      status: "ok",
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      bootstrapStatus,
      bootstrapInviteToken: bootstrapStatus === "bootstrap_pending" ? bootstrapInviteToken : undefined,
      features: {
        companyDeletionEnabled: opts.companyDeletionEnabled,
      },
    });
  });

  return router;
}
