import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const providerBillingSnapshots = pgTable("provider_billing_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  accountId: text("account_id").notNull(),
  scopeId: text("scope_id").notNull(),
  day: text("day").notNull(),
  amountCents: numeric("amount_cents", { precision: 24, scale: 7 }).notNull(),
  revision: integer("revision").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  identity: uniqueIndex("provider_billing_snapshots_identity_idx").on(table.companyId, table.provider, table.accountId, table.scopeId, table.day),
  amount: check("provider_billing_snapshots_amount_check", sql`${table.amountCents} >= 0`),
}));
import { costEvents } from "./cost_events.js";

export const runUsageReceipts = pgTable("run_usage_receipts", {
  id: uuid("id").primaryKey(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  runId: uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
  sourceId: uuid("source_id").notNull(),
  sequence: integer("sequence").notNull(),
  receiptHash: text("receipt_hash").notNull(),
  receiptJson: jsonb("receipt_json").$type<Record<string, unknown>>().notNull(),
  complete: boolean("complete").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  sourceSequence: uniqueIndex("run_usage_receipts_source_sequence_idx").on(table.companyId, table.runId, table.sourceId, table.sequence),
  runLatest: index("run_usage_receipts_run_latest_idx").on(table.companyId, table.runId, table.receivedAt),
  positiveSequence: check("run_usage_receipts_positive_sequence", sql`${table.sequence} > 0`),
}));

export const accountingRuntimeBaselines = pgTable("accounting_runtime_baselines", {
  agentId: uuid("agent_id").primaryKey().references(() => agents.id, { onDelete: "cascade" }),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  // Historical totals are preserved explicitly. Only v2 acknowledgements add
  // to this baseline, including receipts whose occurrence date is backdated.
  costCents: numeric("cost_cents", { precision: 24, scale: 7 }).notNull(),
  inputTokens: numeric("input_tokens", { precision: 30, scale: 0 }).notNull(),
  cachedInputTokens: numeric("cached_input_tokens", { precision: 30, scale: 0 }).notNull(),
  outputTokens: numeric("output_tokens", { precision: 30, scale: 0 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({ company: index("accounting_runtime_baselines_company_idx").on(table.companyId) }));

export const budgetReservations = pgTable("budget_reservations", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "cascade" }),
  decisionInvocationId: uuid("decision_invocation_id"),
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
  projectId: uuid("project_id"),
  amountCents: numeric("amount_cents", { precision: 24, scale: 7 }).notNull(),
  state: text("state").notNull().default("held"),
  providerStartedAt: timestamp("provider_started_at", { withTimezone: true }),
  settledAt: timestamp("settled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  decision: uniqueIndex("budget_reservations_decision_idx").on(table.companyId, table.decisionInvocationId),
  source: check("budget_reservations_source_check", sql`(${table.runId} is not null)::int + (${table.decisionInvocationId} is not null)::int = 1`),
  run: uniqueIndex("budget_reservations_run_idx").on(table.companyId, table.runId),
  active: index("budget_reservations_active_idx").on(table.companyId, table.agentId, table.projectId).where(sql`${table.state} = 'held'`),
  stateCheck: check("budget_reservations_state_check", sql`${table.state} in ('held', 'settled', 'released')`),
  amountCheck: check("budget_reservations_amount_check", sql`${table.amountCents} >= 0`),
}));

export const billingInvoices = pgTable("billing_invoices", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  biller: text("biller").notNull(),
  externalId: text("external_id").notNull(),
  currency: text("currency").notNull(),
  receiptHash: text("receipt_hash").notNull(),
  importedBy: text("imported_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({ identity: uniqueIndex("billing_invoices_identity_idx").on(table.companyId, table.biller, table.externalId) }));

export const billingInvoiceLines = pgTable("billing_invoice_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  invoiceId: uuid("invoice_id").notNull().references(() => billingInvoices.id, { onDelete: "cascade" }),
  externalId: text("external_id").notNull(),
  kind: text("kind").notNull(),
  amountCents: numeric("amount_cents", { precision: 24, scale: 7 }).notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  costEventId: uuid("cost_event_id").references(() => costEvents.id, { onDelete: "cascade" }),
  runId: uuid("run_id"),
  providerRequestId: text("provider_request_id"),
  model: text("model"),
  pricing: jsonb("pricing").$type<Record<string, unknown>>().notNull().default({}),
}, table => ({
  identity: uniqueIndex("billing_invoice_lines_identity_idx").on(table.invoiceId, table.externalId),
  company: index("billing_invoice_lines_company_idx").on(table.companyId, table.invoiceId),
  amount: check("billing_invoice_lines_amount_check", sql`${table.amountCents} >= 0`),
  kindCheck: check("billing_invoice_lines_kind_check", sql`${table.kind} in ('inference', 'fee', 'credit')`),
}));

export const costAdjustments = pgTable("cost_adjustments", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  costEventId: uuid("cost_event_id").notNull().references(() => costEvents.id, { onDelete: "cascade" }),
  invoiceLineId: uuid("invoice_line_id").references(() => billingInvoiceLines.id, { onDelete: "cascade" }),
  idempotencyKey: text("idempotency_key").notNull(),
  receiptHash: text("receipt_hash").notNull(),
  previousCents: numeric("previous_cents", { precision: 24, scale: 7 }).notNull(),
  correctedCents: numeric("corrected_cents", { precision: 24, scale: 7 }).notNull(),
  previousStatus: text("previous_status").notNull(),
  previousPricing: jsonb("previous_pricing").$type<Record<string, unknown>>().notNull().default({}),
  reason: text("reason").notNull(),
  actorId: text("actor_id").notNull(),
  pricing: jsonb("pricing").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  identity: uniqueIndex("cost_adjustments_receipt_idx").on(table.companyId, table.idempotencyKey),
  event: index("cost_adjustments_event_idx").on(table.companyId, table.costEventId, table.createdAt),
  invoiceLine: uniqueIndex("cost_adjustments_invoice_line_idx").on(table.companyId, table.invoiceLineId),
  amount: check("cost_adjustments_amount_check", sql`${table.previousCents} >= 0 and ${table.correctedCents} >= 0`),
}));
