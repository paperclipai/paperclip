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

export class PushSubscriptionOwnershipConflictError extends Error {
  constructor() {
    super("Push endpoint is already registered to another user");
    this.name = "PushSubscriptionOwnershipConflictError";
  }
}

export function pushSubscriptionService(db: Db) {
  return {
    async subscribe(
      companyId: string,
      userId: string,
      input: { endpoint: string; p256dh: string; auth: string },
    ): Promise<PushSubscriptionRecord> {
      const [inserted] = await db
        .insert(companyUserPushSubscriptions)
        .values({
          companyId,
          userId,
          endpoint: input.endpoint,
          p256dh: input.p256dh,
          auth: input.auth,
        })
        .onConflictDoNothing()
        .returning();
      if (inserted) return inserted as PushSubscriptionRecord;

      const [existing] = await db
        .select()
        .from(companyUserPushSubscriptions)
        .where(eq(companyUserPushSubscriptions.endpoint, input.endpoint));
      if (!existing || existing.companyId !== companyId || existing.userId !== userId) {
        throw new PushSubscriptionOwnershipConflictError();
      }

      const [updated] = await db
        .update(companyUserPushSubscriptions)
        .set({ p256dh: input.p256dh, auth: input.auth, revokedAt: null })
        .where(eq(companyUserPushSubscriptions.id, existing.id))
        .returning();
      return updated as PushSubscriptionRecord;
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

    async listActiveForCompany(companyId: string): Promise<PushSubscriptionRecord[]> {
      const rows = await db
        .select()
        .from(companyUserPushSubscriptions)
        .where(and(
          eq(companyUserPushSubscriptions.companyId, companyId),
          isNull(companyUserPushSubscriptions.revokedAt),
        ));
      return rows as PushSubscriptionRecord[];
    },
  };
}

export type PushSubscriptionService = ReturnType<typeof pushSubscriptionService>;
