import { Router } from "express";
import type { Db } from "@ironworksai/db";
import { generateRetrospective, getLatestRetrospective } from "../services/retrospective.js";
import { assertCompanyAccess, assertCanWrite } from "./authz.js";

export function retrospectiveRoutes(db: Db) {
  const router = Router();

  router.post("/companies/:companyId/retrospectives/generate", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanWrite(req, companyId, db);

    const periodDays = typeof req.body?.periodDays === "number"
      ? Math.min(Math.max(req.body.periodDays, 7), 90)
      : 14;

    const result = await generateRetrospective(db, companyId, periodDays);
    res.json(result);
  });

  router.get("/companies/:companyId/retrospectives/latest", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const latest = await getLatestRetrospective(db, companyId);
    res.json(latest);
  });

  return router;
}
