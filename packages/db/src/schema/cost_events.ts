import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, integer, index, numeric, uniqueIndex, check, jsonb } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";
import { goals } from "./goals.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const costEvents = pgTable(
  "cost_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    projectId: uuid("project_id").references(() => projects.id),
    goalId: uuid("goal_id").references(() => goals.id),
    heartbeatRunId: uuid("heartbeat_run_id").references(() => heartbeatRuns.id),
    billingCode: text("billing_code"),
    idempotencyKey: text("idempotency_key"),
    receiptHash: text("receipt_hash"),
    providerRequestId: text("provider_request_id"),
    reportedCostCents: numeric("reported_cost_cents", { precision: 24, scale: 7 }),
    pricingProvenance: jsonb("pricing_provenance").$type<Record<string, unknown>>(),
    provider: text("provider").notNull(),
    biller: text("biller").notNull().default("unknown"),
    billingType: text("billing_type").notNull().default("unknown"),
    costStatus: text("cost_status").notNull().default("reported"),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costCents: numeric("cost_cents", { precision: 24, scale: 7, mode: "number" }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    receiptUniqueIdx: uniqueIndex("cost_events_company_receipt_idx").on(table.companyId, table.idempotencyKey),
    providerRequestIdx: index("cost_events_provider_request_idx").on(table.companyId, table.biller, table.providerRequestId),
    nonnegativeAmounts: check("cost_events_nonnegative_amounts", sql`${table.costCents} >= 0 and ${table.inputTokens} >= 0 and ${table.cachedInputTokens} >= 0 and ${table.outputTokens} >= 0`),
    companyProjectOccurredIdx: index("cost_events_company_project_occurred_idx").on(table.companyId, table.projectId, table.occurredAt),
    unpricedIdx: index("cost_events_unpriced_idx").on(table.companyId, table.occurredAt, table.id).where(sql`${table.costStatus} = 'unpriced' and ${table.billingType} <> 'subscription_included'`),
    companyOccurredIdx: index("cost_events_company_occurred_idx").on(table.companyId, table.occurredAt),
    companyAgentOccurredIdx: index("cost_events_company_agent_occurred_idx").on(
      table.companyId,
      table.agentId,
      table.occurredAt,
    ),
    companyProviderOccurredIdx: index("cost_events_company_provider_occurred_idx").on(
      table.companyId,
      table.provider,
      table.occurredAt,
    ),
    companyBillerOccurredIdx: index("cost_events_company_biller_occurred_idx").on(
      table.companyId,
      table.biller,
      table.occurredAt,
    ),
    companyHeartbeatRunIdx: index("cost_events_company_heartbeat_run_idx").on(
      table.companyId,
      table.heartbeatRunId,
    ),
  }),
);
