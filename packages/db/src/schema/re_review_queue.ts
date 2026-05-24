import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const reReviewQueue = pgTable(
  "re_review_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    briefingId: text("briefing_id").notNull(),
    userId: text("user_id").notNull(),
    rating: text("rating").notNull(),
    triggerReason: text("trigger_reason").notNull(),
    status: text("status").notNull().default("pending"),
    assignedReviewerId: text("assigned_reviewer_id"),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    briefingIdx: index("re_review_queue_briefing_idx").on(table.briefingId),
    statusIdx: index("re_review_queue_status_idx").on(table.status),
    dueAtIdx: index("re_review_queue_due_at_idx").on(table.dueAt),
  }),
);
