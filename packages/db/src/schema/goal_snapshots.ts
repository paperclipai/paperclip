import {
  pgTable,
  uuid,
  numeric,
  integer,
  bigint,
  date,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { goals } from "./goals.js";
import { companies } from "./companies.js";

export const goalSnapshots = pgTable(
  "goal_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    goalId: uuid("goal_id").notNull().references(() => goals.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    snapshotDate: date("snapshot_date").notNull(),
    progressPercent: numeric("progress_percent", { precision: 5, scale: 2 }),
    healthScore: integer("health_score"),
    confidence: integer("confidence"),
    totalIssues: integer("total_issues"),
    completedIssues: integer("completed_issues"),
    blockedIssues: integer("blocked_issues"),
    budgetSpentCents: bigint("budget_spent_cents", { mode: "bigint" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    goalDateIdx: index("goal_snapshots_goal_date_idx").on(table.goalId, table.snapshotDate),
  }),
);
