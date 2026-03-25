import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { dashboardService } from "../services/dashboard.js";
import { companyService } from "../services/index.js";
import { assertCompanyAccess } from "./authz.js";

export function dashboardRoutes(db: Db) {
  const router = Router();
  const svc = dashboardService(db);
  const companySvc = companyService(db);

  router.get("/companies/:companyId/dashboard", async (req, res) => {
    const companyIdOrPrefix = req.params.companyId as string;

    // Resolve prefix to UUID if needed
    const resolvedId = await companySvc.getByIdOrPrefix(companyIdOrPrefix);
    if (!resolvedId) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    assertCompanyAccess(req, resolvedId.id);
    const summary = await svc.summary(resolvedId.id);
    res.json(summary);
  });

  return router;
}
