import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { and, count, eq, gt, isNull, sql } from "drizzle-orm";
import { agents, instanceUserRoles, invites } from "@paperclipai/db";
import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import { serverVersion } from "../version.js";
import { getServerAdapter } from "../adapters/registry.js";

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
      res.json({ status: "ok", version: serverVersion });
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
      },
    });
  });

  // Traffic-light health check for all active adapters
  router.get("/adapters", async (_req, res) => {
    if (!db) {
      res.json({ status: "unknown", adapters: [] });
      return;
    }

    // Count agents per adapter type
    const adapterCounts = await db
      .select({
        adapterType: agents.adapterType,
        count: count(),
      })
      .from(agents)
      .where(sql`${agents.status} NOT IN ('terminated', 'pending_approval')`)
      .groupBy(agents.adapterType);

    const results: Array<{
      adapterType: string;
      agentCount: number;
      environmentOk: boolean;
      status: string;
      error?: string;
    }> = [];

    for (const row of adapterCounts) {
      if (row.count === 0) continue;
      try {
        const adapter = getServerAdapter(row.adapterType);
        const envResult = await adapter.testEnvironment({
          companyId: "health-check",
          adapterType: row.adapterType,
          config: {},
        });
        const isOk = envResult.status === "pass" || envResult.status === "warn";
        results.push({
          adapterType: row.adapterType,
          agentCount: Number(row.count),
          environmentOk: isOk,
          status: envResult.status,
          error: isOk ? undefined : envResult.checks?.find((c) => c.level === "error")?.message,
        });
      } catch {
        results.push({
          adapterType: row.adapterType,
          agentCount: Number(row.count),
          environmentOk: false,
          status: "fail",
          error: "Adapter not found in registry",
        });
      }
    }

    const allOk = results.every((r) => r.environmentOk);
    const activeCount = results.filter((r) => r.environmentOk).length;
    const totalCount = results.length;

    res.json({
      status: allOk ? "healthy" : "degraded",
      summary: allOk
        ? `All systems operational (${totalCount}/${totalCount} adapters)`
        : `${activeCount}/${totalCount} adapters operational`,
      adapters: results,
    });
  });

  return router;
}
