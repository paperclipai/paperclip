import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { and, count, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { heartbeatRuns, instanceUserRoles, invites } from "@paperclipai/db";
import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import { readPersistedDevServerStatus, toDevServerHealthStatus } from "../dev-server-status.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { serverVersion } from "../version.js";
import { assertBoard } from "./authz.js";

export function healthRoutes(
  db?: Db,
  opts: {
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    authReady: boolean;
    companyDeletionEnabled: boolean;
    emailEnabled: boolean;
    socialProviders: string[];
    cloudSandboxEnabled: boolean;
    managedInferenceEnabled: boolean;
  } = {
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    authReady: true,
    companyDeletionEnabled: true,
    emailEnabled: false,
    socialProviders: [],
    cloudSandboxEnabled: false,
    managedInferenceEnabled: false,
  },
) {
  const router = Router();

  // Public, no auth required — includes deploymentMode so the UI knows
  // whether to redirect to /auth before the user has a session.
  router.get("/", async (_req, res) => {
    res.json({
      status: "ok",
      version: serverVersion,
      deploymentMode: opts.deploymentMode,
      features: {
        socialProviders: opts.socialProviders,
      },
    });
  });

  // Authenticated — full details
  router.get("/details", async (req, res) => {
    assertBoard(req);

    if (!db) {
      res.json({ status: "ok", version: serverVersion });
      return;
    }

    try {
      await db.execute(sql`SELECT 1`);
    } catch {
      res.status(503).json({
        status: "unhealthy",
        version: serverVersion,
        error: "database_unreachable",
      });
      return;
    }

    let bootstrapStatus: "ready" | "bootstrap_pending" = "ready";
    let bootstrapInviteActive = false;
    if (opts.deploymentMode === "authenticated") {
      const roleCount = await db
        .select({ count: count() })
        .from(instanceUserRoles)
        .where(sql`${instanceUserRoles.role} = 'instance_admin'`)
        .then((rows) => Number(rows[0]?.count ?? 0));
      bootstrapStatus = roleCount > 0 ? "ready" : "bootstrap_pending";

      if (bootstrapStatus === "bootstrap_pending") {
        const now = new Date();
        const inviteCount = await db
          .select({ count: count() })
          .from(invites)
          .where(
            and(
              eq(invites.inviteType, "bootstrap_ceo"),
              isNull(invites.revokedAt),
              isNull(invites.acceptedAt),
              gt(invites.expiresAt, now),
            ),
          )
          .then((rows) => Number(rows[0]?.count ?? 0));
        bootstrapInviteActive = inviteCount > 0;
      }
    }

    const persistedDevServerStatus = readPersistedDevServerStatus();
    let devServer: ReturnType<typeof toDevServerHealthStatus> | undefined;
    if (persistedDevServerStatus) {
      const instanceSettings = instanceSettingsService(db);
      const experimentalSettings = await instanceSettings.getExperimental();
      const activeRunCount = await db
        .select({ count: count() })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.status, ["queued", "running"]))
        .then((rows) => Number(rows[0]?.count ?? 0));

      devServer = toDevServerHealthStatus(persistedDevServerStatus, {
        autoRestartEnabled: experimentalSettings.autoRestartDevServerWhenIdle ?? false,
        activeRunCount,
      });
    }

    res.json({
      status: "ok",
      version: serverVersion,
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      bootstrapStatus,
      bootstrapInviteActive,
      features: {
        companyDeletionEnabled: opts.companyDeletionEnabled,
        emailEnabled: opts.emailEnabled,
        socialProviders: opts.socialProviders,
        cloudSandboxEnabled: opts.cloudSandboxEnabled,
        managedInferenceEnabled: opts.managedInferenceEnabled,
      },
      ...(devServer ? { devServer } : {}),
    });
  });

  return router;
}
