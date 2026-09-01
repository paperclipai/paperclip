import { index, integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/** Mutable, non-authority scheduling state. Immutable Formal-QA receipts never
 * carry retry/backoff cursors. */
export const formalQaSchedulerStates = pgTable(
  "formal_qa_scheduler_states",
  {
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    stage: text("stage").notNull(),
    subjectId: uuid("subject_id").notNull(),
    cursor: integer("cursor").notNull().default(1),
    failureCount: integer("failure_count").notNull().default(0),
    nextEligibleAt: timestamp("next_eligible_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.stage, table.subjectId] }),
    dueIdx: index("formal_qa_scheduler_states_stage_due_idx")
      .on(table.stage, table.nextEligibleAt, table.subjectId),
    companyIdx: index("formal_qa_scheduler_states_company_idx").on(table.companyId),
  }),
);
