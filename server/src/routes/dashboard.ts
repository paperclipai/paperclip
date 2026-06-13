import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { dashboardService } from "../services/dashboard.js";
import { assertCompanyAccess } from "./authz.js";

export function dashboardRoutes(db: Db) {
  const router = Router();
  const svc = dashboardService(db);

  router.get("/companies/:companyId/dashboard", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const summary = await svc.summary(companyId);
    res.json(summary);
  });

  // Agent scorecards for the monthly staffing routine (BLO-10275). Optional
  // ?windowDays= overrides the default 30-day window; the service clamps it.
  router.get("/companies/:companyId/agent-scorecards", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rawWindow = req.query.windowDays;
    const parsedWindow = typeof rawWindow === "string" ? Number.parseInt(rawWindow, 10) : undefined;
    const windowDays =
      parsedWindow !== undefined && Number.isFinite(parsedWindow) ? parsedWindow : undefined;
    const scorecards = await svc.agentScorecards(companyId, { windowDays });
    res.json(scorecards);
  });

  return router;
}
