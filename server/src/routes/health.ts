import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { count, desc, sql } from "drizzle-orm";
import { agents, companies, heartbeatRuns, instanceUserRoles, providerCredentials } from "@paperclipai/db";
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

  // Temporary debug endpoint
  router.get("/debug-agents", async (_req, res) => {
    if (!db) { res.json([]); return; }

    const agentRows = await db
      .select({
        id: agents.id, name: agents.name, companyId: agents.companyId,
        adapterType: agents.adapterType, adapterConfig: agents.adapterConfig,
        credentialId: agents.credentialId, status: agents.status,
        lastHeartbeatAt: agents.lastHeartbeatAt,
      })
      .from(agents);

    const comps = await db.select({ id: companies.id, name: companies.name }).from(companies);
    const compMap = Object.fromEntries(comps.map(c => [c.id, c.name]));

    // Last 20 failed runs
    const failedRuns = await db
      .select({
        agentId: heartbeatRuns.agentId, status: heartbeatRuns.status,
        error: heartbeatRuns.error, errorCode: heartbeatRuns.errorCode,
        exitCode: heartbeatRuns.exitCode, finishedAt: heartbeatRuns.finishedAt,
      })
      .from(heartbeatRuns)
      .where(sql`${heartbeatRuns.status} IN ('error', 'failed', 'timeout')`)
      .orderBy(desc(heartbeatRuns.finishedAt))
      .limit(20);

    const agentNameMap = Object.fromEntries(agentRows.map(a => [a.id, a.name]));

    res.json({
      agents: agentRows.map(a => ({
        name: a.name, company: compMap[a.companyId], status: a.status,
        adapter: a.adapterType, credential: a.credentialId || 'NONE',
        lastHeartbeat: a.lastHeartbeatAt,
        envHOME: (a.adapterConfig as any)?.env?.HOME || 'not set',
      })),
      recentFailedRuns: failedRuns.map(r => ({
        agent: agentNameMap[r.agentId] || r.agentId,
        status: r.status, error: r.error, errorCode: r.errorCode,
        exitCode: r.exitCode, finishedAt: r.finishedAt,
      })),
    });
  });

  return router;
}
