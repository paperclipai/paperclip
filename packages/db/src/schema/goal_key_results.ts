import {
  pgTable,
  uuid,
  text,
  numeric,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { goals } from "./goals.js";
import { companies } from "./companies.js";

export const goalKeyResults = pgTable(
  "goal_key_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    goalId: uuid("goal_id").notNull().references(() => goals.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    targetValue: numeric("target_value").notNull().default("100"),
    currentValue: numeric("current_value").notNull().default("0"),
    unit: text("unit").notNull().default("%"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    goalIdx: index("goal_key_results_goal_idx").on(table.goalId),
  }),
);
