import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const userCompanyPreferences = pgTable("user_company_preferences", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  primaryAgentId: uuid("primary_agent_id").references(() => agents.id, { onDelete: "set null" }),
  primaryAgentInitialized: boolean("primary_agent_initialized").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  companyUserUq: uniqueIndex("user_company_preferences_company_user_uq").on(table.companyId, table.userId),
  primaryAgentIdx: index("user_company_preferences_primary_agent_idx").on(table.primaryAgentId),
}));
