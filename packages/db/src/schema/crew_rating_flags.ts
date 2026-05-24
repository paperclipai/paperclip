import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const crewRatingFlags = pgTable(
  "crew_rating_flags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    ratingType: text("rating_type").notNull(),
    count: integer("count").notNull().default(1),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull().defaultNow(),
    lastTriggeredAt: timestamp("last_triggered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userRatingIdx: index("crew_rating_flags_user_rating_idx").on(table.userId, table.ratingType),
  }),
);
