import { Router } from "express";
import type { Db } from "@ironworksai/db";
import { computeFlowMetrics } from "../services/flow-metrics.js";
import { assertCompanyAccess } from "./authz.js";

export function flowMetricsRoutes(db: Db) {
  const router = Router();

  /**
   * GET /companies/:companyId/flow-metrics
   * Returns operational flow health metrics for the company.
   */
  router.get("/companies/:companyId/flow-metrics", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const metrics = await computeFlowMetrics(db, companyId);
    res.json(metrics);
  });

  return router;
}
