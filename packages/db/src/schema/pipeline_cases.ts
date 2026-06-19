import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { documents } from "./documents.js";
import { issues } from "./issues.js";
import { pipelineStages, pipelines } from "./pipelines.js";
import { routines } from "./routines.js";

export type PipelineCasePendingSuggestion = {
  id: string;
  toStageKey: string;
  rationale: string;
  confidence?: number;
  suggestedByAgentId?: string;
  runId?: string;
  createdAt: string;
};

export type PipelineCaseWorkspaceRef = {
  executionWorkspaceId?: string;
  path?: string;
};

export const pipelineCases = pgTable(
  "pipeline_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    pipelineId: uuid("pipeline_id").notNull().references(() => pipelines.id, { onDelete: "cascade" }),
    stageId: uuid("stage_id").notNull().references(() => pipelineStages.id),
    caseKey: text("case_key").notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    fields: jsonb("fields").$type<Record<string, unknown>>().notNull().default({}),
    workspaceRef: jsonb("workspace_ref").$type<PipelineCaseWorkspaceRef>(),
    parentCaseId: uuid("parent_case_id").references((): AnyPgColumn => pipelineCases.id, { onDelete: "set null" }),
    parentCaseVersion: integer("parent_case_version"),
    requestKey: text("request_key"),
    automationAttemptId: uuid("automation_attempt_id"),
    version: integer("version").notNull().default(1),
    pendingSuggestion: jsonb("pending_suggestion").$type<PipelineCasePendingSuggestion>(),
    leaseOwnerType: text("lease_owner_type"),
    leaseAgentId: uuid("lease_agent_id").references(() => agents.id, { onDelete: "set null" }),
    leaseUserId: text("lease_user_id"),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    terminalKind: text("terminal_kind"),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    retiredByAttemptId: uuid("retired_by_attempt_id"),
    retiredReason: text("retired_reason"),
    hiddenFromBoardAt: timestamp("hidden_from_board_at", { withTimezone: true }),
    childCount: integer("child_count").notNull().default(0),
    terminalChildCount: integer("terminal_child_count").notNull().default(0),
    createdByUserId: text("created_by_user_id"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    originRunId: uuid("origin_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pipelineCaseKeyUq: uniqueIndex("pipeline_cases_pipeline_case_key_uq").on(table.pipelineId, table.caseKey),
    parentRequestKeyUq: uniqueIndex("pipeline_cases_parent_request_key_uq")
      .on(table.parentCaseId, table.requestKey)
      .where(sql`${table.requestKey} is not null and ${table.retiredAt} is null`),
    companyIdx: index("pipeline_cases_company_idx").on(table.companyId),
    pipelineStageIdx: index("pipeline_cases_pipeline_stage_idx").on(table.pipelineId, table.stageId),
    parentIdx: index("pipeline_cases_parent_idx").on(table.parentCaseId),
    automationAttemptIdx: index("pipeline_cases_automation_attempt_idx").on(table.automationAttemptId),
    retiredIdx: index("pipeline_cases_retired_idx").on(table.companyId, table.retiredAt),
    leaseExpiresIdx: index("pipeline_cases_lease_expires_idx").on(table.leaseExpiresAt).where(sql`${table.leaseExpiresAt} is not null`),
    terminalKindCheck: check("pipeline_cases_terminal_kind_check", sql`${table.terminalKind} is null or ${table.terminalKind} in ('done', 'cancelled')`),
    leaseOwnerTypeCheck: check("pipeline_cases_lease_owner_type_check", sql`${table.leaseOwnerType} is null or ${table.leaseOwnerType} in ('user', 'agent')`),
  }),
);

export const pipelineCaseIssueLinks = pgTable(
  "pipeline_case_issue_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").notNull().references(() => pipelineCases.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    createdByRunId: uuid("created_by_run_id"),
    automationAttemptId: uuid("automation_attempt_id"),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    retiredByAttemptId: uuid("retired_by_attempt_id"),
    retiredReason: text("retired_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    caseIssueUq: uniqueIndex("pipeline_case_issue_links_case_issue_uq").on(table.caseId, table.issueId),
    issueIdx: index("pipeline_case_issue_links_issue_idx").on(table.issueId),
    companyCaseIdx: index("pipeline_case_issue_links_company_case_idx").on(table.companyId, table.caseId),
    automationAttemptIdx: index("pipeline_case_issue_links_automation_attempt_idx").on(table.automationAttemptId),
    roleCheck: check("pipeline_case_issue_links_role_check", sql`${table.role} in ('origin', 'conversation', 'work', 'automation')`),
  }),
);

export const pipelineCaseBlockers = pgTable(
  "pipeline_case_blockers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").notNull().references(() => pipelineCases.id, { onDelete: "cascade" }),
    blockedByCaseId: uuid("blocked_by_case_id").notNull().references(() => pipelineCases.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    caseBlockedByUq: uniqueIndex("pipeline_case_blockers_case_blocked_by_uq").on(table.caseId, table.blockedByCaseId),
    blockedByIdx: index("pipeline_case_blockers_blocked_by_idx").on(table.blockedByCaseId),
    companyCaseIdx: index("pipeline_case_blockers_company_case_idx").on(table.companyId, table.caseId),
    noSelfBlockCheck: check("pipeline_case_blockers_no_self_block_check", sql`${table.caseId} <> ${table.blockedByCaseId}`),
  }),
);

export const pipelineDocuments = pgTable(
  "pipeline_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    pipelineId: uuid("pipeline_id").notNull().references(() => pipelines.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyPipelineKeyUq: uniqueIndex("pipeline_documents_company_pipeline_key_uq").on(
      table.companyId,
      table.pipelineId,
      table.key,
    ),
    documentUq: uniqueIndex("pipeline_documents_document_uq").on(table.documentId),
    companyPipelineUpdatedIdx: index("pipeline_documents_company_pipeline_updated_idx").on(
      table.companyId,
      table.pipelineId,
      table.updatedAt,
    ),
  }),
);

export const pipelineAutomationExecutions = pgTable(
  "pipeline_automation_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").notNull().references(() => pipelineCases.id, { onDelete: "cascade" }),
    automationId: text("automation_id").notNull(),
    triggeringEventId: uuid("triggering_event_id").notNull(),
    routineId: uuid("routine_id").notNull().references(() => routines.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    executionIssueId: uuid("execution_issue_id").references(() => issues.id, { onDelete: "set null" }),
    retryOfExecutionId: uuid("retry_of_execution_id"),
    generation: integer("generation").notNull().default(1),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idempotencyUq: uniqueIndex("pipeline_automation_executions_idempotency_uq").on(
      table.caseId,
      table.automationId,
      table.triggeringEventId,
    ),
    companyCaseIdx: index("pipeline_automation_executions_company_case_idx").on(table.companyId, table.caseId),
    routineIdx: index("pipeline_automation_executions_routine_idx").on(table.routineId),
    executionIssueIdx: index("pipeline_automation_executions_execution_issue_idx").on(table.executionIssueId),
    retryOfExecutionIdx: index("pipeline_automation_executions_retry_of_execution_idx").on(table.retryOfExecutionId),
    statusCheck: check("pipeline_automation_executions_status_check", sql`${table.status} in ('succeeded', 'failed')`),
  }),
);
