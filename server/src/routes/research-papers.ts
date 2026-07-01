import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { researchPapersService } from "../services/research-papers.js";
import { assertCompanyAccess } from "./authz.js";

// Read-only research-paper evidence surface. The `db` argument is accepted for
// mount-signature parity with the other company-scoped route factories; this
// surface only reads local CPS artifacts and never touches the database or any
// mutating/external action.
export function researchPapersRoutes(_db: Db) {
  const router = Router();
  const svc = researchPapersService();

  router.get("/companies/:companyId/research-papers", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.overview(companyId));
  });

  return router;
}
