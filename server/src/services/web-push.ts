import webPush from "web-push";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { webPushSubscriptions } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

export type PushSubscriptionData = {
  endpoint: string;
  p256dh: string;
  auth: string;
  deviceLabel?: string;
};

export type PushPayload = {
  title: string;
  body?: string;
  icon?: string;
  data?: Record<string, unknown>;
};

function getVapidConfig() {
  const publicKey = process.env.PAPERCLIP_VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.PAPERCLIP_VAPID_PRIVATE_KEY?.trim();
  const subject = process.env.PAPERCLIP_VAPID_SUBJECT?.trim() ?? "mailto:push@paperclip.local";
  return { publicKey, privateKey, subject };
}

export function isVapidConfigured(): boolean {
  const { publicKey, privateKey } = getVapidConfig();
  return Boolean(publicKey && privateKey);
}

export function getVapidPublicKey(): string | undefined {
  return getVapidConfig().publicKey;
}

function configureWebPush() {
  const { publicKey, privateKey, subject } = getVapidConfig();
  if (!publicKey || !privateKey) return false;
  webPush.setVapidDetails(subject, publicKey, privateKey);
  return true;
}

export function webPushService(db: Db) {
  async function upsertSubscription(sub: PushSubscriptionData) {
    await db
      .insert(webPushSubscriptions)
      .values({
        endpoint: sub.endpoint,
        p256dh: sub.p256dh,
        auth: sub.auth,
        deviceLabel: sub.deviceLabel ?? "",
      })
      .onConflictDoUpdate({
        target: webPushSubscriptions.endpoint,
        set: {
          p256dh: sub.p256dh,
          auth: sub.auth,
          deviceLabel: sub.deviceLabel ?? "",
        },
      });
  }

  async function deleteSubscription(endpoint: string) {
    await db
      .delete(webPushSubscriptions)
      .where(eq(webPushSubscriptions.endpoint, endpoint));
  }

  async function listSubscriptions() {
    return db
      .select()
      .from(webPushSubscriptions)
      .orderBy(webPushSubscriptions.createdAt);
  }

  async function pruneDeadSubscription(endpoint: string) {
    await db
      .delete(webPushSubscriptions)
      .where(eq(webPushSubscriptions.endpoint, endpoint));
    logger.info({ endpoint }, "Pruned dead Web Push subscription");
  }

  async function sendToSubscription(
    sub: { endpoint: string; p256dh: string; auth: string },
    payload: PushPayload,
  ): Promise<{ sent: boolean; pruned: boolean }> {
    if (!configureWebPush()) {
      logger.warn("VAPID keys not configured — skipping Web Push send");
      return { sent: false, pruned: false };
    }

    try {
      await webPush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        JSON.stringify(payload),
      );
      return { sent: true, pruned: false };
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        await pruneDeadSubscription(sub.endpoint);
        return { sent: false, pruned: true };
      }
      logger.warn({ err, endpoint: sub.endpoint }, "Web Push send failed");
      return { sent: false, pruned: false };
    }
  }

  async function sendToBoard(payload: PushPayload): Promise<{ sent: number; pruned: number }> {
    if (!configureWebPush()) {
      logger.warn("VAPID keys not configured — skipping sendToBoard");
      return { sent: 0, pruned: 0 };
    }

    const subs = await listSubscriptions();
    let sent = 0;
    let pruned = 0;

    await Promise.all(
      subs.map(async (sub) => {
        const result = await sendToSubscription(sub, payload);
        if (result.sent) sent++;
        if (result.pruned) pruned++;
      }),
    );

    return { sent, pruned };
  }

  return {
    upsertSubscription,
    deleteSubscription,
    listSubscriptions,
    sendToSubscription,
    sendToBoard,
  };
}
