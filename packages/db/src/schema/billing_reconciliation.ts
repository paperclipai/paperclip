import { pgTable, uuid, date, integer, numeric, jsonb, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const billingReconciliation = pgTable(
  "billing_reconciliation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    date: date("date").notNull(),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    paperclipCents: integer("paperclip_cents").notNull(),
    anthropicCents: integer("anthropic_cents").notNull(),
    driftPct: numeric("drift_pct", { precision: 6, scale: 2 }).notNull(),
    rawAnthropicRow: jsonb("raw_anthropic_row").notNull().$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    dateAgentUq: uniqueIndex("billing_reconciliation_date_agent_uq").on(table.date, table.agentId),
    companyDateIdx: index("billing_reconciliation_company_date_idx").on(table.companyId, table.date),
  }),
);
