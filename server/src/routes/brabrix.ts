import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createBrabrixAgentSyncService } from "../services/index.js";
import { assertCompanyAccess } from "./authz.js";

export function brabrixRoutes(_db: Db) {
  const router = Router();

  router.post("/companies/:companyId/brabrix/sync-next-task", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const syncService = createBrabrixAgentSyncService();
    if (!syncService.isEnabled()) {
      res.status(409).json({
        error: "Brabrix integration is not configured. Check BRABRIX_* environment variables.",
      });
      return;
    }

    const bundle = await syncService.fetchNextTask();
    res.json(bundle);
  });

  return router;
}
