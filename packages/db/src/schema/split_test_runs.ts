import { pgTable, uuid, text, timestamp, jsonb, numeric, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const splitTestRuns = pgTable(
  "split_test_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    primaryRunId: uuid("primary_run_id").notNull().references(() => heartbeatRuns.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    model: text("model").notNull(),
    adapterType: text("adapter_type").notNull(),
    status: text("status").notNull().default("queued"),
    prompt: text("prompt"),
    summary: text("summary"),
    usageJson: jsonb("usage_json").$type<Record<string, unknown>>(),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    logContent: text("log_content"),
    error: text("error"),
    judgeAnalysis: text("judge_analysis"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    primaryRunIdx: index("split_test_runs_primary_run_idx").on(table.primaryRunId),
    companyAgentIdx: index("split_test_runs_company_agent_idx").on(table.companyId, table.agentId),
  }),
);
