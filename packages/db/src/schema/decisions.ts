import type { DecisionInput, DecisionOption } from "@paperclipai/shared";
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { activityLog } from "./activity_log.js";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

export const decisionBundles = pgTable(
  "decision_bundles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    originAgentId: uuid("origin_agent_id").notNull().references(() => agents.id),
    originIssueId: uuid("origin_issue_id").notNull().references(() => issues.id),
    originRunId: uuid("origin_run_id").notNull().references(() => heartbeatRuns.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedAtIdx: index("decision_bundles_company_created_at_idx").on(table.companyId, table.createdAt),
  }),
);

export const decisions = pgTable(
  "decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    bundleId: uuid("bundle_id").references(() => decisionBundles.id, { onDelete: "set null" }),
    originAgentId: uuid("origin_agent_id").notNull().references(() => agents.id),
    originIssueId: uuid("origin_issue_id").notNull().references(() => issues.id),
    originRunId: uuid("origin_run_id").notNull().references(() => heartbeatRuns.id),
    ruleKey: text("rule_key"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    options: jsonb("options").$type<DecisionOption[]>().notNull(),
    inputs: jsonb("inputs").$type<DecisionInput[]>(),
    status: text("status").notNull().default("open"),
    executionStatus: text("execution_status"),
    chosenOptionId: text("chosen_option_id"),
    inputValues: jsonb("input_values").$type<Record<string, string>>(),
    decidedByUserId: text("decided_by_user_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    idempotencyKey: text("idempotency_key"),
    signedSpec: text("signed_spec").notNull(),
    targetSnapshots: jsonb("target_snapshots").$type<Record<string, unknown>>().notNull(),
    continuationPolicy: text("continuation_policy").notNull().default("none"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusExpiresAtIdx: index("decisions_company_status_expires_at_idx").on(
      table.companyId,
      table.status,
      table.expiresAt,
    ),
    bundleIdx: index("decisions_bundle_idx").on(table.bundleId),
    originIssueIdx: index("decisions_origin_issue_idx").on(table.originIssueId),
    companyIdempotencyUq: uniqueIndex("decisions_company_idempotency_uq")
      .on(table.companyId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
  }),
);

export const decisionTargetIssues = pgTable(
  "decision_target_issues",
  {
    decisionId: uuid("decision_id").notNull().references(() => decisions.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.decisionId, table.issueId] }),
    decisionIdx: index("decision_target_issues_decision_idx").on(table.decisionId),
    issueIdx: index("decision_target_issues_issue_idx").on(table.issueId),
  }),
);

export const decisionEffectExecutions = pgTable(
  "decision_effect_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    decisionId: uuid("decision_id").notNull().references(() => decisions.id, { onDelete: "cascade" }),
    effectIndex: integer("effect_index").notNull(),
    effectType: text("effect_type").notNull(),
    targetIssueId: uuid("target_issue_id").notNull().references(() => issues.id),
    status: text("status").notNull().default("claimed"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    error: text("error"),
    activityLogId: uuid("activity_log_id").references(() => activityLog.id, { onDelete: "set null" }),
    executedAt: timestamp("executed_at", { withTimezone: true }),
  },
  (table) => ({
    decisionEffectUq: uniqueIndex("decision_effect_executions_decision_effect_uq").on(
      table.decisionId,
      table.effectIndex,
    ),
    targetIssueIdx: index("decision_effect_executions_target_issue_idx").on(table.targetIssueId),
  }),
);
