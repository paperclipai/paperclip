import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { subscribePushSubscriptionSchema, unsubscribePushSubscriptionSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity, pushSubscriptionService } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

function requireBoardUserId(req: Request, res: Response): string | null {
  assertBoard(req);
  if (!req.actor.userId) {
    res.status(403).json({ error: "Board user context required" });
    return null;
  }
  return req.actor.userId;
}

export function pushSubscriptionRoutes(db: Db) {
  const router = Router();
  const svc = pushSubscriptionService(db);

  router.post(
    "/companies/:companyId/push-subscriptions/me",
    validate(subscribePushSubscriptionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const userId = requireBoardUserId(req, res);
      if (!userId) return;

      const subscription = await svc.subscribe(companyId, userId, {
        endpoint: req.body.endpoint,
        p256dh: req.body.keys.p256dh,
        auth: req.body.keys.auth,
      });

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "push_subscription.subscribed",
        entityType: "company",
        entityId: companyId,
        details: { userId, endpoint: subscription.endpoint },
      });

      res.status(201).json({ id: subscription.id });
    },
  );

  router.delete(
    "/companies/:companyId/push-subscriptions/me",
    validate(unsubscribePushSubscriptionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const userId = requireBoardUserId(req, res);
      if (!userId) return;

      const result = await svc.unsubscribe(companyId, userId, req.body.endpoint);

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "push_subscription.unsubscribed",
        entityType: "company",
        entityId: companyId,
        details: { userId, endpoint: req.body.endpoint },
      });

      res.json(result);
    },
  );

  return router;
}
