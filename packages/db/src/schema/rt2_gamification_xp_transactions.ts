import { pgTable, uuid, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";

/**
 * XP transaction history - tracks all XP gains/losses
 */
export const rt2GamificationXpTransactions = pgTable(
  "rt2_gamification_xp_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").references(() => agents.id),
    issueId: uuid("issue_id").references(() => issues.id),
    // Activity type that triggered XP change
    activityType: text("activity_type").notNull(),
    // XP amount (positive = gain, negative = loss)
    xpAmount: integer("xp_amount").notNull(),
    // Running balance after this transaction
    balanceAfter: integer("balance_after").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentIdx: index("xp_transactions_company_agent_idx").on(table.companyId, table.agentId),
    companyActivityIdx: index("xp_transactions_company_activity_idx").on(table.companyId, table.activityType),
    companyCreatedIdx: index("xp_transactions_company_created_idx").on(table.companyId, table.createdAt),
  }),
);
