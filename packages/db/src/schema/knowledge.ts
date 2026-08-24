import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";

/**
 * Knowledge documents: curated, reviewed, versioned knowledge base entries.
 * Lifecycle: draft → in_review → published → archived
 */
export const knowledgeDocuments = pgTable(
  "knowledge_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    summary: text("summary"),
    body: text("body").notNull().default(""),
    status: text("status").notNull().default("draft"),
    version: integer("version").notNull().default(1),
    authorAgentId: uuid("author_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    sourceIssueId: uuid("source_issue_id").references(() => issues.id, {
      onDelete: "set null",
    }),
    memoryRecordId: uuid("memory_record_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (table) => ({
    companyStatusIdx: index("knowledge_documents_company_status_idx").on(
      table.companyId,
      table.status,
    ),
    companyCreatedIdx: index(
      "knowledge_documents_company_created_idx",
    ).on(table.companyId, table.createdAt),
    companyUpdatedIdx: index(
      "knowledge_documents_company_updated_idx",
    ).on(table.companyId, table.updatedAt),
    memoryRecordUniqueIdx: uniqueIndex(
      "knowledge_documents_memory_record_unique_idx",
    ).on(table.memoryRecordId),
  }),
);

/**
 * Knowledge document revisions: versioned snapshots for diff review.
 */
export const knowledgeDocumentRevisions = pgTable(
  "knowledge_document_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    body: text("body").notNull().default(""),
    changeDescription: text("change_description"),
    authorAgentId: uuid("author_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    documentVersionIdx: index(
      "knowledge_document_revisions_document_version_idx",
    ).on(table.documentId, table.version),
    documentVersionUnique: uniqueIndex(
      "knowledge_document_revisions_doc_ver_unique_idx",
    ).on(table.documentId, table.version),
  }),
);

/**
 * Knowledge document reviews: review/approval workflow entries.
 */
export const knowledgeDocumentReviews = pgTable(
  "knowledge_document_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => knowledgeDocumentRevisions.id, { onDelete: "cascade" }),
    reviewerAgentId: uuid("reviewer_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("pending"),
    comment: text("comment"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (table) => ({
    documentIdx: index("knowledge_document_reviews_document_idx").on(
      table.documentId,
      table.createdAt,
    ),
    revisionIdx: index("knowledge_document_reviews_revision_idx").on(
      table.revisionId,
    ),
  }),
);

/**
 * Knowledge source backlinks: track which issues a knowledge document
 * references, enabling back-navigation from issues to knowledge.
 */
export const knowledgeSourceBacklinks = pgTable(
  "knowledge_source_backlinks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
    sourceIssueId: uuid("source_issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    sourceType: text("source_type").notNull().default("referenced_in_body"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    documentIssueUnique: uniqueIndex(
      "knowledge_source_backlinks_doc_issue_unique_idx",
    ).on(table.documentId, table.sourceIssueId),
    issueIdx: index("knowledge_source_backlinks_issue_idx").on(
      table.sourceIssueId,
    ),
  }),
);