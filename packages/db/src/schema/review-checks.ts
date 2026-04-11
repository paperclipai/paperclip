import { pgTable, uuid, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { reviewRuns } from "./review-runs.js";
import { agents } from "./agents.js";

export const reviewChecks = pgTable(
  "review_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reviewRunId: uuid("review_run_id")
      .notNull()
      .references(() => reviewRuns.id, { onDelete: "cascade" }),
    stepSlug: text("step_slug").notNull(),
    stepName: text("step_name").notNull(),
    stepType: text("step_type").notNull(),
    executor: text("executor").notNull(),
    status: text("status").notNull().default("pending"),
    summary: text("summary"),
    details: jsonb("details").$type<Record<string, unknown>>(),
    checkedByAgentId: uuid("checked_by_agent_id").references(() => agents.id),
    checkedByUserId: uuid("checked_by_user_id"),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    reviewRunIdx: index("review_checks_review_run_idx").on(table.reviewRunId),
  }),
);
