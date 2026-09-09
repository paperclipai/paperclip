import { pgTable, uuid, text, timestamp, integer, boolean, index, uniqueIndex, sql } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const healthGoals = pgTable(
  "health_goals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: text("user_id").notNull(),
    goalType: text("goal_type").notNull(),
    targetValue: integer("target_value").notNull(),
    unit: text("unit").notNull(),
    label: text("label").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userCompanyIdx: index("health_goals_user_company_idx").on(table.userId, table.companyId),
    userTypeUq: uniqueIndex("health_goals_user_type_uq")
      .on(table.companyId, table.userId, table.goalType)
      .where(sql`is_active = true`),
  }),
);
