import { Router } from "express";
import type { Db } from "@ironworksai/db";
import { generateProjectReport } from "../services/client-reports.js";
import { assertCompanyAccess } from "./authz.js";

export function clientReportRoutes(db: Db) {
  const router = Router();

  router.get("/companies/:companyId/projects/:projectId/client-report", async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = req.params.projectId as string;
    assertCompanyAccess(req, companyId);

    const periodDays = typeof req.query.periodDays === "string"
      ? Math.min(Math.max(parseInt(req.query.periodDays, 10) || 30, 7), 365)
      : 30;

    const report = await generateProjectReport(db, companyId, projectId, periodDays);
    if (!report) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.json(report);
  });

  return router;
}
