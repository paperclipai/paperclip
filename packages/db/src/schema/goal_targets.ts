import { type AnyPgColumn, pgTable, uuid, text, boolean, integer, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { goals } from "./goals.js";

export const goalTargets = pgTable(
  "goal_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    goalId: uuid("goal_id").notNull().references(() => goals.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").references((): AnyPgColumn => goalTargets.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    checked: boolean("checked").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyGoalIdx: index("goal_targets_company_goal_idx").on(table.companyId, table.goalId),
  }),
);
