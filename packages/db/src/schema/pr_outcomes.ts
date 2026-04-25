import { index, integer, boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const prOutcomes = pgTable(
  "pr_outcomes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    prId: text("pr_id").notNull().unique(),
    companyId: uuid("company_id").notNull(),
    mergedAt: timestamp("merged_at", { withTimezone: true }),
    followUpFixCount: integer("follow_up_fix_count").notNull().default(0),
    regressionCaused: boolean("regression_caused").notNull().default(false),
    revertedAt: timestamp("reverted_at", { withTimezone: true }),
    customerImpact: text("customer_impact"),
    insertedAt: timestamp("inserted_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdIdx: index("pr_outcomes_company_id_idx").on(table.companyId),
    prIdIdx: index("pr_outcomes_pr_id_idx").on(table.prId),
  }),
);

export type PrOutcome = typeof prOutcomes.$inferSelect;
export type NewPrOutcome = typeof prOutcomes.$inferInsert;

