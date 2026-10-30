import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
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
import { assets } from "./assets.js";
import { companies } from "./companies.js";
import { documents } from "./documents.js";
import { issues } from "./issues.js";
import { labels } from "./labels.js";
import { projects } from "./projects.js";
import { workflows } from "./workflows.js";
import type { CaseWorkflowTransition } from "@paperclipai/shared";

export const cases = pgTable(
  "cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    workIssueId: uuid("work_issue_id").references(() => issues.id, { onDelete: "restrict" }),
    phase: text("phase"),
    workflowId: uuid("workflow_id").references(() => workflows.id, { onDelete: "restrict" }),
    handoffVersion: integer("handoff_version").notNull().default(0),
    caseNumber: integer("case_number").notNull(),
    identifier: text("identifier").notNull(),
    caseType: text("case_type").notNull(),
    key: text("key"),
    title: text("title").notNull(),
    summary: text("summary"),
    status: text("status").notNull().default("draft"),
    fields: jsonb("fields").$type<Record<string, unknown>>().notNull().default({}),
    parentCaseId: uuid("parent_case_id").references((): AnyPgColumn => cases.id, { onDelete: "set null" }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCaseNumberUq: uniqueIndex("cases_company_case_number_uq").on(table.companyId, table.caseNumber),
    identifierUq: uniqueIndex("cases_identifier_uq").on(table.identifier),
    workIssueUq: uniqueIndex("cases_work_issue_uq").on(table.workIssueId).where(sql`${table.workIssueId} is not null`),
    companyTypeKeyUq: uniqueIndex("cases_company_type_key_uq").on(table.companyId, table.caseType, table.key),
    companyStatusIdx: index("cases_company_status_idx").on(table.companyId, table.status),
    companyTypeIdx: index("cases_company_type_idx").on(table.companyId, table.caseType),
    companyProjectIdx: index("cases_company_project_idx").on(table.companyId, table.projectId),
    parentIdx: index("cases_parent_idx").on(table.parentCaseId),
    titleSearchIdx: index("cases_title_search_idx").using("gin", table.title.op("gin_trgm_ops")),
    identifierSearchIdx: index("cases_identifier_search_idx").using("gin", table.identifier.op("gin_trgm_ops")),
    summarySearchIdx: index("cases_summary_search_idx").using("gin", table.summary.op("gin_trgm_ops")),
    statusCheck: check(
      "cases_status_check",
      sql`${table.status} in ('draft', 'in_progress', 'in_review', 'approved', 'done', 'cancelled')`,
    ),
  }),
);

export const caseIssueLinks = pgTable(
  "case_issue_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").notNull().references(() => cases.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    createdByRunId: uuid("created_by_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    caseIssueUq: uniqueIndex("case_issue_links_case_issue_uq").on(table.caseId, table.issueId),
    companyCaseIdx: index("case_issue_links_company_case_idx").on(table.companyId, table.caseId),
    issueIdx: index("case_issue_links_issue_idx").on(table.issueId),
    roleCheck: check("case_issue_links_role_check", sql`${table.role} in ('origin', 'work', 'reference')`),
  }),
);

export const caseEvents = pgTable(
  "case_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").notNull().references(() => cases.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    actorType: text("actor_type").notNull(),
    actorUserId: text("actor_user_id"),
    actorAgentId: uuid("actor_agent_id").references(() => agents.id, { onDelete: "set null" }),
    runId: uuid("run_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    caseCreatedIdx: index("case_events_case_created_idx").on(table.caseId, table.createdAt),
    companyCaseIdx: index("case_events_company_case_idx").on(table.companyId, table.caseId),
    kindCheck: check(
      "case_events_kind_check",
      sql`${table.kind} in (
        'created',
        'updated',
        'fields_changed',
        'status_changed',
        'issue_linked',
        'issue_unlinked',
        'document_revised',
        'child_linked',
        'attachment_added',
        'label_added',
        'label_removed',
        'handoff_requested',
        'handoff_applied',
        'handoff_delivered',
        'handoff_completed',
        'handoff_cancelled'
      )`,
    ),
    actorTypeCheck: check("case_events_actor_type_check", sql`${table.actorType} in ('user', 'agent', 'system')`),
  }),
);

export const caseDocuments = pgTable(
  "case_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").notNull().references(() => cases.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCaseKeyUq: uniqueIndex("case_documents_company_case_key_uq").on(table.companyId, table.caseId, table.key),
    documentUq: uniqueIndex("case_documents_document_uq").on(table.documentId),
    companyCaseUpdatedIdx: index("case_documents_company_case_updated_idx").on(table.companyId, table.caseId, table.updatedAt),
  }),
);

export const caseLabels = pgTable(
  "case_labels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").notNull().references(() => cases.id, { onDelete: "cascade" }),
    labelId: uuid("label_id").notNull().references(() => labels.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    caseLabelUq: uniqueIndex("case_labels_case_label_uq").on(table.caseId, table.labelId),
    companyCaseIdx: index("case_labels_company_case_idx").on(table.companyId, table.caseId),
    labelIdx: index("case_labels_label_idx").on(table.labelId),
  }),
);

export const caseAttachments = pgTable(
  "case_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").notNull().references(() => cases.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCaseIdx: index("case_attachments_company_case_idx").on(table.companyId, table.caseId),
    assetUq: uniqueIndex("case_attachments_asset_uq").on(table.assetId),
  }),
);

/** Sources are logical references: deleting a source must never publish its case. */
export const caseAccessSources = pgTable("case_access_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  caseId: uuid("case_id").notNull().references(() => cases.id, { onDelete: "cascade" }),
  sourceKind: text("source_kind").$type<"issue" | "project">().notNull(),
  sourceId: uuid("source_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  sourceUq: uniqueIndex("case_access_sources_case_source_uq").on(table.caseId, table.sourceKind, table.sourceId),
  companyCaseIdx: index("case_access_sources_company_case_idx").on(table.companyId, table.caseId),
  kindCheck: check("case_access_sources_kind_check", sql`${table.sourceKind} in ('issue', 'project')`),
}));

export const caseHandoffs = pgTable("case_handoffs", {
  workflowTransition: jsonb("workflow_transition").$type<CaseWorkflowTransition>(),
  workflowPrompt: text("workflow_prompt"),
  baseWorkflowDocumentRevisionId: uuid("base_workflow_document_revision_id"),
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  caseId: uuid("case_id").notNull().references(() => cases.id, { onDelete: "cascade" }),
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "restrict" }),
  version: integer("version").notNull(),
  fromAgentId: uuid("from_agent_id").references(() => agents.id, { onDelete: "restrict" }),
  destinationKind: text("destination_kind").$type<"agent" | "done">().notNull().default("agent"),
  toAgentId: uuid("to_agent_id").references(() => agents.id, { onDelete: "restrict" }),
  phase: text("phase").notNull(),
  instructions: text("instructions").notNull(),
  commentId: uuid("comment_id"),
  actorType: text("actor_type").$type<"agent" | "user" | "system">().notNull(),
  actorId: text("actor_id").notNull(),
  actorContext: jsonb("actor_context").$type<Record<string, unknown> | null>(),
  sourceRunId: uuid("source_run_id"),
  responsibleUserId: text("responsible_user_id"),
  expectedIssueStatusVersion: bigint("expected_issue_status_version", { mode: "number" }),
  appliedIssueStatusVersion: bigint("applied_issue_status_version", { mode: "number" }),
  wakeupRequestId: uuid("wakeup_request_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  inputFingerprint: text("input_fingerprint").notNull(),
  state: text("state").$type<"awaiting_release" | "pending_dispatch" | "delivered" | "awaiting_completion" | "completed" | "cancelled">().notNull(),
  attemptCount: integer("attempt_count").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  lastErrorCode: text("last_error_code"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  assignmentAppliedAt: timestamp("assignment_applied_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  versionUq: uniqueIndex("case_handoffs_case_version_uq").on(table.companyId, table.caseId, table.version),
  idempotencyUq: uniqueIndex("case_handoffs_actor_idempotency_uq").on(table.companyId, table.actorType, table.actorId, table.idempotencyKey),
  pendingCaseUq: uniqueIndex("case_handoffs_pending_case_uq").on(table.caseId).where(sql`${table.state} in ('awaiting_release', 'pending_dispatch', 'awaiting_completion')`),
  pendingIssueUq: uniqueIndex("case_handoffs_pending_issue_uq").on(table.issueId).where(sql`${table.state} in ('awaiting_release', 'pending_dispatch', 'awaiting_completion')`),
  pendingAttemptIdx: index("case_handoffs_pending_attempt_idx").on(table.nextAttemptAt).where(sql`${table.state} in ('awaiting_release', 'pending_dispatch')`),
  caseCreatedIdx: index("case_handoffs_case_created_idx").on(table.caseId, table.createdAt),
  sourceRunIdx: index("case_handoffs_source_run_idx").on(table.companyId, table.sourceRunId).where(sql`${table.sourceRunId} is not null`),
  wakeupRequestUq: uniqueIndex("case_handoffs_wakeup_request_uq").on(table.wakeupRequestId),
  stateCheck: check("case_handoffs_state_check", sql`${table.state} in ('awaiting_release', 'pending_dispatch', 'delivered', 'awaiting_completion', 'completed', 'cancelled')`),
  destinationCheck: check("case_handoffs_destination_check", sql`(${table.destinationKind} = 'agent' and ${table.toAgentId} is not null) or (${table.destinationKind} = 'done' and ${table.toAgentId} is null)`),
  destinationStateCheck: check("case_handoffs_destination_state_check", sql`(${table.destinationKind} = 'agent' and ${table.state} in ('awaiting_release', 'pending_dispatch', 'delivered', 'cancelled')) or (${table.destinationKind} = 'done' and ${table.state} in ('awaiting_completion', 'completed', 'cancelled'))`),
  actorCheck: check("case_handoffs_actor_type_check", sql`${table.actorType} in ('agent', 'user', 'system')`),
}));
