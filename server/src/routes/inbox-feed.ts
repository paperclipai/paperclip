import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { inboxFeedService } from "../services/inbox-feed.js";
import { assertCompanyAccess } from "./authz.js";

export function inboxFeedRoutes(db: Db) {
  const router = Router();
  const svc = inboxFeedService(db);

  // GET /companies/:companyId/inbox/feed
  router.get("/companies/:companyId/inbox/feed", async (req, res, next) => {
    try {
      assertCompanyAccess(req, req.params.companyId);

      if (req.actor.type !== "board" || !req.actor.userId) {
        res.status(403).json({ error: "Board user access required" });
        return;
      }

      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const feed = await svc.feed(req.params.companyId, req.actor.userId, {
        limit,
      });

      res.json(feed);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
