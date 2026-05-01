import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { executionWorkspaces } from "./execution_workspaces.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import { issueWorkProducts } from "./issue_work_products.js";
import { workspaceRuntimeServices } from "./workspace_runtime_services.js";

export const rt2V33ExecutionAttempts = pgTable(
  "rt2_v33_execution_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    taskIssueId: uuid("task_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    todoIssueId: uuid("todo_issue_id").references(() => issues.id, { onDelete: "cascade" }),
    deliverableWorkProductId: uuid("deliverable_work_product_id").references(() => issueWorkProducts.id, {
      onDelete: "set null",
    }),
    resultWorkProductId: uuid("result_work_product_id").references(() => issueWorkProducts.id, {
      onDelete: "set null",
    }),
    retryOfAttemptId: uuid("retry_of_attempt_id"),
    state: text("state").notNull().default("queued"),
    executorType: text("executor_type"),
    executorId: text("executor_id"),
    executionWorkspaceId: uuid("execution_workspace_id").references(() => executionWorkspaces.id, {
      onDelete: "set null",
    }),
    runtimeServiceId: uuid("runtime_service_id").references(() => workspaceRuntimeServices.id, {
      onDelete: "set null",
    }),
    heartbeatRunId: uuid("heartbeat_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    failureReason: text("failure_reason"),
    missingDeliverableReason: text("missing_deliverable_reason"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    queuedByUserId: text("queued_by_user_id").notNull(),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    stateCheck: check(
      "rt2_v33_execution_attempts_state_check",
      sql`${table.state} in ('queued', 'dispatched', 'claimed', 'running', 'completed', 'failed', 'cancelled', 'blocked')`,
    ),
    executorTypeCheck: check(
      "rt2_v33_execution_attempts_executor_type_check",
      sql`${table.executorType} is null or ${table.executorType} in ('user', 'jarvis', 'runtime')`,
    ),
    taskUpdatedIdx: index("rt2_v33_execution_attempts_task_updated_idx").on(
      table.taskIssueId,
      table.updatedAt,
    ),
    todoUpdatedIdx: index("rt2_v33_execution_attempts_todo_updated_idx").on(
      table.todoIssueId,
      table.updatedAt,
    ),
    companyStateIdx: index("rt2_v33_execution_attempts_company_state_idx").on(
      table.companyId,
      table.state,
      table.updatedAt,
    ),
  }),
);
