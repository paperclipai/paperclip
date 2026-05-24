import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const qualityScoreAdjustments = pgTable(
  "quality_score_adjustments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    briefingId: text("briefing_id").notNull(),
    userId: text("user_id").notNull(),
    rating: text("rating").notNull(),
    dimension: text("dimension").notNull(),
    adjustmentAmount: text("adjustment_amount").notNull(),
    previousScore: text("previous_score").notNull(),
    newScore: text("new_score").notNull(),
    adjustmentSource: text("adjustment_source").notNull(),
    reReviewTriggered: text("re_review_triggered"),
    tierChanged: text("tier_changed"),
    escalationLevel: text("escalation_level"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    briefingIdx: index("quality_score_adjustments_briefing_idx").on(table.briefingId),
    userIdx: index("quality_score_adjustments_user_idx").on(table.userId),
  }),
);
