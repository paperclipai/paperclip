import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { cpsExperimentsService } from "../services/cps-experiments.js";
import { assertCompanyAccess } from "./authz.js";

// Read-only CPS experiment index surface. The `db` argument is accepted for
// mount-signature parity; this route only reads local CPS tracker artifacts.
export function cpsExperimentRoutes(_db: Db) {
  const router = Router();
  const svc = cpsExperimentsService();

  router.get("/companies/:companyId/cps-experiments", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.overview(companyId));
  });

  return router;
}
