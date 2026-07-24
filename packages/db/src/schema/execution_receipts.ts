import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import { companySkills } from "./company_skills.js";
import { plugins } from "./plugins.js";

export type ExecutionReceiptToolInvoked = {
  toolName: string;
  invocationId: string;
  dryRun: boolean;
  policyDecision: string | null;
  status: string;
};

/**
 * One row per `heartbeatRuns` row that reaches a terminal status (SAG-7616 W2).
 * `contentHash`/`prevReceiptHash`/`chainSeq` form a per-company hash chain —
 * see `verifyReceiptChain` in server/src/services/execution-receipts.ts for the
 * verification procedure and SAG-7632's plan document for the design rationale.
 */
export const executionReceipts = pgTable(
  "execution_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),

    skillId: uuid("skill_id").references(() => companySkills.id, { onDelete: "set null" }),
    pluginId: uuid("plugin_id").references(() => plugins.id, { onDelete: "set null" }),
    skillName: text("skill_name"),
    skillVersionHash: text("skill_version_hash"),

    riskTier: integer("risk_tier"),
    riskTierSource: text("risk_tier_source").notNull(),

    inputsRedacted: jsonb("inputs_redacted").$type<Record<string, unknown>>().notNull(),
    toolsInvoked: jsonb("tools_invoked").$type<ExecutionReceiptToolInvoked[]>().notNull().default([]),
    gateDecisions: jsonb("gate_decisions").$type<Record<string, unknown>>().notNull().default({}),
    evalScores: jsonb("eval_scores").$type<Record<string, unknown>>().notNull().default({}),

    outcome: text("outcome").notNull(),
    costCents: integer("cost_cents").notNull().default(0),

    contentHash: text("content_hash").notNull(),
    prevReceiptHash: text("prev_receipt_hash"),
    chainSeq: integer("chain_seq").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("execution_receipts_company_created_idx").on(table.companyId, table.createdAt),
    index("execution_receipts_company_chain_idx").on(table.companyId, table.chainSeq),
    index("execution_receipts_run_idx").on(table.runId),
    index("execution_receipts_skill_version_idx").on(table.companyId, table.skillVersionHash),
    uniqueIndex("execution_receipts_company_chain_seq_uq").on(table.companyId, table.chainSeq),
    uniqueIndex("execution_receipts_run_uq").on(table.runId),
    check("execution_receipts_risk_tier_check", sql`${table.riskTier} is null or ${table.riskTier} in (0, 1, 2)`),
    check(
      "execution_receipts_risk_tier_source_check",
      sql`${table.riskTierSource} in ('classifier', 'fail_safe_default')`,
    ),
    check("execution_receipts_outcome_check", sql`${table.outcome} in ('succeeded', 'failed', 'error')`),
  ],
);
