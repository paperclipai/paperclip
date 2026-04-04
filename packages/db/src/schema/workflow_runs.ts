import { type AnyPgColumn, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import { workflows } from "./workflows.js";

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" }),
    workflowVersion: integer("workflow_version").notNull(),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    status: text("status").notNull().default("pending"),
    currentStepKey: text("current_step_key"),
    stepIndex: integer("step_index").notNull().default(0),
    resultJson: jsonb("result_json").$type<Record<string, unknown>>(),
    error: text("error"),
    linkedIssueId: uuid("linked_issue_id").references(() => issues.id, { onDelete: "set null" }),
    parentRunId: uuid("parent_run_id").references((): AnyPgColumn => workflowRuns.id, { onDelete: "set null" }),
    parentStepKey: text("parent_step_key"),
    stateJson: jsonb("state_json").$type<Record<string, unknown>>(),
    triggerSource: text("trigger_source").notNull().default("api"),
    triggeredAt: timestamp("triggered_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyWorkflowStatusIdx: index("workflow_runs_company_workflow_status_idx").on(table.companyId, table.workflowId, table.status),
    companyAgentStatusIdx: index("workflow_runs_company_agent_status_idx").on(table.companyId, table.agentId, table.status),
    linkedIssueIdx: index("workflow_runs_linked_issue_idx").on(table.linkedIssueId),
    parentRunIdx: index("workflow_runs_parent_run_idx").on(table.parentRunId),
  }),
);

export const workflowRunSteps = pgTable(
  "workflow_run_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => workflowRuns.id, { onDelete: "cascade" }),
    stepKey: text("step_key").notNull(),
    stepIndex: integer("step_index").notNull(),
    status: text("status").notNull().default("pending"),
    inputJson: jsonb("input_json").$type<Record<string, unknown>>(),
    submissionJson: jsonb("submission_json").$type<Record<string, unknown>>(),
    validationResult: jsonb("validation_result").$type<Record<string, unknown>>(),
    heartbeatRunId: uuid("heartbeat_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runStepIndexIdx: index("workflow_run_steps_run_step_index_idx").on(table.runId, table.stepIndex),
    runStepKeyIdx: index("workflow_run_steps_run_step_key_idx").on(table.runId, table.stepKey),
  }),
);
