import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { dashboardService } from "../services/dashboard.js";
import { notFound } from "../errors.js";
import { assertAuthenticated, assertCompanyAccess } from "./authz.js";

export function dashboardRoutes(db: Db) {
  const router = Router();
  const svc = dashboardService(db);

  router.get("/companies/:companyId/dashboard", async (req, res) => {
    const companyRef = req.params.companyId as string;
    assertAuthenticated(req);
    const company = await svc.resolveCompanyReference(companyRef);
    if (!company) throw notFound("Company not found");
    assertCompanyAccess(req, company.id);
    const summary = await svc.summary(company.id);
    res.json(summary);
  });

  return router;
}
