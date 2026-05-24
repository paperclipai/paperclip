import type { Db } from "@paperclipai/db";
import { crewRatingFlags } from "@paperclipai/db";
import { eq, and, sql } from "drizzle-orm";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function crewRatingFlagsService(db: Db) {
  async function incrementFlag(userId: string, ratingType: "somewhat" | "no"): Promise<{ count: number; thresholdMet: boolean }> {
    const now = new Date();
    const existing = await db
      .select()
      .from(crewRatingFlags)
      .where(
        and(
          eq(crewRatingFlags.userId, userId),
          eq(crewRatingFlags.ratingType, ratingType),
        ),
      )
      .limit(1);

    if (existing.length === 0) {
      await db.insert(crewRatingFlags).values({
        userId,
        ratingType,
        count: 1,
        windowStart: now,
      });
      return { count: 1, thresholdMet: false };
    }

    const flag = existing[0];
    const windowStart = new Date(flag.windowStart);
    const windowElapsed = now.getTime() - windowStart.getTime();

    if (windowElapsed > SEVEN_DAYS_MS) {
      await db
        .update(crewRatingFlags)
        .set({
          count: 1,
          windowStart: now,
          lastTriggeredAt: sql`case when ${crewRatingFlags.count} >= 3 then now() else ${crewRatingFlags.lastTriggeredAt} end`,
        })
        .where(eq(crewRatingFlags.id, flag.id));
      return { count: 1, thresholdMet: false };
    }

    const newCount = flag.count + 1;
    const thresholdMet = (ratingType === "somewhat" && newCount >= 3) || (ratingType === "no" && newCount >= 3);

    await db
      .update(crewRatingFlags)
      .set({
        count: newCount,
        lastTriggeredAt: thresholdMet ? now : flag.lastTriggeredAt,
      })
      .where(eq(crewRatingFlags.id, flag.id));

    return { count: newCount, thresholdMet };
  }

  return { incrementFlag };
}

export type CrewRatingFlagsService = ReturnType<typeof crewRatingFlagsService>;
