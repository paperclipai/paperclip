import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { ATTENTION_SOURCE_KINDS, type AttentionFeedView, type AttentionSortMode } from "@paperclipai/shared";
import { attentionService } from "../services/attention.js";
import { decisionHistoryService } from "../services/decision-history.js";
import { logActivity } from "../services/activity-log.js";
import { z } from "zod";
import { badRequest } from "../errors.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

const ATTENTION_FEED_VIEWS: readonly AttentionFeedView[] = ["mine", "unassigned", "company", "all"];

function optionalQueryString(value: unknown, field: string) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw badRequest(`${field} must be a non-empty string`);
  return value.trim();
}

export function attentionRoutes(db: Db) {
  const router = Router();
  const svc = attentionService(db);

  router.get("/companies/:companyId/attention/history", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    if (!req.actor.userId) { res.status(403).json({ error: "Board user context required" }); return; }
    const query = z.object({
      cursor: z.string().max(1000).optional(), limit: z.coerce.number().int().min(1).max(100).optional(),
      search: z.string().trim().max(200).optional(), outcome: z.string().max(40).optional(),
      agentId: z.string().uuid().optional(), projectId: z.string().uuid().optional(),
      sort: z.enum(["newest", "oldest"]).optional(), since: z.string().datetime().optional(),
    }).strict().safeParse(req.query);
    if (!query.success) throw badRequest("Invalid decision history filters");
    res.json(await decisionHistoryService(db).list(companyId, { ...query.data, actor: req.actor, userId: req.actor.userId }));
  });

  router.get("/companies/:companyId/attention", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }

    const includeDismissed = req.query.includeDismissed === "true";
    const archived = req.query.archived === "true";
    const all = req.query.all === "true";
    const viewValue = optionalQueryString(req.query.view, "view");
    if (viewValue !== undefined && !ATTENTION_FEED_VIEWS.includes(viewValue as AttentionFeedView)) {
      throw badRequest(`view must be one of ${ATTENTION_FEED_VIEWS.join(", ")}`);
    }
    const view = viewValue as AttentionFeedView | undefined;
    const activitySince = optionalQueryString(req.query.activitySince, "activitySince");
    const activityUntil = optionalQueryString(req.query.activityUntil, "activityUntil");
    const queue = optionalQueryString(req.query.queue, "queue");
    const cursor = optionalQueryString(req.query.cursor, "cursor");
    const sortValue = optionalQueryString(req.query.sort, "sort");
    if (sortValue !== undefined && sortValue !== "activity" && sortValue !== "decide") {
      throw badRequest("sort must be 'activity' or 'decide'");
    }
    const limitValue = optionalQueryString(req.query.limit, "limit");
    const limit = limitValue === undefined ? undefined : Number(limitValue);
    if (limit !== undefined && !Number.isInteger(limit)) throw badRequest("limit must be an integer");
    const feed = await svc.list(companyId, {
      userId: req.actor.userId,
      includeDismissed,
      actor: req.actor,
      archived,
      view,
      all,
      allowUnscopedAll: all,
      activitySince,
      activityUntil,
      queue,
      cursor,
      sort: sortValue as AttentionSortMode | undefined,
      limit,
    });
    res.json(feed);
  });

  // Claim an Unassigned card (PAP-749 plan §1, Rule 3): the claimer becomes the
  // addressee, so the card leaves every other person's pool. Board users only;
  // it changes where the card shows, never who may answer it.
  router.post("/companies/:companyId/attention/:sourceKind/:sourceId/claim", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const sourceKind = req.params.sourceKind as string;
    if (!(ATTENTION_SOURCE_KINDS as readonly string[]).includes(sourceKind)) {
      throw badRequest(`sourceKind must be one of ${ATTENTION_SOURCE_KINDS.join(", ")}`);
    }
    const sourceId = req.params.sourceId as string;
    if (!z.string().uuid().safeParse(sourceId).success) throw badRequest("sourceId must be a UUID");

    const claim = await svc.claim(companyId, { sourceKind, sourceId, userId: req.actor.userId, actor: req.actor });
    if (!claim.alreadyClaimed) {
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "attention.claimed",
        entityType: "issue",
        entityId: claim.issueId,
        issueId: claim.issueId,
        details: {
          sourceKind: claim.sourceKind,
          sourceId: claim.sourceId,
          interactionId: claim.sourceId,
          claimedByUserId: claim.claimedByUserId,
          previousAddresseeAgentId: claim.previousAddresseeAgentId,
        },
      });
    }
    res.json({
      sourceKind: claim.sourceKind,
      sourceId: claim.sourceId,
      claimedByUserId: claim.claimedByUserId,
      alreadyClaimed: claim.alreadyClaimed,
    });
  });

  return router;
}
