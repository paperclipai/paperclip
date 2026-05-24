import type { Db } from "@paperclipai/db";
import { reReviewQueue } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import type { ReReviewQueueItem, ReReviewTriggerReason } from "@paperclipai/shared";

export function reReviewQueueService(db: Db) {
  async function create(
    briefingId: string,
    userId: string,
    rating: string,
    triggerReason: ReReviewTriggerReason,
    dueAt: Date,
  ): Promise<ReReviewQueueItem> {
    const [row] = await db
      .insert(reReviewQueue)
      .values({
        briefingId,
        userId,
        rating,
        triggerReason,
        dueAt,
      })
      .returning();
    return row as ReReviewQueueItem;
  }

  async function listPending(): Promise<ReReviewQueueItem[]> {
    const rows = await db
      .select()
      .from(reReviewQueue)
      .where(eq(reReviewQueue.status, "pending"))
      .orderBy(reReviewQueue.dueAt);
    return rows as ReReviewQueueItem[];
  }

  async function markCompleted(id: string): Promise<void> {
    await db
      .update(reReviewQueue)
      .set({
        status: "completed",
        completedAt: new Date(),
      })
      .where(eq(reReviewQueue.id, id));
  }

  return { create, listPending, markCompleted };
}

export type ReReviewQueueService = ReturnType<typeof reReviewQueueService>;
