import { pgTable, uuid, date, integer, numeric, jsonb, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const billingReconciliation = pgTable(
  "billing_reconciliation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    date: date("date").notNull(),
    // null = company-level (org) row. Per-agent rows are deferred until
    // metadata.user_id tagging is feasible in the adapter layer.
    agentId: uuid("agent_id"),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    paperclipCents: integer("paperclip_cents").notNull(),
    anthropicCents: integer("anthropic_cents").notNull(),
    driftPct: numeric("drift_pct", { precision: 6, scale: 2 }).notNull(),
    rawAnthropicRow: jsonb("raw_anthropic_row").notNull().$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    dateCompanyUq: uniqueIndex("billing_reconciliation_date_company_uq").on(table.date, table.companyId),
    companyDateIdx: index("billing_reconciliation_company_date_idx").on(table.companyId, table.date),
  }),
);
