import { Router } from "express";
import { companies, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { bettingOpsDashboardService } from "../services/betting-ops-dashboard.js";
import { assertCompanyAccess } from "./authz.js";

export function bettingOpsDashboardRoutes(db: Db) {
  const router = Router();
  const svc = bettingOpsDashboardService(db);

  router.get("/companies/:companyId/betting-ops-dashboard", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const summary = await svc.summary(companyId);
    const company = await db.query.companies.findFirst({
      where: eq(companies.id, companyId),
      columns: { issuePrefix: true },
    });
    const prefix = company?.issuePrefix?.trim();
    summary.shortcut.targetUrl = prefix
      ? `${req.protocol}://${req.get("host")}/${prefix}/betting-ops`
      : `${req.protocol}://${req.get("host")}/betting-ops`;
    res.json(summary);
  });

  router.post("/companies/:companyId/betting-ops-dashboard/install-shortcut", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const targetUrl =
      typeof req.body?.targetUrl === "string" && req.body.targetUrl.trim().length > 0
        ? req.body.targetUrl
        : `${req.protocol}://${req.get("host")}/betting-ops`;
    const result = await svc.installShortcut({ targetUrl });
    res.json(result);
  });

  return router;
}
