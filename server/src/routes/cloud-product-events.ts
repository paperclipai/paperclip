import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { verifiedCloudControlClaims } from "../middleware/cloud-control.js";
import { cloudTenantPrimaryCompanyId, getCloudStackContext } from "../services/cloud-instance.js";
import { cloudProductEventQuerySchema, listCloudProductEvents } from "../services/cloud-product-events.js";

export function cloudProductEventRoutes(db: Db) {
  const router = Router();
  router.get("/api/instance/product-events", async (req, res) => {
    if (req.actor.source !== "cloud_control" || verifiedCloudControlClaims(req)?.action !== "product-events:read") {
      res.status(403).json({ error: "cloud_control_required" });
      return;
    }
    const stackId = getCloudStackContext()?.stackId;
    if (!stackId) {
      res.status(404).json({ error: "not_cloud_managed" });
      return;
    }
    const query = cloudProductEventQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    res.set("Cache-Control", "no-store");
    res.json(await listCloudProductEvents(db, { companyId: cloudTenantPrimaryCompanyId(stackId), ...query.data }));
  });
  return router;
}
