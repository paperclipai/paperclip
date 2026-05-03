import webpush from "web-push";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { webPushSubscriptions } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

export interface WebPushPayload {
  title: string;
  body: string;
  url: string;
  tag?: string;
}

let configured = false;
function ensureConfigured(): boolean {
  if (configured) return true;
  const publicKey = process.env.WEB_PUSH_VAPID_PUBLIC?.trim();
  const privateKey = process.env.WEB_PUSH_VAPID_PRIVATE?.trim();
  const contact = process.env.WEB_PUSH_CONTACT?.trim() || "mailto:noreply@paperclip.local";
  if (!publicKey || !privateKey) return false;
  webpush.setVapidDetails(contact, publicKey, privateKey);
  configured = true;
  return true;
}

export function getVapidPublicKey(): string | null {
  return process.env.WEB_PUSH_VAPID_PUBLIC?.trim() ?? null;
}

export function webPushService(db: Db) {
  return {
    async sendToUser(userId: string, payload: WebPushPayload): Promise<{ sent: number; removed: number }> {
      if (!ensureConfigured()) {
        logger.debug({ userId }, "web push skipped — VAPID keys not configured");
        return { sent: 0, removed: 0 };
      }
      const subs = await db
        .select()
        .from(webPushSubscriptions)
        .where(eq(webPushSubscriptions.userId, userId));
      if (subs.length === 0) return { sent: 0, removed: 0 };

      const json = JSON.stringify(payload);
      let sent = 0;
      let removed = 0;
      await Promise.all(
        subs.map(async (sub) => {
          try {
            await webpush.sendNotification(
              {
                endpoint: sub.endpoint,
                keys: { p256dh: sub.p256dh, auth: sub.auth },
              },
              json,
            );
            sent += 1;
          } catch (err: unknown) {
            const status =
              err && typeof err === "object" && "statusCode" in err
                ? Number((err as { statusCode?: number }).statusCode)
                : null;
            if (status === 404 || status === 410) {
              await db
                .delete(webPushSubscriptions)
                .where(
                  and(
                    eq(webPushSubscriptions.userId, userId),
                    eq(webPushSubscriptions.endpoint, sub.endpoint),
                  ),
                );
              removed += 1;
            } else {
              logger.warn({ err, userId, endpoint: sub.endpoint, status }, "web push send failed");
            }
          }
        }),
      );
      return { sent, removed };
    },

    async listForUser(userId: string) {
      return db
        .select({
          id: webPushSubscriptions.id,
          endpoint: webPushSubscriptions.endpoint,
          userAgent: webPushSubscriptions.userAgent,
          createdAt: webPushSubscriptions.createdAt,
        })
        .from(webPushSubscriptions)
        .where(eq(webPushSubscriptions.userId, userId));
    },

    async upsert(input: {
      userId: string;
      endpoint: string;
      p256dh: string;
      auth: string;
      userAgent: string | null;
    }) {
      const [row] = await db
        .insert(webPushSubscriptions)
        .values(input)
        .onConflictDoUpdate({
          target: [webPushSubscriptions.userId, webPushSubscriptions.endpoint],
          set: {
            p256dh: input.p256dh,
            auth: input.auth,
            userAgent: input.userAgent,
          },
        })
        .returning();
      return row;
    },

    async remove(userId: string, endpoint: string) {
      await db
        .delete(webPushSubscriptions)
        .where(
          and(
            eq(webPushSubscriptions.userId, userId),
            eq(webPushSubscriptions.endpoint, endpoint),
          ),
        );
    },
  };
}

export type WebPushService = ReturnType<typeof webPushService>;
