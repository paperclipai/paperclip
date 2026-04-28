import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, integer, index, check } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Personal P&L - tracks income and expenses per agent/user
 */
export const rt2PersonalPnL = pgTable(
  "rt2_personal_pnl",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    // userId or agentId depending on actorType
    actorId: text("actor_id").notNull(),
    actorType: text("actor_type").notNull(), // 'user' or 'agent'
    // Period (monthly: YYYY-MM)
    period: text("period").notNull(),
    // Income (gold earned)
    income: integer("income").notNull().default(0),
    // Expenses (gold spent)
    expenses: integer("expenses").notNull().default(0),
    // Net profit/loss
    netPnL: integer("net_pnl").notNull().default(0),
    // Budget allocation for this period
    budgetAllocated: integer("budget_allocated").notNull().default(0),
    // Budget used
    budgetUsed: integer("budget_used").notNull().default(0),
    // Timestamps
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyActorPeriodIdx: index("personal_pnl_company_actor_period_idx").on(
      table.companyId,
      table.actorId,
      table.period,
    ),
    companyPeriodIdx: index("personal_pnl_company_period_idx").on(table.companyId, table.period),
  }),
);

/**
 * Coin Ledger - game currency transaction log
 */
export const rt2CoinLedger = pgTable(
  "rt2_coin_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    // From actor (who paid)
    fromActorId: text("from_actor_id").notNull(),
    fromActorType: text("from_actor_type").notNull(), // 'user' or 'agent' or 'company'
    // To actor (who received)
    toActorId: text("to_actor_id").notNull(),
    toActorType: text("to_actor_type").notNull(), // 'user' or 'agent' or 'company'
    // Amount (positive for gain, negative for spend)
    amount: integer("amount").notNull(),
    // Balance after transaction
    balanceAfter: integer("balance_after").notNull(),
    // Transaction leg: 'credit' = increases balance, 'debit' = decreases balance
    leg: text("leg").notNull().default("credit"),
    // Transaction type
    transactionType: text("transaction_type").notNull(), // 'earned', 'spent', 'transferred', 'reward', 'penalty'
    // Description
    description: text("description"),
    // Reference to related entity (e.g., task, work product)
    referenceId: text("reference_id"),
    referenceType: text("reference_type"), // 'task', 'work_product', 'achievement', 'collaboration'
    // Period for aggregation (YYYY-MM)
    period: text("period").notNull(),
    // Timestamps
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyFromActorIdx: index("coin_ledger_company_from_actor_idx").on(
      table.companyId,
      table.fromActorId,
    ),
    companyToActorIdx: index("coin_ledger_company_to_actor_idx").on(
      table.companyId,
      table.toActorId,
    ),
    companyPeriodIdx: index("coin_ledger_company_period_idx").on(table.companyId, table.period),
    // LEDGER-04: leg column check constraint
    legCheck: check("rt2_coin_ledger_leg_check", sql`${table.leg} IN ('debit', 'credit')`),
    // LEDGER-05: balance_after non-negativity check constraint
    balanceNonNegCheck: check("rt2_coin_ledger_balance_non_neg_check", sql`${table.balanceAfter} >= 0`),
  }),
);
