import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess } from "./authz.js";
import { issueFavouriteService, issueService } from "../services/index.js";

const favouriteSchema = z.object({
  issueId: z.string().trim().min(1),
});

// Favourites are per-user personal state and toggle frequently, so they are
// intentionally not written to the company activity feed (unlike most issue
// mutations) to avoid flooding it with favourite/unfavourite noise.
function requireBoardUser(req: Request, res: Response): string | null {
  if (req.actor.type !== "board") {
    res.status(403).json({ error: "Board authentication required" });
    return null;
  }
  if (!req.actor.userId) {
    res.status(403).json({ error: "Board user context required" });
    return null;
  }
  return req.actor.userId;
}

export function issueFavouriteRoutes(db: Db) {
  const router = Router();
  const svc = issueFavouriteService(db);
  const issues = issueService(db);

  router.get("/companies/:companyId/issue-favourites", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = requireBoardUser(req, res);
    if (!userId) return;
    const favourites = await svc.list(companyId, userId);
    res.json(favourites);
  });

  router.post(
    "/companies/:companyId/issue-favourites",
    validate(favouriteSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const userId = requireBoardUser(req, res);
      if (!userId) return;

      const issue = await issues.getById(req.body.issueId);
      if (!issue || issue.companyId !== companyId) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }

      const favourite = await svc.add(companyId, userId, issue.id);
      res.status(201).json(favourite);
    },
  );

  router.delete("/companies/:companyId/issue-favourites/:issueId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = requireBoardUser(req, res);
    if (!userId) return;

    const issue = await issues.getById(req.params.issueId as string);
    if (!issue || issue.companyId !== companyId) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    await svc.remove(companyId, userId, issue.id);
    res.status(204).end();
  });

  return router;
}
