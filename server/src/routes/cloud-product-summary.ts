import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { verifiedCloudControlClaims } from "../middleware/cloud-control.js";
import { cloudTenantPrimaryCompanyId, getCloudStackContext } from "../services/cloud-instance.js";
import { cloudProductSummaryQuerySchema, sharedCloudProductSummary } from "../services/cloud-product-summary.js";

export function cloudProductSummaryRoutes(db: Db) {
  const router = Router();
  router.get("/api/instance/product-summary", async (req, res) => {
    if (req.actor.source !== "cloud_control" || verifiedCloudControlClaims(req)?.action !== "product-summary:read") {
      res.status(403).json({ error: "cloud_control_required" });
      return;
    }
    const stackId = getCloudStackContext()?.stackId;
    if (!stackId) {
      res.status(404).json({ error: "not_cloud_managed" });
      return;
    }
    const query = cloudProductSummaryQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    res.set("Cache-Control", "no-store");
    res.json(await sharedCloudProductSummary(db, {
      companyId: cloudTenantPrimaryCompanyId(stackId),
      since: query.data.since ? new Date(query.data.since) : null,
    }));
  });
  return router;
}
