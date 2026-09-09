import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const habitDefinitions = pgTable(
  "habit_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    color: text("color").notNull().default("#6366f1"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userCompanyIdx: index("habit_definitions_user_company_idx").on(t.userId, t.companyId),
  }),
);

export const habitCompletions = pgTable(
  "habit_completions",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),
    habitId: uuid("habit_id")
      .notNull()
      .references(() => habitDefinitions.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    userId: text("user_id").notNull(),
    completionDate: text("completion_date").notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    habitDateUq: uniqueIndex("habit_completions_habit_date_uq").on(t.habitId, t.completionDate),
    userCompanyIdx: index("habit_completions_user_company_idx").on(t.userId, t.companyId, t.completionDate),
  }),
);
