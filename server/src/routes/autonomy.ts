import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { autonomyKernelService } from "../services/index.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function autonomyRoutes(db: Db) {
  const router = Router();
  const autonomy = autonomyKernelService(db);

  router.get("/companies/:companyId/autonomy/inbox", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const items = await autonomy.getAutonomyInbox(companyId);
    res.json(items);
  });

  return router;
}
