import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { connectCloudflareSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { cloudflareService, logActivity } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

/**
 * Cloudflare account connection for embedded mail (phase 0). Board-only: a human
 * connects an API token so the platform can read zones and publish mail DNS.
 */
export function cloudflareIntegrationRoutes(db: Db) {
  const router = Router();
  const svc = cloudflareService(db);

  // Current connection (without the token), or null.
  router.get("/companies/:companyId/integrations/cloudflare", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    res.json(await svc.get(companyId));
  });

  // Connect (or replace) the Cloudflare account.
  router.post(
    "/companies/:companyId/integrations/cloudflare",
    validate(connectCloudflareSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertBoard(req);
      const info = getActorInfo(req);
      const connection = await svc.connect(companyId, req.body, {
        actorType: info.actorType,
        actorId: info.actorId,
      });
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: info.actorId,
        action: "cloudflare_connected",
        entityType: "cloudflare_connection",
        entityId: connection.id,
        details: { cfAccountId: connection.cfAccountId },
      });
      res.status(201).json(connection);
    },
  );

  // Disconnect.
  router.delete("/companies/:companyId/integrations/cloudflare", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    await svc.disconnect(companyId);
    res.status(204).end();
  });

  // List the zones (domains) the connected account can manage.
  router.get("/companies/:companyId/integrations/cloudflare/zones", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    res.json(await svc.listZones(companyId));
  });

  return router;
}
