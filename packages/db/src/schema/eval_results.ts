import { pgTable, uuid, text, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * Stores summary-level eval run results (one row per bundle run).
 */
export const evalResults = pgTable(
  "eval_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    bundleId: text("bundle_id").notNull(),
    bundleName: text("bundle_name").notNull(),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    totalCases: integer("total_cases").notNull(),
    passed: integer("passed").notNull(),
    failed: integer("failed").notNull(),
    errors: integer("errors").notNull().default(0),
    skipped: integer("skipped").notNull().default(0),
    totalCostCents: integer("total_cost_cents").notNull().default(0),
    resultJson: jsonb("result_json").notNull(),
    duration: integer("duration").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("eval_results_company_created_idx").on(table.companyId, table.createdAt),
    companyBundleIdx: index("eval_results_company_bundle_idx").on(table.companyId, table.bundleId),
    companyAgentIdx: index("eval_results_company_agent_idx").on(table.companyId, table.agentId),
  }),
);

/**
 * Stores individual eval case results (one row per case execution).
 */
export const evalCaseResults = pgTable(
  "eval_case_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    evalResultId: uuid("eval_result_id").notNull().references(() => evalResults.id),
    bundleId: text("bundle_id").notNull(),
    caseId: text("case_id").notNull(),
    caseName: text("case_name").notNull(),
    status: text("status").notNull(), // passed | failed | error | skipped
    durationMs: integer("duration_ms").notNull(),
    tokenCount: integer("token_count"),
    costCents: integer("cost_cents"),
    runId: text("run_id"),
    output: text("output"),
    failedExpectations: jsonb("failed_expectations"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("eval_case_results_company_created_idx").on(table.companyId, table.createdAt),
    evalResultIdx: index("eval_case_results_eval_result_idx").on(table.evalResultId),
    bundleCaseIdx: index("eval_case_results_bundle_case_idx").on(table.bundleId, table.caseId),
  }),
);
