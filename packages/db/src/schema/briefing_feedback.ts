import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const briefingFeedback = pgTable(
  "briefing_feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    briefingId: text("briefing_id").notNull(),
    userId: text("user_id").notNull(),
    rating: text("rating").notNull(),
    category: text("category"),
    freeText: text("free_text"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    briefingIdx: index("briefing_feedback_briefing_idx").on(table.briefingId),
    userIdx: index("briefing_feedback_user_idx").on(table.userId, table.createdAt),
  }),
);
