import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { upsertSidebarOrderPreferenceSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity, sidebarPreferenceService } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

function requireBoardUserId(req: Request, res: Response): string | null {
  assertBoard(req);
  if (!req.actor.userId) {
    res.status(403).json({ error: "Board user context required" });
    return null;
  }
  return req.actor.userId;
}

export function sidebarPreferenceRoutes(db: Db) {
  const router = Router();
  const svc = sidebarPreferenceService(db);

  router.get("/sidebar-preferences/me", async (req, res) => {
    const userId = requireBoardUserId(req, res);
    if (!userId) return;
    res.json(await svc.getCompanyOrder(userId));
  });

  router.put("/sidebar-preferences/me", validate(upsertSidebarOrderPreferenceSchema), async (req, res) => {
    const userId = requireBoardUserId(req, res);
    if (!userId) return;
    res.json(await svc.upsertCompanyOrder(userId, req.body.orderedIds));
  });

  router.get("/companies/:companyId/sidebar-preferences/me", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = requireBoardUserId(req, res);
    if (!userId) return;
    res.json(await svc.getProjectOrder(companyId, userId));
  });

  router.put(
    "/companies/:companyId/sidebar-preferences/me",
    validate(upsertSidebarOrderPreferenceSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const userId = requireBoardUserId(req, res);
      if (!userId) return;

      const result = await svc.upsertProjectOrder(companyId, userId, req.body.orderedIds);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "sidebar_preferences.project_order_updated",
        entityType: "company",
        entityId: companyId,
        details: {
          userId,
          orderedIds: result.orderedIds,
        },
      });
      res.json(result);
    },
  );

  return router;
}
