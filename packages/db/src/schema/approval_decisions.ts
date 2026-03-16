import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { approvals } from "./approvals.js";

export const approvalDecisions = pgTable(
  "approval_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    approvalId: uuid("approval_id").notNull().references(() => approvals.id),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: text("user_id").notNull(),
    decision: text("decision").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    approvalIdx: index("approval_decisions_approval_idx").on(table.approvalId),
    approvalUserUq: uniqueIndex("approval_decisions_approval_user_uq").on(
      table.approvalId,
      table.userId,
    ),
  }),
);
