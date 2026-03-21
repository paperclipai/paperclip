import { pgTable, uuid, text, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").references(() => issues.id),
    createdBy: text("created_by").notNull().default("system"),
    name: text("name"),
    steps: jsonb("steps").notNull().default([]),
    currentStep: integer("current_step").notNull().default(0),
    status: text("status").notNull().default("pending"),
    onStepFailure: text("on_step_failure").notNull().default("pause"),
    maxRetries: integer("max_retries").notNull().default(1),
    timeoutPerStepMs: integer("timeout_per_step_ms").notNull().default(300_000),
    result: jsonb("result"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("workflow_runs_company_status_idx").on(table.companyId, table.status),
    issueIdx: index("workflow_runs_issue_idx").on(table.issueId),
  }),
);

export type WorkflowStatus = "pending" | "running" | "completed" | "failed" | "paused" | "cancelled";
export type StepFailurePolicy = "pause" | "retry_once" | "skip" | "abort";

export interface WorkflowStepDef {
  adapterType: string;
  action?: string;
  prompt?: string;
  model?: string;
  dependsOn?: number[];
  config?: Record<string, unknown>;
}
