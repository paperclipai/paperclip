import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertCompanyAccess } from "./authz.js";
import { bookforgeApprovedTargetStateService } from "../services/bookforge-approved-target-state.js";

export function bookforgeApprovedTargetRoutes(db: Db) {
  const router = Router();
  const svc = bookforgeApprovedTargetStateService(db);

  router.get("/companies/:companyId/bookforge/approved-target", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.getState(companyId));
  });

  return router;
}
