import { pgTable, uuid, text, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const workflowMaturity = pgTable(
  "workflow_maturity",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    workflowType: text("workflow_type").notNull(),
    maturityLevel: text("maturity_level").notNull().default("crawl"),
    totalCompleted: integer("total_completed").notNull().default(0),
    consecutivePasses: integer("consecutive_passes").notNull().default(0),
    rejectionsLast20: integer("rejections_last_20").notNull().default(0),
    promotedAt: timestamp("promoted_at", { withTimezone: true }),
    promotedByUserId: text("promoted_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyWorkflowIdx: uniqueIndex("workflow_maturity_company_workflow_idx").on(
      table.companyId,
      table.workflowType,
    ),
  }),
);
