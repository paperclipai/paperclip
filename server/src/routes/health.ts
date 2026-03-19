import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { count, eq, sql } from "drizzle-orm";
import { agents, companies, instanceUserRoles, providerCredentials } from "@paperclipai/db";
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

  // Temporary debug endpoint — remove after diagnosing agent config
  router.get("/debug-agents", async (_req, res) => {
    if (!db) { res.json([]); return; }
    const rows = await db
      .select({
        id: agents.id,
        name: agents.name,
        companyId: agents.companyId,
        adapterType: agents.adapterType,
        credentialId: agents.credentialId,
        status: agents.status,
      })
      .from(agents);

    const creds = await db
      .select({ id: providerCredentials.id, name: providerCredentials.name, type: providerCredentials.type, companyId: providerCredentials.companyId })
      .from(providerCredentials);

    const comps = await db
      .select({ id: companies.id, name: companies.name })
      .from(companies);

    res.json({ agents: rows, credentials: creds, companies: comps });
  });

  return router;
}
