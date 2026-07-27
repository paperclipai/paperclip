import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

export const agentManagerEvaluations = pgTable(
  "agent_manager_evaluations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    supervisorAgentId: uuid("supervisor_agent_id").references(() => agents.id, { onDelete: "set null" }),
    trigger: text("trigger").notNull(),
    score: integer("score"),
    rationale: text("rationale"),
    criteriaResults: jsonb("criteria_results").$type<Array<Record<string, unknown>>>(),
    corrections: jsonb("corrections").$type<Array<Record<string, unknown>>>(),
    outcome: text("outcome").notNull(),
    reflectionAttempt: integer("reflection_attempt").notNull().default(0),
    judgeModel: text("judge_model"),
    judgeLatencyMs: integer("judge_latency_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runUnique: uniqueIndex("agent_manager_evaluations_run_uq").on(table.runId),
    companyIssueIdx: index("agent_manager_evaluations_company_issue_idx").on(table.companyId, table.issueId),
    companyCreatedIdx: index("agent_manager_evaluations_company_created_idx").on(table.companyId, table.createdAt),
  }),
);
