import type { Db } from "@paperclipai/db";
import { briefingFeedback } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import type { BriefingFeedback, BriefingFeedbackCreate, FeedbackTrends } from "@paperclipai/shared";
import { briefingFeedbackAlertsService } from "./briefing-feedback-alerts.js";

export function briefingFeedbackService(db: Db) {
  async function submit(input: BriefingFeedbackCreate): Promise<BriefingFeedback> {
    const [row] = await db
      .insert(briefingFeedback)
      .values({
        briefingId: input.briefingId,
        userId: input.userId,
        rating: input.rating,
        category: input.category ?? null,
        freeText: input.freeText ?? null,
      })
      .returning();

    if (input.rating === "no" || input.rating === "somewhat") {
      try {
        await briefingFeedbackAlertsService(db).checkAndAlert(input.briefingId);
      } catch (err) {
        console.warn("[briefing-feedback-alerts] failed to check threshold", err);
      }
    }

    return row as BriefingFeedback;
  }

  async function listByBriefing(briefingId: string): Promise<BriefingFeedback[]> {
    const rows = await db
      .select()
      .from(briefingFeedback)
      .where(eq(briefingFeedback.briefingId, briefingId))
      .orderBy(briefingFeedback.createdAt);

    return rows as BriefingFeedback[];
  }

  async function getTrends(): Promise<FeedbackTrends> {
    const allFeedback = await db
      .select()
      .from(briefingFeedback)
      .orderBy(sql`${briefingFeedback.createdAt} desc`)
      .limit(50);

    const ratingMap = new Map<string, number>();
    const categoryMap = new Map<string | null, number>();

    for (const fb of allFeedback) {
      ratingMap.set(fb.rating, (ratingMap.get(fb.rating) ?? 0) + 1);
      const cat = fb.category ?? null;
      categoryMap.set(cat, (categoryMap.get(cat) ?? 0) + 1);
    }

    const ratingBreakdown = Array.from(ratingMap.entries()).map(([rating, count]) => ({
      rating: rating as BriefingFeedback["rating"],
      count,
    }));

    const categoryBreakdown = Array.from(categoryMap.entries()).map(([category, count]) => ({
      category: category as BriefingFeedback["category"],
      count,
    }));

    return {
      totalCount: allFeedback.length,
      ratingBreakdown,
      categoryBreakdown,
      recentFeedback: allFeedback.slice(0, 20) as BriefingFeedback[],
    };
  }

  return { submit, listByBriefing, getTrends };
}

export type BriefingFeedbackService = ReturnType<typeof briefingFeedbackService>;
