import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { assertBoard } from "./authz.js";
import { pushSubscriptionStore } from "../services/push-subscription-store.js";
import { getVapidPublicKey, isPushConfigured } from "../services/push-notifications.js";

const pushSubscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

const unsubscribeSchema = z.object({
  endpoint: z.string().url(),
});

function requireBoardUserId(req: Request, res: Response): string | null {
  assertBoard(req);
  if (!req.actor.userId) {
    res.status(403).json({ error: "Board user context required" });
    return null;
  }
  return req.actor.userId;
}

export function pushRoutes(db: Db) {
  const router = Router();
  const store = pushSubscriptionStore(db);

  // Public VAPID key + whether push is configured on this instance.
  router.get("/push/vapid-public-key", (_req, res) => {
    res.json({ configured: isPushConfigured(), publicKey: getVapidPublicKey() });
  });

  // Register (or refresh) a device subscription for the current board user.
  router.post("/push/subscribe", validate(pushSubscriptionSchema), async (req, res) => {
    const userId = requireBoardUserId(req, res);
    if (!userId) return;

    await store.add({
      userId,
      endpoint: req.body.endpoint,
      keys: { p256dh: req.body.keys.p256dh, auth: req.body.keys.auth },
      createdAt: new Date().toISOString(),
      userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined,
    });

    res.status(201).json({ ok: true });
  });

  // Remove a device subscription by endpoint.
  router.post("/push/unsubscribe", validate(unsubscribeSchema), async (req, res) => {
    const userId = requireBoardUserId(req, res);
    if (!userId) return;

    await store.removeByEndpoint(req.body.endpoint);
    res.json({ ok: true });
  });

  return router;
}
