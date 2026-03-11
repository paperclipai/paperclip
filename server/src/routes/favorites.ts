import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { issueService } from "../services/index.js";
import { logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { and, eq, inArray } from "drizzle-orm";
import { issueFavorites, issues } from "@paperclipai/db";

export function favoriteRoutes(db: Db) {
  const router = Router();
  const svc = issueService(db);

  // GET /companies/:companyId/favorites — list favorited issues for current user
  router.get("/companies/:companyId/favorites", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }

    const userId = req.actor.userId;

    // Get favorited issue IDs for this user+company
    const favoriteRows = await db
      .select({ issueId: issueFavorites.issueId })
      .from(issueFavorites)
      .where(
        and(
          eq(issueFavorites.companyId, companyId),
          eq(issueFavorites.userId, userId),
        ),
      );

    if (favoriteRows.length === 0) {
      res.json([]);
      return;
    }

    const favoriteIssueIds = favoriteRows.map((r) => r.issueId);

    // Query only the favorited issues directly (avoids O(N) full-company scan)
    const favorited = await svc.listByIds(companyId, favoriteIssueIds);

    res.json(favorited.map((issue) => ({ ...issue, isFavoritedByMe: true })));
  });

  // PUT /issues/:id/favorite — add to favorites (idempotent)
  router.put("/issues/:id/favorite", async (req, res) => {
    const issueId = req.params.id as string;

    const issue = await svc.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }

    const userId = req.actor.userId;

    await db
      .insert(issueFavorites)
      .values({
        issueId,
        userId,
        companyId: issue.companyId,
      })
      .onConflictDoNothing();

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.favorited",
      entityType: "issue",
      entityId: issueId,
      details: { userId, identifier: issue.identifier },
    });

    res.status(204).end();
  });

  // DELETE /issues/:id/favorite — remove from favorites
  router.delete("/issues/:id/favorite", async (req, res) => {
    const issueId = req.params.id as string;

    const issue = await svc.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }

    const userId = req.actor.userId;

    await db
      .delete(issueFavorites)
      .where(
        and(
          eq(issueFavorites.issueId, issueId),
          eq(issueFavorites.userId, userId),
        ),
      );

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.unfavorited",
      entityType: "issue",
      entityId: issueId,
      details: { userId, identifier: issue.identifier },
    });

    res.status(204).end();
  });

  return router;
}
