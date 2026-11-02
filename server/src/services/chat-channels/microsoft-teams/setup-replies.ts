import { chatDeliveries, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { notifyChatDeliveryWork } from "../../chat-work-notifications.js";

export async function deferTeamsSetupReply(
  db: Db,
  activeDelivery: Pick<typeof chatDeliveries.$inferSelect, "id" | "attempts">,
  redactedDestinationNormalized: typeof chatDeliveries.$inferSelect["normalizedEvent"],
  ORPHAN_FOLLOW_UP_MAX_ATTEMPTS: number,
  ORPHAN_FOLLOW_UP_GRACE_MS: number,
): Promise<void> {
  const resolutionAt = new Date();
  const waitForSetupRoot =
    activeDelivery.attempts <= ORPHAN_FOLLOW_UP_MAX_ATTEMPTS;
  await db.transaction(async (tx) => {
    await notifyChatDeliveryWork(tx);
    return tx
      .update(chatDeliveries)
      .set(
        waitForSetupRoot
          ? {
              state: "retry",
              nextAttemptAt: new Date(
                resolutionAt.getTime() + ORPHAN_FOLLOW_UP_GRACE_MS,
              ),
              redactedError: "Waiting briefly for an earlier root mention",
              updatedAt: resolutionAt,
            }
          : {
              state: "filtered",
              normalizedEvent: redactedDestinationNormalized,
              principalId: null,
              nextAttemptAt: null,
              processedAt: resolutionAt,
              redactedError: "Destination is not enabled in Paperclip",
              updatedAt: resolutionAt,
            },
      )
      .where(eq(chatDeliveries.id, activeDelivery.id));
  });
}
