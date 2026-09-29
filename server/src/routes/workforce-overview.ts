import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { workforceOverviewService } from "../services/workforce-overview.js";
import { assertCompanyAccess } from "./authz.js";

/**
 * Authenticated, company-scoped read of the live workforce overview.
 * GET only. Viewing and refreshing this route must not reopen, resume,
 * reassign, or dispatch work.
 */
export function workforceOverviewRoutes(db: Db) {
  const router = Router();
  const svc = workforceOverviewService(db);

  router.get("/companies/:companyId/workforce-overview", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const initiative = typeof req.query.initiative === "string" && req.query.initiative.trim()
      ? req.query.initiative.trim()
      : null;
    const overview = await svc.get(companyId, initiative);
    res.set("Cache-Control", "no-store");
    res.json(overview);
  });

  return router;
}
