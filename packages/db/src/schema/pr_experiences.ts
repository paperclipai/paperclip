import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const prExperiences = pgTable(
  "pr_experiences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    prId: text("pr_id").notNull(),
    companyId: uuid("company_id").notNull(),
    problemSummary: text("problem_summary").notNull(),
    solutionDiffSummary: text("solution_diff_summary").notNull(),
    reviewFeedback: text("review_feedback"),
    outcomeMetric: text("outcome_metric"),
    embedding: text("embedding"),
    insertedAt: timestamp("inserted_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdIdx: index("pr_experiences_company_id_idx").on(table.companyId),
    prIdIdx: index("pr_experiences_pr_id_idx").on(table.prId),
  }),
);

export type PrExperience = typeof prExperiences.$inferSelect;
export type NewPrExperience = typeof prExperiences.$inferInsert;