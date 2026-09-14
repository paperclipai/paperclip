import { and, eq } from "drizzle-orm";
import { announcementDismissals, type Db } from "@paperclipai/db";
import { persistActivity, publishActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";

export function announcementService(db: Db) {
  return {
    async isDismissed(userId: string, announcementId: string) {
      const row = await db.query.announcementDismissals.findFirst({
        where: and(eq(announcementDismissals.userId, userId), eq(announcementDismissals.announcementId, announcementId)),
      });
      return Boolean(row);
    },
    async dismiss(userId: string, announcementId: string, companyId: string) {
      const publication = await db.transaction(async (tx) => {
        const [inserted] = await tx.insert(announcementDismissals).values({ userId, announcementId })
          .onConflictDoNothing().returning();
        if (!inserted) return null;
        const activity = await persistActivity(tx as unknown as Db, {
          companyId, actorType: "user", actorId: userId,
          action: "announcement.dismissed", entityType: "announcement", entityId: announcementId,
        });
        return activity.publication;
      });
      if (publication) {
        try { publishActivity(publication); }
        catch { logger.warn("Could not publish committed announcement dismissal activity"); }
      }
    },
  };
}
