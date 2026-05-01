import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { rt2SettlementGovernance } from "./rt2_settlement_governance.js";

/**
 * Payroll runs — monthly batch payroll processing records (BILL-02)
 */
export const rt2PayrollRuns = pgTable(
  "rt2_payroll_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    period: text("period").notNull(), // YYYY-MM
    status: text("status").notNull().default("pending"), // pending | processing | completed | failed
    totalGrossGold: integer("total_gross_gold").notNull().default(0),
    totalNetGold: integer("total_net_gold").notNull().default(0),
    totalDeductions: integer("total_deductions").notNull().default(0),
    actorCount: integer("actor_count").notNull().default(0),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyPeriodUq: uniqueIndex("rt2_payroll_runs_company_period_uq").on(table.companyId, table.period),
    companyStatusIdx: index("rt2_payroll_runs_company_status_idx").on(table.companyId, table.status),
    periodIdx: index("rt2_payroll_runs_period_idx").on(table.period),
  }),
);

/**
 * Payroll run line items — per-actor payroll breakdown (BILL-02)
 */
export const rt2PayrollRunEntries = pgTable(
  "rt2_payroll_run_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    payrollRunId: uuid("payroll_run_id").notNull().references(() => rt2PayrollRuns.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    actorId: text("actor_id").notNull(),
    actorType: text("actor_type").notNull(), // 'user' | 'agent'
    grossGold: integer("gross_gold").notNull().default(0),
    platformFeeGold: integer("platform_fee_gold").notNull().default(0),
    operationalFeeGold: integer("operational_fee_gold").notNull().default(0),
    totalDeductionsGold: integer("total_deductions_gold").notNull().default(0),
    netGold: integer("net_gold").notNull().default(0),
    ledgerEntryId: uuid("ledger_entry_id"), // links to rt2CoinLedger for the net payment
    status: text("status").notNull().default("pending"), // pending | paid | failed
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    payrollRunIdx: index("rt2_payroll_run_entries_run_idx").on(table.payrollRunId),
    companyActorIdx: index("rt2_payroll_run_entries_company_actor_idx").on(table.companyId, table.actorId),
  }),
);

/**
 * Payment receipts — external payment provider evidence (BILL-03)
 * Stores bank transfer confirmations, payment provider receipts, etc.
 */
export const rt2PaymentReceipts = pgTable(
  "rt2_payment_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    payrollRunId: uuid("payroll_run_id").references(() => rt2PayrollRuns.id),
    settlementId: uuid("settlement_id").references(() => rt2SettlementGovernance.id),
    providerReference: text("provider_reference").notNull(), // external payment ID / bank reference
    providerName: text("provider_name").notNull().default("internal"), // 'bank_transfer', 'payment_provider', 'internal'
    amount: integer("amount").notNull(), // in gold units (like ledger)
    currency: text("currency").notNull().default("GOLD"),
    status: text("status").notNull().default("pending"), // pending | confirmed | failed | reconciled
    paidAt: timestamp("paid_at", { withTimezone: true }),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    reconciliationNotes: text("reconciliation_notes"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("rt2_payment_receipts_company_idx").on(table.companyId),
    settlementIdx: index("rt2_payment_receipts_settlement_idx").on(table.settlementId),
    payrollRunIdx: index("rt2_payment_receipts_payroll_run_idx").on(table.payrollRunId),
    providerRefIdx: uniqueIndex("rt2_payment_receipts_provider_ref_uq").on(table.companyId, table.providerReference),
    statusIdx: index("rt2_payment_receipts_status_idx").on(table.companyId, table.status),
  }),
);

/**
 * Settlement reconciliation records — links internal ledger entries to external receipts (BILL-03)
 */
export const rt2SettlementReconciliation = pgTable(
  "rt2_settlement_reconciliation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    settlementId: uuid("settlement_id").notNull().references(() => rt2SettlementGovernance.id),
    paymentReceiptId: uuid("payment_receipt_id").notNull().references(() => rt2PaymentReceipts.id),
    ledgerEntryId: uuid("ledger_entry_id"), // rt2CoinLedger entry matched
    amountMatched: integer("amount_matched").notNull().default(0), // 0 = full match
    discrepancyGold: integer("discrepancy_gold").notNull().default(0), // |ledger - receipt|
    reconciliationStatus: text("reconciliation_status").notNull().default("matched"), // matched | discrepancy | unresolved
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }).notNull().defaultNow(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    settlementIdx: uniqueIndex("rt2_settlement_reconciliation_settlement_uq").on(table.settlementId),
    receiptIdx: index("rt2_settlement_reconciliation_receipt_idx").on(table.paymentReceiptId),
    statusIdx: index("rt2_settlement_reconciliation_status_idx").on(table.companyId, table.reconciliationStatus),
  }),
);
