import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { pushNotificationService } from "../services/push-notifications.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

const subscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
  notifyTaskComplete: z.boolean().optional(),
  notifyAgentQuestion: z.boolean().optional(),
  notifyBoardReview: z.boolean().optional(),
});

const unsubscribeSchema = z.object({
  endpoint: z.string().url(),
});

const preferencesSchema = z.object({
  endpoint: z.string().url(),
  notifyTaskComplete: z.boolean().optional(),
  notifyAgentQuestion: z.boolean().optional(),
  notifyBoardReview: z.boolean().optional(),
});

export function pushRoutes(db: Db) {
  const router = Router();
  const svc = pushNotificationService(db);

  // Get VAPID public key (needed by the browser to subscribe)
  router.get("/push/vapid-key", (_req, res) => {
    const key = svc.getVapidPublicKey();
    if (!key) {
      res.status(503).json({ error: "Push notifications not configured. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY environment variables." });
      return;
    }
    res.json({ vapidPublicKey: key });
  });

  // Subscribe to push notifications for a company
  router.post(
    "/companies/:companyId/push/subscribe",
    validate(subscribeSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const userId = req.actor.userId ?? "board";

      const sub = await svc.subscribe({
        companyId,
        userId,
        endpoint: req.body.endpoint,
        keys: req.body.keys,
        notifyTaskComplete: req.body.notifyTaskComplete,
        notifyAgentQuestion: req.body.notifyAgentQuestion,
        notifyBoardReview: req.body.notifyBoardReview,
      });
      res.status(201).json(sub);
    },
  );

  // Unsubscribe from push notifications
  router.post(
    "/companies/:companyId/push/unsubscribe",
    validate(unsubscribeSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const deleted = await svc.unsubscribe(req.body.endpoint);
      res.json({ ok: true, deleted: !!deleted });
    },
  );

  // Update notification preferences
  router.patch(
    "/companies/:companyId/push/preferences",
    validate(preferencesSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const updated = await svc.updatePreferences(req.body.endpoint, {
        notifyTaskComplete: req.body.notifyTaskComplete,
        notifyAgentQuestion: req.body.notifyAgentQuestion,
        notifyBoardReview: req.body.notifyBoardReview,
      });
      if (!updated) {
        res.status(404).json({ error: "Subscription not found" });
        return;
      }
      res.json(updated);
    },
  );

  // Get current user's subscription status for a company
  router.get(
    "/companies/:companyId/push/status",
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const userId = req.actor.userId ?? "board";

      const sub = await svc.getSubscription(companyId, userId);
      res.json({
        subscribed: !!sub,
        preferences: sub
          ? {
              notifyTaskComplete: sub.notifyTaskComplete,
              notifyAgentQuestion: sub.notifyAgentQuestion,
              notifyBoardReview: sub.notifyBoardReview,
            }
          : null,
      });
    },
  );

  // Send a test push notification
  router.post(
    "/companies/:companyId/push/test",
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      await svc.sendToCompany(companyId, {
        type: "task_complete",
        title: "Test Notification",
        body: "Push notifications are working!",
      });
      res.json({ ok: true });
    },
  );

  return router;
}
