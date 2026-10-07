import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import {
  createSavedTaskViewSchema,
  listSavedTaskViewsQuerySchema,
  updateSavedTaskViewSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { logActivity } from "../services/index.js";
import { savedTaskViewService, SavedTaskViewNameTakenError } from "../services/saved-task-views.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

/**
 * Saved task views are personal: they belong to one signed-in board user, in
 * one company. Agents have no use for them, and no route exposes another
 * person's views, so every route requires a board user context.
 */
function requireBoardUserId(req: Request, res: Response): string | null {
  if (req.actor.type !== "board" || !req.actor.userId) {
    res.status(403).json({ error: "Board user context required" });
    return null;
  }
  return req.actor.userId;
}

export function savedTaskViewRoutes(db: Db) {
  const router = Router();
  const svc = savedTaskViewService(db);

  /**
   * Mutating routes write an activity entry, as every mutating route here does.
   *
   * The entry carries no text the user typed — not the definition, which can
   * hold their search terms, and not the view's name. A saved view is personal:
   * reads and writes are scoped to the acting user. The activity log is not —
   * it is readable by anyone with `company_scope:read`. So the entry records
   * only the collection and which fields moved, and leaves the name to be read
   * through the saved-view API by the one person entitled to it.
   */
  async function recordChange(
    req: Request,
    companyId: string,
    userId: string,
    action: "saved_task_view.created" | "saved_task_view.updated" | "saved_task_view.deleted",
    savedTaskViewId: string,
    details: Record<string, unknown>,
  ) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action,
      entityType: "saved_task_view",
      entityId: savedTaskViewId,
      details: { userId, ...details },
    });
  }

  router.get("/companies/:companyId/saved-task-views", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = requireBoardUserId(req, res);
    if (!userId) return;

    const query = listSavedTaskViewsQuerySchema.safeParse(req.query);
    if (!query.success) throw badRequest("Invalid saved task view query", query.error.issues);

    res.json(await svc.list({ companyId, userId }, query.data.collectionKey));
  });

  router.post(
    "/companies/:companyId/saved-task-views",
    validate(createSavedTaskViewSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const userId = requireBoardUserId(req, res);
      if (!userId) return;

      try {
        const created = await svc.create({ companyId, userId }, req.body);
        await recordChange(req, companyId, userId, "saved_task_view.created", created.id, {
          collectionKey: created.collectionKey,
        });
        res.status(201).json(created);
      } catch (error) {
        if (error instanceof SavedTaskViewNameTakenError) throw conflict(error.message);
        throw error;
      }
    },
  );

  router.patch(
    "/companies/:companyId/saved-task-views/:savedTaskViewId",
    validate(updateSavedTaskViewSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const userId = requireBoardUserId(req, res);
      if (!userId) return;

      try {
        const updated = await svc.update(
          { companyId, userId },
          req.params.savedTaskViewId as string,
          req.body,
        );
        if (!updated) throw notFound("Saved task view not found");
        await recordChange(req, companyId, userId, "saved_task_view.updated", updated.id, {
          collectionKey: updated.collectionKey,
          // Which parts of the view moved, not what they moved to.
          changed: Object.keys(req.body as Record<string, unknown>),
        });
        res.json(updated);
      } catch (error) {
        if (error instanceof SavedTaskViewNameTakenError) throw conflict(error.message);
        throw error;
      }
    },
  );

  router.delete("/companies/:companyId/saved-task-views/:savedTaskViewId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = requireBoardUserId(req, res);
    if (!userId) return;

    const removed = await svc.remove({ companyId, userId }, req.params.savedTaskViewId as string);
    if (!removed) throw notFound("Saved task view not found");
    await recordChange(req, companyId, userId, "saved_task_view.deleted", removed.id, {
      collectionKey: removed.collectionKey,
    });
    res.status(204).end();
  });

  return router;
}
