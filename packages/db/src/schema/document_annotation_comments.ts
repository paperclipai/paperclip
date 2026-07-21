import type { IssueCommentAuthorType, SourceTrustMetadata } from "@paperclipai/shared";
import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { documentAnnotationThreads } from "./document_annotation_threads.js";
import { documents } from "./documents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issueComments } from "./issue_comments.js";
import { issues } from "./issues.js";
import { routines } from "./routines.js";
import { cases } from "./cases.js";

export const documentAnnotationComments = pgTable(
  "document_annotation_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    threadId: uuid("thread_id").notNull().references(() => documentAnnotationThreads.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "cascade" }),
    routineId: uuid("routine_id").references(() => routines.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").references(() => cases.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    authorType: text("author_type").$type<IssueCommentAuthorType>().notNull(),
    authorAgentId: uuid("author_agent_id").references(() => agents.id, { onDelete: "set null" }),
    authorUserId: text("author_user_id"),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    issueCommentId: uuid("issue_comment_id").references(() => issueComments.id, { onDelete: "set null" }),
    sourceTrust: jsonb("source_trust").$type<SourceTrustMetadata | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyThreadCreatedAtIdx: index("document_annotation_comments_company_thread_created_at_idx").on(
      table.companyId,
      table.threadId,
      table.createdAt,
    ),
    companyIssueCreatedAtIdx: index("document_annotation_comments_company_issue_created_at_idx").on(
      table.companyId,
      table.issueId,
      table.createdAt,
    ),
    companyRoutineCreatedAtIdx: index("document_annotation_comments_company_routine_created_at_idx").on(
      table.companyId,
      table.routineId,
      table.createdAt,
    ),
    companyCaseCreatedAtIdx: index("document_annotation_comments_company_case_created_at_idx").on(
      table.companyId,
      table.caseId,
      table.createdAt,
    ),
    companyDocumentCreatedAtIdx: index("document_annotation_comments_company_document_created_at_idx").on(
      table.companyId,
      table.documentId,
      table.createdAt,
    ),
    issueCommentIdx: index("document_annotation_comments_issue_comment_idx").on(table.issueCommentId),
    bodySearchIdx: index("document_annotation_comments_body_search_idx").using("gin", table.body.op("gin_trgm_ops")),
    exactlyOneOwnerChk: check(
      "document_annotation_comments_exactly_one_owner_chk",
      sql`num_nonnulls(${table.issueId}, ${table.routineId}, ${table.caseId}) = 1`,
    ),
  }),
);
