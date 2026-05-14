import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { projects } from "./projects.js";
import { goals } from "./goals.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { projectWorkspaces } from "./project_workspaces.js";
import { executionWorkspaces } from "./execution_workspaces.js";

export const issues = pgTable(
  "issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    projectId: uuid("project_id").references(() => projects.id),
    projectWorkspaceId: uuid("project_workspace_id").references(() => projectWorkspaces.id, { onDelete: "set null" }),
    goalId: uuid("goal_id").references(() => goals.id),
    parentId: uuid("parent_id").references((): AnyPgColumn => issues.id),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").notNull().default("backlog"),
    workMode: text("work_mode").notNull().default("standard"),
    priority: text("priority").notNull().default("medium"),
    assigneeAgentId: uuid("assignee_agent_id").references(() => agents.id),
    assigneeUserId: text("assignee_user_id"),
    checkoutRunId: uuid("checkout_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    executionRunId: uuid("execution_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    executionAgentNameKey: text("execution_agent_name_key"),
    executionLockedAt: timestamp("execution_locked_at", { withTimezone: true }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id),
    createdByUserId: text("created_by_user_id"),
    issueNumber: integer("issue_number"),
    identifier: text("identifier"),
    originKind: text("origin_kind").notNull().default("manual"),
    originId: text("origin_id"),
    originRunId: text("origin_run_id"),
    originFingerprint: text("origin_fingerprint").notNull().default("default"),
    requestDepth: integer("request_depth").notNull().default(0),
    billingCode: text("billing_code"),
    assigneeAdapterOverrides: jsonb("assignee_adapter_overrides").$type<Record<string, unknown>>(),
    executionPolicy: jsonb("execution_policy").$type<Record<string, unknown>>(),
    executionState: jsonb("execution_state").$type<Record<string, unknown>>(),
    monitorNextCheckAt: timestamp("monitor_next_check_at", { withTimezone: true }),
    monitorWakeRequestedAt: timestamp("monitor_wake_requested_at", { withTimezone: true }),
    monitorLastTriggeredAt: timestamp("monitor_last_triggered_at", { withTimezone: true }),
    monitorAttemptCount: integer("monitor_attempt_count").notNull().default(0),
    monitorNotes: text("monitor_notes"),
    monitorScheduledBy: text("monitor_scheduled_by"),
    executionWorkspaceId: uuid("execution_workspace_id")
      .references((): AnyPgColumn => executionWorkspaces.id, { onDelete: "set null" }),
    executionWorkspacePreference: text("execution_workspace_preference"),
    executionWorkspaceSettings: jsonb("execution_workspace_settings").$type<Record<string, unknown>>(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("issues_company_status_idx").on(table.companyId, table.status),
    assigneeStatusIdx: index("issues_company_assignee_status_idx").on(
      table.companyId,
      table.assigneeAgentId,
      table.status,
    ),
    assigneeUserStatusIdx: index("issues_company_assignee_user_status_idx").on(
      table.companyId,
      table.assigneeUserId,
      table.status,
    ),
    parentIdx: index("issues_company_parent_idx").on(table.companyId, table.parentId),
    projectIdx: index("issues_company_project_idx").on(table.companyId, table.projectId),
    originIdx: index("issues_company_origin_idx").on(table.companyId, table.originKind, table.originId),
    projectWorkspaceIdx: index("issues_company_project_workspace_idx").on(table.companyId, table.projectWorkspaceId),
    executionWorkspaceIdx: index("issues_company_execution_workspace_idx").on(table.companyId, table.executionWorkspaceId),
    dueMonitorIdx: index("issues_company_monitor_due_idx").on(table.companyId, table.monitorNextCheckAt),
    identifierIdx: uniqueIndex("issues_identifier_idx").on(table.identifier),
    titleSearchIdx: index("issues_title_search_idx").using("gin", table.title.op("gin_trgm_ops")),
    identifierSearchIdx: index("issues_identifier_search_idx").using("gin", table.identifier.op("gin_trgm_ops")),
    descriptionSearchIdx: index("issues_description_search_idx").using("gin", table.description.op("gin_trgm_ops")),
    openRoutineExecutionIdx: uniqueIndex("issues_open_routine_execution_uq")
      .on(table.companyId, table.originKind, table.originId, table.originFingerprint)
      .where(
        sql`${table.originKind} = 'routine_execution'
          and ${table.originId} is not null
          and ${table.hiddenAt} is null
          and ${table.executionRunId} is not null
          and ${table.status} in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked')`,
      ),
    activeLivenessRecoveryIncidentIdx: uniqueIndex("issues_active_liveness_recovery_incident_uq")
      .on(table.companyId, table.originKind, table.originId)
      .where(
        sql`${table.originKind} = 'harness_liveness_escalation'
          and ${table.originId} is not null
          and ${table.hiddenAt} is null
          and ${table.status} not in ('done', 'cancelled')`,
      ),
    activeLivenessRecoveryLeafIdx: uniqueIndex("issues_active_liveness_recovery_leaf_uq")
      .on(table.companyId, table.originKind, table.originFingerprint)
      .where(
        sql`${table.originKind} = 'harness_liveness_escalation'
          and ${table.originFingerprint} <> 'default'
          and ${table.hiddenAt} is null
          and ${table.status} not in ('done', 'cancelled')`,
      ),
    activeStaleRunEvaluationIdx: uniqueIndex("issues_active_stale_run_evaluation_uq")
      .on(table.companyId, table.originKind, table.originId)
      .where(
        sql`${table.originKind} = 'stale_active_run_evaluation'
          and ${table.originId} is not null
          and ${table.hiddenAt} is null
          and ${table.status} not in ('done', 'cancelled')`,
      ),
    activeProductivityReviewIdx: uniqueIndex("issues_active_productivity_review_uq")
      .on(table.companyId, table.originKind, table.originId)
      .where(
        sql`${table.originKind} = 'issue_productivity_review'
          and ${table.originId} is not null
          and ${table.hiddenAt} is null
          and ${table.status} not in ('done', 'cancelled')`,
      ),
    activeStrandedIssueRecoveryIdx: uniqueIndex("issues_active_stranded_issue_recovery_uq")
      .on(table.companyId, table.originKind, table.originId)
      .where(
        sql`${table.originKind} = 'stranded_issue_recovery'
          and ${table.originId} is not null
          and ${table.hiddenAt} is null
          and ${table.status} not in ('done', 'cancelled')`,
      ),
  }),
);
