import { Router } from "express";
import type { Db } from "@paperclipai/db";
import type { AttentionSortMode } from "@paperclipai/shared";
import { attentionService } from "../services/attention.js";
import { decisionHistoryService } from "../services/decision-history.js";
import { z } from "zod";
import { badRequest } from "../errors.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

function optionalQueryString(value: unknown, field: string) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw badRequest(`${field} must be a non-empty string`);
  return value.trim();
}

export function attentionRoutes(db: Db) {
  const router = Router();
  const svc = attentionService(db);

  router.get("/companies/:companyId/attention/summary", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    if (!req.actor.userId) { res.status(403).json({ error: "Board user context required" }); return; }
    res.json(await svc.summary(companyId, { userId: req.actor.userId, actor: req.actor }));
  });

  router.get("/companies/:companyId/attention/tasks", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    if (!req.actor.userId) { res.status(403).json({ error: "Board user context required" }); return; }
    res.json(await svc.taskIndex(companyId, { userId: req.actor.userId, actor: req.actor }));
  });

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

  return router;
}
