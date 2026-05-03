import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { assertBoard } from "./authz.js";
import { getVapidPublicKey, webPushService } from "../services/index.js";

const subscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

const unsubscribeSchema = z.object({
  endpoint: z.string().url(),
});

export function notificationRoutes(db: Db) {
  const router = Router();
  const svc = webPushService(db);

  router.get("/notifications/vapid-public-key", (_req, res) => {
    const key = getVapidPublicKey();
    if (!key) {
      res.status(503).json({ error: "Web push not configured" });
      return;
    }
    res.json({ publicKey: key });
  });

  router.get("/notifications/subscriptions", async (req, res) => {
    assertBoard(req);
    const userId = req.actor.userId;
    if (!userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const subs = await svc.listForUser(userId);
    res.json(subs);
  });

  router.post("/notifications/subscribe", validate(subscribeSchema), async (req, res) => {
    assertBoard(req);
    const userId = req.actor.userId;
    if (!userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const { endpoint, keys } = req.body as z.infer<typeof subscribeSchema>;
    const userAgent = req.get("user-agent") ?? null;
    const row = await svc.upsert({
      userId,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      userAgent,
    });
    res.status(201).json({
      id: row.id,
      endpoint: row.endpoint,
      userAgent: row.userAgent,
      createdAt: row.createdAt,
    });
  });

  router.post("/notifications/unsubscribe", validate(unsubscribeSchema), async (req, res) => {
    assertBoard(req);
    const userId = req.actor.userId;
    if (!userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    await svc.remove(userId, req.body.endpoint);
    res.status(204).end();
  });

  router.post("/notifications/test", async (req, res) => {
    assertBoard(req);
    const userId = req.actor.userId;
    if (!userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const result = await svc.sendToUser(userId, {
      title: "Paperclip test notification",
      body: "Push notifications are working on this device.",
      url: "/",
      tag: "paperclip-test",
    });
    res.json(result);
  });

  return router;
}
