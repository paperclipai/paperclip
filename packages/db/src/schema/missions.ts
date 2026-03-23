import { pgTable, uuid, text, timestamp, decimal, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";

export const missions = pgTable(
  "missions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    objectives: text("objectives").array().notNull().default([]),
    status: text("status").notNull().default("draft"),
    autonomyLevel: text("autonomy_level").notNull().default("copilot"),
    budgetCapUsd: decimal("budget_cap_usd", { precision: 10, scale: 4 }),
    digestSchedule: text("digest_schedule").notNull().default("daily"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    oneActiveMission: uniqueIndex("missions_one_active_per_company")
      .on(table.companyId)
      .where(sql`${table.status} = 'active'`),
  }),
);
