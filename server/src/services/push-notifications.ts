import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { pushSubscriptions } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

export interface PushSubscriptionKeys {
  p256dh: string;
  auth: string;
}

export interface PushSubscriptionInput {
  companyId: string;
  userId: string;
  endpoint: string;
  keys: PushSubscriptionKeys;
  notifyTaskComplete?: boolean;
  notifyAgentQuestion?: boolean;
  notifyBoardReview?: boolean;
}

export interface PushPreferencesInput {
  notifyTaskComplete?: boolean;
  notifyAgentQuestion?: boolean;
  notifyBoardReview?: boolean;
}

export type PushNotificationType = "task_complete" | "agent_question" | "board_review";

export interface PushPayload {
  title: string;
  body?: string;
  url?: string;
  type: PushNotificationType;
}

let webPush: typeof import("web-push") | null = null;

async function getWebPush() {
  if (!webPush) {
    const mod = await import("web-push");
    // CJS module — functions live on `.default` when dynamically imported from ESM
    webPush = (mod.default ?? mod) as typeof import("web-push");
  }
  return webPush;
}

function getVapidKeys() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT ?? "mailto:admin@paperclip.dev";
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject };
}

export function pushNotificationService(db: Db) {
  return {
    getVapidPublicKey() {
      return getVapidKeys()?.publicKey ?? null;
    },

    async subscribe(input: PushSubscriptionInput) {
      const existing = await db
        .select()
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.endpoint, input.endpoint))
        .then((rows) => rows[0] ?? null);

      if (existing) {
        const [updated] = await db
          .update(pushSubscriptions)
          .set({
            companyId: input.companyId,
            userId: input.userId,
            keys: input.keys,
            notifyTaskComplete: input.notifyTaskComplete ?? existing.notifyTaskComplete,
            notifyAgentQuestion: input.notifyAgentQuestion ?? existing.notifyAgentQuestion,
            notifyBoardReview: input.notifyBoardReview ?? existing.notifyBoardReview,
            updatedAt: new Date(),
          })
          .where(eq(pushSubscriptions.id, existing.id))
          .returning();
        return updated!;
      }

      const [created] = await db
        .insert(pushSubscriptions)
        .values({
          companyId: input.companyId,
          userId: input.userId,
          endpoint: input.endpoint,
          keys: input.keys,
          notifyTaskComplete: input.notifyTaskComplete ?? true,
          notifyAgentQuestion: input.notifyAgentQuestion ?? true,
          notifyBoardReview: input.notifyBoardReview ?? true,
        })
        .returning();
      return created!;
    },

    async unsubscribe(endpoint: string) {
      const [deleted] = await db
        .delete(pushSubscriptions)
        .where(eq(pushSubscriptions.endpoint, endpoint))
        .returning();
      return deleted ?? null;
    },

    async updatePreferences(endpoint: string, prefs: PushPreferencesInput) {
      const [updated] = await db
        .update(pushSubscriptions)
        .set({
          ...prefs,
          updatedAt: new Date(),
        })
        .where(eq(pushSubscriptions.endpoint, endpoint))
        .returning();
      return updated ?? null;
    },

    async getSubscription(companyId: string, userId: string) {
      const rows = await db
        .select()
        .from(pushSubscriptions)
        .where(
          and(
            eq(pushSubscriptions.companyId, companyId),
            eq(pushSubscriptions.userId, userId),
          ),
        );
      return rows[0] ?? null;
    },

    async sendToCompany(companyId: string, payload: PushPayload) {
      const vapid = getVapidKeys();
      if (!vapid) return;

      const preferenceColumn =
        payload.type === "task_complete"
          ? pushSubscriptions.notifyTaskComplete
          : payload.type === "agent_question"
            ? pushSubscriptions.notifyAgentQuestion
            : pushSubscriptions.notifyBoardReview;

      const subs = await db
        .select()
        .from(pushSubscriptions)
        .where(
          and(
            eq(pushSubscriptions.companyId, companyId),
            eq(preferenceColumn, true),
          ),
        );

      if (subs.length === 0) return;

      const wp = await getWebPush();
      wp.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);

      const message = JSON.stringify(payload);

      await Promise.allSettled(
        subs.map(async (sub) => {
          try {
            await wp.sendNotification(
              {
                endpoint: sub.endpoint,
                keys: sub.keys as PushSubscriptionKeys,
              },
              message,
            );
          } catch (err: unknown) {
            const statusCode = (err as { statusCode?: number }).statusCode;
            if (statusCode === 404 || statusCode === 410) {
              await db
                .delete(pushSubscriptions)
                .where(eq(pushSubscriptions.id, sub.id));
              logger.info({ endpoint: sub.endpoint }, "removed expired push subscription");
            } else {
              logger.warn({ err, endpoint: sub.endpoint }, "failed to send push notification");
            }
          }
        }),
      );
    },
  };
}
