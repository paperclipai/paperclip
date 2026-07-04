import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertBoard } from "./authz.js";
import { getVapidPublicKey, isVapidConfigured, webPushService } from "../services/web-push.js";

export function pushRoutes(db: Db) {
  const router = Router();
  const svc = webPushService(db);

  router.get("/push/vapid-public-key", (_req, res) => {
    const key = getVapidPublicKey();
    if (!key) {
      res.status(503).json({ error: "vapid_not_configured" });
      return;
    }
    res.json({ vapidPublicKey: key });
  });

  router.post("/push/subscriptions", async (req, res) => {
    assertBoard(req);
    const { endpoint, p256dh, auth, deviceLabel } = req.body ?? {};
    if (typeof endpoint !== "string" || typeof p256dh !== "string" || typeof auth !== "string") {
      res.status(400).json({ error: "invalid_subscription" });
      return;
    }
    await svc.upsertSubscription({ endpoint, p256dh, auth, deviceLabel });
    res.status(201).json({ status: "subscribed" });
  });

  router.delete("/push/subscriptions", async (req, res) => {
    assertBoard(req);
    const { endpoint } = req.body ?? {};
    if (typeof endpoint !== "string") {
      res.status(400).json({ error: "missing_endpoint" });
      return;
    }
    await svc.deleteSubscription(endpoint);
    res.json({ status: "unsubscribed" });
  });

  router.get("/push/subscriptions", async (req, res) => {
    assertBoard(req);
    const subs = await svc.listSubscriptions();
    res.json({
      subscriptions: subs.map((s) => ({
        id: s.id,
        endpoint: s.endpoint,
        deviceLabel: s.deviceLabel,
        createdAt: s.createdAt,
      })),
    });
  });

  router.post("/push/test", async (req, res) => {
    assertBoard(req);
    if (!isVapidConfigured()) {
      res.status(503).json({ error: "vapid_not_configured" });
      return;
    }
    const result = await svc.sendToBoard({
      title: "Paperclip test notification",
      body: "Web Push is working.",
    });
    res.json(result);
  });

  return router;
}
