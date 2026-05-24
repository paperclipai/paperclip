import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const briefingNegativeRatingAlerts = pgTable("briefing_negative_rating_alerts", {
  id: uuid("id").primaryKey().defaultRandom(),
  briefingId: text("briefing_id").notNull().unique(),
  negativeCount: integer("negative_count").notNull(),
  alertedAt: timestamp("alerted_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
