import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { patchUserPreferencesSchema } from "@paperclipai/shared";
import { badRequest, forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { userPreferencesService } from "../services/index.js";

function requireBoardUser(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Board authentication required");
  }
  if (!req.actor.userId) {
    throw forbidden("Board user context required");
  }
  if (req.actor.source === "local_implicit") {
    throw badRequest("User preferences are unavailable for this session");
  }
  return req.actor.userId;
}

export function userPreferencesRoutes(db: Db) {
  const router = Router();
  const svc = userPreferencesService(db);

  router.get("/user/preferences", async (req, res) => {
    const userId = requireBoardUser(req);
    res.json(await svc.get(userId));
  });

  router.patch("/user/preferences", validate(patchUserPreferencesSchema), async (req, res) => {
    const userId = requireBoardUser(req);
    res.json(await svc.update(userId, req.body));
  });

  return router;
}
