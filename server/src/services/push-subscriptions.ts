import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyUserPushSubscriptions } from "@paperclipai/db";

export interface PushSubscriptionRecord {
  id: string;
  companyId: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: Date;
  revokedAt: Date | null;
}

export function pushSubscriptionService(db: Db) {
  return {
    async subscribe(
      companyId: string,
      userId: string,
      input: { endpoint: string; p256dh: string; auth: string },
    ): Promise<PushSubscriptionRecord> {
      const [row] = await db
        .insert(companyUserPushSubscriptions)
        .values({
          companyId,
          userId,
          endpoint: input.endpoint,
          p256dh: input.p256dh,
          auth: input.auth,
        })
        .onConflictDoUpdate({
          target: [companyUserPushSubscriptions.endpoint],
          set: {
            companyId,
            userId,
            p256dh: input.p256dh,
            auth: input.auth,
            revokedAt: null,
          },
        })
        .returning();
      return row as PushSubscriptionRecord;
    },

    async unsubscribe(companyId: string, userId: string, endpoint: string): Promise<{ revoked: boolean }> {
      const rows = await db
        .update(companyUserPushSubscriptions)
        .set({ revokedAt: new Date() })
        .where(and(
          eq(companyUserPushSubscriptions.companyId, companyId),
          eq(companyUserPushSubscriptions.userId, userId),
          eq(companyUserPushSubscriptions.endpoint, endpoint),
          isNull(companyUserPushSubscriptions.revokedAt),
        ))
        .returning({ id: companyUserPushSubscriptions.id });
      return { revoked: rows.length > 0 };
    },

    async revokeByEndpoint(endpoint: string): Promise<void> {
      await db
        .update(companyUserPushSubscriptions)
        .set({ revokedAt: new Date() })
        .where(and(
          eq(companyUserPushSubscriptions.endpoint, endpoint),
          isNull(companyUserPushSubscriptions.revokedAt),
        ));
    },

    async listActiveForUser(companyId: string, userId: string): Promise<PushSubscriptionRecord[]> {
      const rows = await db
        .select()
        .from(companyUserPushSubscriptions)
        .where(and(
          eq(companyUserPushSubscriptions.companyId, companyId),
          eq(companyUserPushSubscriptions.userId, userId),
          isNull(companyUserPushSubscriptions.revokedAt),
        ));
      return rows as PushSubscriptionRecord[];
    },
  };
}

export type PushSubscriptionService = ReturnType<typeof pushSubscriptionService>;
