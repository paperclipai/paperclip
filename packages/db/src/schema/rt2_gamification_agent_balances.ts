import { pgTable, uuid, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * Agent gold balances - tracks gold currency per agent
 */
export const rt2GamificationAgentBalances = pgTable(
  "rt2_gamification_agent_balances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    // Current gold balance
    balance: integer("balance").notNull().default(0),
    // Lifetime earned (for stats)
    lifetimeEarned: integer("lifetime_earned").notNull().default(0),
    // Lifetime spent (for stats)
    lifetimeSpent: integer("lifetime_spent").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentIdx: index("agent_balances_company_agent_idx").on(table.companyId, table.agentId),
    companyBalanceIdx: index("agent_balances_company_balance_idx").on(table.companyId, table.balance),
  }),
);
