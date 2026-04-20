import { pgEnum, pgTable, uuid, text, timestamp, numeric, boolean, index, jsonb } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const financialAccountTypeEnum = pgEnum("financial_account_type", [
  "checking",
  "savings",
  "investment",
  "retirement",
  "credit",
  "loan",
  "mortgage",
  "other",
]);

export const estateFinancialAccounts = pgTable(
  "estate_financial_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    institutionName: text("institution_name"),
    accountType: financialAccountTypeEnum("account_type").notNull(),
    entityId: text("entity_id"),
    // Plaid fields (null for manual accounts)
    plaidAccessToken: text("plaid_access_token"),
    plaidItemId: text("plaid_item_id"),
    plaidAccountId: text("plaid_account_id"),
    // Current balance in cents; updated by Plaid webhook or manual entry
    balanceCents: numeric("balance_cents", { precision: 20, scale: 0 }),
    balanceUpdatedAt: timestamp("balance_updated_at", { withTimezone: true }),
    isManual: boolean("is_manual").notNull().default(false),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUserIdx: index("estate_financial_accounts_company_user_idx").on(table.companyId, table.userId),
    plaidItemIdx: index("estate_financial_accounts_plaid_item_idx").on(table.plaidItemId),
    entityIdx: index("estate_financial_accounts_entity_idx").on(table.entityId),
  }),
);

export const estateBalanceHistory = pgTable(
  "estate_balance_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull().references(() => estateFinancialAccounts.id),
    balanceCents: numeric("balance_cents", { precision: 20, scale: 0 }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountRecordedAtIdx: index("estate_balance_history_account_recorded_at_idx").on(
      table.accountId,
      table.recordedAt,
    ),
  }),
);
