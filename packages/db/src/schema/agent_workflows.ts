import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { WorkflowStep, WorkflowStepRunResult } from "@paperclipai/shared";
import { companies } from "./companies.js";

export const agentWorkflows = pgTable(
  "agent_workflows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("draft"),
    steps: jsonb("steps").$type<WorkflowStep[]>().notNull().default([]),
    templateKey: text("template_key"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    // Channel deploy token — bearer secret an external surface (Slack/Teams/web)
    // presents to run this workflow inbound. Null until deployed.
    deployToken: text("deploy_token"),
    createdByAgentId: uuid("created_by_agent_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("agent_workflows_company_status_idx").on(table.companyId, table.status),
    companyTemplateIdx: index("agent_workflows_company_template_idx").on(table.companyId, table.templateKey),
  }),
);

export const agentWorkflowRuns = pgTable(
  "agent_workflow_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id").notNull().references(() => agentWorkflows.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    trigger: text("trigger").notNull().default("manual"),
    stepResults: jsonb("step_results").$type<WorkflowStepRunResult[]>().notNull().default([]),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyWorkflowIdx: index("agent_workflow_runs_company_workflow_idx").on(
      table.companyId,
      table.workflowId,
      table.createdAt,
    ),
  }),
);
