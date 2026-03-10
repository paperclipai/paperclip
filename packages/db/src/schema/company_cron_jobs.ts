import { pgTable, uuid, text, integer, timestamp, boolean, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const companyCronJobs = pgTable(
  "company_cron_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    name: text("name").notNull(),
    description: text("description"),
    enabled: boolean("enabled").notNull().default(true),

    // Schedule
    cronExpr: text("cron_expr").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    staggerMs: integer("stagger_ms").notNull().default(0),

    // Payload — passed to agent via contextSnapshot on wake
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),

    // State (updated by scheduler)
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastRunStatus: text("last_run_status"),
    lastRunDurationMs: integer("last_run_duration_ms"),
    lastRunId: uuid("last_run_id"),
    consecutiveErrors: integer("consecutive_errors").notNull().default(0),

    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    nextRunIdx: index("cron_jobs_next_run_idx").on(table.nextRunAt),
    agentIdx: index("cron_jobs_agent_idx").on(table.agentId),
    companyIdx: index("cron_jobs_company_idx").on(table.companyId),
  }),
);
