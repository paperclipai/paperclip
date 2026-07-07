import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";
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

  router.post("/companies/:companyId/push/subscriptions", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const { endpoint, p256dh, auth, deviceLabel } = req.body ?? {};
    if (
      typeof endpoint !== "string" ||
      typeof p256dh !== "string" ||
      typeof auth !== "string" ||
      endpoint.trim().length === 0 ||
      p256dh.trim().length === 0 ||
      auth.trim().length === 0
    ) {
      res.status(400).json({ error: "invalid_subscription" });
      return;
    }
    await svc.upsertSubscription({ companyId, endpoint, p256dh, auth, deviceLabel });
    res.status(201).json({ status: "subscribed" });
  });

  router.delete("/companies/:companyId/push/subscriptions", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const { endpoint } = req.body ?? {};
    if (typeof endpoint !== "string" || endpoint.trim().length === 0) {
      res.status(400).json({ error: "missing_endpoint" });
      return;
    }
    await svc.deleteSubscription(companyId, endpoint);
    res.json({ status: "unsubscribed" });
  });

  router.get("/companies/:companyId/push/subscriptions", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const subs = await svc.listSubscriptions(companyId);
    res.json({
      subscriptions: subs.map((s) => ({
        id: s.id,
        endpoint: s.endpoint,
        deviceLabel: s.deviceLabel,
        createdAt: s.createdAt,
      })),
    });
  });

  router.post("/companies/:companyId/push/test", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!isVapidConfigured()) {
      res.status(503).json({ error: "vapid_not_configured" });
      return;
    }
    const result = await svc.sendToBoard(companyId, {
      title: "Paperclip test notification",
      body: "Web Push is working.",
    });
    res.json(result);
  });

  router.post("/companies/:companyId/push/digest/test", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!isVapidConfigured()) {
      res.status(503).json({ error: "vapid_not_configured" });
      return;
    }
    const result = await svc.sendToBoard(companyId, {
      title: "Paperclip digest test",
      body: "Digest Web Push is working.",
      data: { kind: "digest", blockedCount: 1, staleCount: 1, test: true },
    });
    res.json(result);
  });

  return router;
}
