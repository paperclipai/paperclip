import { and, eq } from "drizzle-orm";
import { announcementDismissals, announcementPublications, type Db } from "@paperclipai/db";
import { persistActivity, publishActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";

export function announcementService(db: Db) {
  return {
    async registerPublication(announcementId: string) {
      await db.insert(announcementPublications).values({ announcementId }).onConflictDoNothing();
    },
    async isDismissed(userId: string, announcementId: string) {
      const row = await db.query.announcementDismissals.findFirst({
        where: and(eq(announcementDismissals.userId, userId), eq(announcementDismissals.announcementId, announcementId)),
      });
      return Boolean(row);
    },
    async dismiss(userId: string, announcementId: string, companyId: string) {
      const result = await db.transaction(async (tx) => {
        const known = await tx.query.announcementPublications.findFirst({
          where: eq(announcementPublications.announcementId, announcementId),
        });
        if (!known) {
          // Preserve idempotency for dismissals written before the registry was
          // added, but never create a new row or audit for an unknown ID.
          const existing = await tx.query.announcementDismissals.findFirst({
            where: and(eq(announcementDismissals.userId, userId), eq(announcementDismissals.announcementId, announcementId)),
          });
          return { known: Boolean(existing), publication: null };
        }
        const [inserted] = await tx.insert(announcementDismissals).values({ userId, announcementId })
          .onConflictDoNothing().returning();
        if (!inserted) return { known: true, publication: null };
        const activity = await persistActivity(tx as unknown as Db, {
          companyId, actorType: "user", actorId: userId,
          action: "announcement.dismissed", entityType: "announcement", entityId: announcementId,
        });
        return { known: true, publication: activity.publication };
      });
      if (result.publication) {
        try { publishActivity(result.publication); }
        catch { logger.warn("Could not publish committed announcement dismissal activity"); }
      }
      return result.known;
    },
  };
}
