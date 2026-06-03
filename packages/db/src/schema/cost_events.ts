import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  bigint,
  numeric,
  char,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { authUsers } from "./auth.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";
import { goals } from "./goals.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

// Cost attribution + frozen-pricing event log. Schema tracks the budgeting
// policy §2.1 (docs/policies/2026-05-13-agent-budgeting.md in the eli-board
// blueprint). Naming reconciliation vs the policy:
//   - policy `runId`   == column `heartbeat_run_id` (FK heartbeat_runs)
//   - policy `eventAt` == column `occurred_at`
// Fields added for §2.1 are nullable so legacy rows (written before the policy)
// remain valid; the POST /cost/charge endpoint (ELI-72) enforces the
// policy-required non-null subset on insert. See the migration's backfill note.
export const costEvents = pgTable(
  "cost_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    // §2.1: agentId is nullable — null for human-initiated actions and for
    // source-less system/timer charges (e.g. a provider-health probe), which are
    // first-class in the run-health / auditability model, not an exception path.
    // Relaxed from NOT NULL by the charge writer (ELI-75); existing consumers
    // (costs/budgets/finance) read it as `string | null` and group/join cleanly
    // on null.
    agentId: uuid("agent_id").references(() => agents.id),
    userId: text("user_id").references(() => authUsers.id),
    issueId: uuid("issue_id").references(() => issues.id),
    projectId: uuid("project_id").references(() => projects.id),
    goalId: uuid("goal_id").references(() => goals.id),
    heartbeatRunId: uuid("heartbeat_run_id").references(() => heartbeatRuns.id),
    billingCode: text("billing_code"),
    provider: text("provider").notNull(),
    biller: text("biller").notNull().default("unknown"),
    billingType: text("billing_type").notNull().default("unknown"),
    model: text("model").notNull(),
    // §2.1 kind: tokens|requests|seconds|storage_bytes_day|egress_bytes|storage_bytes|fixed
    kind: text("kind"),
    qty: numeric("qty", { precision: 20, scale: 6 }),
    inputTokens: integer("input_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }),
    // Legacy integer-cents cost; retained for back-compat with existing writers.
    costCents: integer("cost_cents").notNull(),
    // §2.1 frozen-pricing fields. Integer micro-units (1 unit = 1_000_000 micros).
    unitPriceMicros: bigint("unit_price_micros", { mode: "number" }),
    costMicros: bigint("cost_micros", { mode: "number" }),
    currency: char("currency", { length: 3 }),
    pricebookVersion: text("pricebook_version"),
    requestId: text("request_id"),
    // §2.1 idempotencyKey: deduplicates retries; unique index below. Nullable so
    // legacy rows do not collide (Postgres unique index permits multiple NULLs).
    idempotencyKey: text("idempotency_key"),
    meta: jsonb("meta"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // policy index (companyId, eventAt)
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
    // policy index (provider, model, eventAt)
    providerModelOccurredIdx: index("cost_events_provider_model_occurred_idx").on(
      table.provider,
      table.model,
      table.occurredAt,
    ),
    // policy index (agentId, eventAt)
    agentOccurredIdx: index("cost_events_agent_occurred_idx").on(table.agentId, table.occurredAt),
    // policy index (projectId, eventAt)
    projectOccurredIdx: index("cost_events_project_occurred_idx").on(table.projectId, table.occurredAt),
    // policy unique idempotencyKey
    idempotencyKeyUq: uniqueIndex("cost_events_idempotency_key_uq").on(table.idempotencyKey),
  }),
);
