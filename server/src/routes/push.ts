import { Router } from "express";
import { isIP } from "node:net";
import type { Db } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { getVapidPublicKey, isVapidConfigured, webPushService } from "../services/web-push.js";

function isPrivateIpv4(hostname: string) {
  const octets = hostname.split(".").map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  const [a, b] = octets;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(hostname: string) {
  const normalized = hostname.toLowerCase();
  return normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:");
}

function isInternalPushHostname(hostname: string) {
  const lowerHostname = hostname.toLowerCase();
  const normalized = lowerHostname.startsWith("[") && lowerHostname.endsWith("]")
    ? lowerHostname.slice(1, -1)
    : lowerHostname;
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal")
  ) {
    return true;
  }
  if (isIP(normalized) === 4) return isPrivateIpv4(normalized);
  if (isIP(normalized) === 6) return isPrivateIpv6(normalized);
  return false;
}

function normalizePushEndpoint(endpoint: string): string | null {
  const trimmed = endpoint.trim();
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
    if (isInternalPushHostname(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

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
    const normalizedEndpoint = typeof endpoint === "string" ? normalizePushEndpoint(endpoint) : null;
    if (
      typeof endpoint !== "string" ||
      typeof p256dh !== "string" ||
      typeof auth !== "string" ||
      normalizedEndpoint === null ||
      p256dh.trim().length === 0 ||
      auth.trim().length === 0
    ) {
      res.status(400).json({ error: "invalid_subscription" });
      return;
    }
    await svc.upsertSubscription({ companyId, endpoint: normalizedEndpoint, p256dh, auth, deviceLabel });
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
