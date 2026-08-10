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
import { assets } from "./assets.js";
import { companies } from "./companies.js";
import { documents } from "./documents.js";
import { issues } from "./issues.js";
import { labels } from "./labels.js";
import { projects } from "./projects.js";

export const cases = pgTable(
  "cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
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
        'label_removed'
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
