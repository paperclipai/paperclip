import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertCompanyAccess } from "./authz.js";
import { issueUserRecencyService, RECENT_ISSUES_MAX_LIMIT } from "../services/issue-user-recency.js";

export function recentIssueRoutes(db: Db) {
  const router = Router();
  const service = issueUserRecencyService(db);

  router.get("/companies/:companyId/users/me/recent-issues", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "board" || !req.actor.userId) {
      res.status(403).json({ error: "Board user access required" });
      return;
    }

    const rawLimit = req.query.limit;
    if (rawLimit !== undefined && (typeof rawLimit !== "string" || !/^\d+$/.test(rawLimit))) {
      res.status(400).json({ error: `limit must be a positive integer up to ${RECENT_ISSUES_MAX_LIMIT}` });
      return;
    }
    const parsedLimit = rawLimit === undefined ? RECENT_ISSUES_MAX_LIMIT : Number.parseInt(rawLimit, 10);
    if (parsedLimit < 1) {
      res.status(400).json({ error: `limit must be a positive integer up to ${RECENT_ISSUES_MAX_LIMIT}` });
      return;
    }

    res.json(await service.listRecentIssues(companyId, req.actor.userId, parsedLimit));
  });

  return router;
}
