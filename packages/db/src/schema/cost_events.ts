import { pgTable, uuid, text, timestamp, integer, index } from "drizzle-orm/pg-core";
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
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // Agent deletion must not delete historical cost_events rows: company- and
    // project-scoped budget policies aggregate across all agents, so a hard
    // cascade here would silently erase real usage from those aggregates the
    // moment an agent is deleted, letting a company slip back under a cap it
    // had already tripped. Set-null preserves the row (and the company/project
    // totals) while dropping only the now-dangling agent attribution, mirroring
    // the issue_id/project_id/heartbeat_run_id precedent below.
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    goalId: uuid("goal_id").references(() => goals.id),
    heartbeatRunId: uuid("heartbeat_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    billingCode: text("billing_code"),
    provider: text("provider").notNull(),
    biller: text("biller").notNull().default("unknown"),
    billingType: text("billing_type").notNull().default("unknown"),
    costStatus: text("cost_status").notNull().default("reported"),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costCents: integer("cost_cents").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
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
