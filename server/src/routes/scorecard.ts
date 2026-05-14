import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { scorecardService } from "../services/scorecard.js";
import { assertCompanyAccess } from "./authz.js";

export function scorecardRoutes(db: Db) {
  const router = Router();
  const svc = scorecardService(db);

  router.get("/companies/:companyId/scorecard", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const scorecard = await svc.get(companyId);
    res.json(scorecard);
  });

  return router;
}
