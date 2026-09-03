import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { briefsService } from "../services/briefs.js";
import { assertCompanyAccess } from "./authz.js";

export function briefsRoutes(db: Db) {
  const router = Router();
  const svc = briefsService(db);

  router.get("/companies/:companyId/briefs/overview", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.overview(companyId));
  });

  return router;
}
