import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { anthropicAccounts } from "./anthropic_accounts.js";

export const anthropicActiveAccount = pgTable("anthropic_active_account", {
  companyId: uuid("company_id")
    .primaryKey()
    .references(() => companies.id, { onDelete: "cascade" }),
  accountId: uuid("account_id")
    .notNull()
    .references(() => anthropicAccounts.id, { onDelete: "cascade" }),
  setAt: timestamp("set_at", { withTimezone: true }).notNull().defaultNow(),
  setByAgentId: uuid("set_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
  setByUserId: text("set_by_user_id"),
});

export type AnthropicActiveAccount = typeof anthropicActiveAccount.$inferSelect;
export type NewAnthropicActiveAccount = typeof anthropicActiveAccount.$inferInsert;
