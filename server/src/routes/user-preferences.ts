import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { updateUserPreferencesSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { userPreferencesService } from "../services/index.js";
import { assertBoard, getActorInfo } from "./authz.js";

function requireBoardUserId(req: Request, res: Response): string | null {
  assertBoard(req);
  if (!req.actor.userId) {
    res.status(403).json({ error: "Board user context required" });
    return null;
  }
  return req.actor.userId;
}

export function userPreferencesRoutes(db: Db) {
  const router = Router();
  const svc = userPreferencesService(db);

  router.get("/users/me/preferences", async (req, res) => {
    const userId = requireBoardUserId(req, res);
    if (!userId) return;
    const prefs = await svc.getPreferences(userId);
    res.json({ preferredCurrency: prefs.preferredCurrency });
  });

  router.patch(
    "/users/me/preferences",
    validate(updateUserPreferencesSchema),
    async (req, res) => {
      const userId = requireBoardUserId(req, res);
      if (!userId) return;

      const { preferredCurrency } = req.body;
      const prefs = await svc.upsertPreferences(userId, preferredCurrency);

      const actor = getActorInfo(req);
      // Log activity for preference change
      // Note: We don't have a companyId here since this is a global user preference
      // Activity logging would need a company context

      res.json({ preferredCurrency: prefs.preferredCurrency });
    },
  );

  return router;
}