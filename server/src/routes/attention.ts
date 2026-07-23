import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { attentionService } from "../services/attention.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function attentionRoutes(db: Db) {
  const router = Router();
  const svc = attentionService(db);

  router.get("/companies/:companyId/attention", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }

    const includeDismissed = req.query.includeDismissed === "true";
    const feed = await svc.list(companyId, {
      userId: req.actor.userId,
      includeDismissed,
    });
    res.json(feed);
  });

  return router;
}
