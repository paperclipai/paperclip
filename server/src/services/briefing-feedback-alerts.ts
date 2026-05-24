import type { Db } from "@paperclipai/db";
import { briefingFeedback, briefingNegativeRatingAlerts } from "@paperclipai/db";
import { and, count, eq, inArray } from "drizzle-orm";
import { publishLiveEvent } from "./live-events.js";

const NEGATIVE_RATINGS = ["no", "somewhat"] as const;
const NEGATIVE_THRESHOLD = 3;

export function briefingFeedbackAlertsService(db: Db) {
  async function checkAndAlert(briefingId: string): Promise<{ alerted: boolean; negativeCount: number }> {
    const [result] = await db
      .select({ negativeCount: count() })
      .from(briefingFeedback)
      .where(
        and(
          eq(briefingFeedback.briefingId, briefingId),
          inArray(briefingFeedback.rating, NEGATIVE_RATINGS as unknown as [string, ...string[]]),
        ),
      );

    const negativeCount = result?.negativeCount ?? 0;

    if (negativeCount < NEGATIVE_THRESHOLD) {
      return { alerted: false, negativeCount };
    }

    const existing = await db
      .select({ id: briefingNegativeRatingAlerts.id })
      .from(briefingNegativeRatingAlerts)
      .where(eq(briefingNegativeRatingAlerts.briefingId, briefingId))
      .limit(1);

    if (existing.length > 0) {
      return { alerted: false, negativeCount };
    }

    await db.insert(briefingNegativeRatingAlerts).values({
      briefingId,
      negativeCount,
    });

    publishLiveEvent({
      companyId: "*",
      type: "activity.logged",
      payload: {
        actorType: "system",
        actorId: "briefing-feedback-alerts",
        action: "briefing.negative_rating_threshold_crossed",
        entityType: "briefing",
        entityId: briefingId,
        details: { negativeCount, threshold: NEGATIVE_THRESHOLD },
      },
    });

    return { alerted: true, negativeCount };
  }

  return { checkAndAlert };
}

export type BriefingFeedbackAlertsService = ReturnType<typeof briefingFeedbackAlertsService>;
