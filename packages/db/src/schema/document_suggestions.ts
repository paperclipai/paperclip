import type {
  DocumentAnnotationAnchorConfidence,
  DocumentAnnotationAnchorSelector,
  DocumentAnnotationAnchorState,
  DocumentSuggestionInsertPosition,
  DocumentSuggestionKind,
  DocumentSuggestionStatus,
} from "@paperclipai/shared";
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { documentRevisions } from "./document_revisions.js";
import { documents } from "./documents.js";
import { issues } from "./issues.js";

export const documentSuggestions = pgTable(
  "document_suggestions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    documentKey: text("document_key").notNull(),
    kind: text("kind").$type<DocumentSuggestionKind>().notNull(),
    status: text("status").$type<DocumentSuggestionStatus>().notNull().default("pending"),
    anchorState: text("anchor_state").$type<DocumentAnnotationAnchorState>().notNull().default("active"),
    anchorConfidence: text("anchor_confidence").$type<DocumentAnnotationAnchorConfidence>().notNull().default("exact"),
    originalRevisionId: uuid("original_revision_id").references(() => documentRevisions.id, { onDelete: "set null" }),
    originalRevisionNumber: integer("original_revision_number").notNull(),
    currentRevisionId: uuid("current_revision_id").references(() => documentRevisions.id, { onDelete: "set null" }),
    currentRevisionNumber: integer("current_revision_number").notNull(),
    selectedText: text("selected_text").notNull(),
    proposedText: text("proposed_text"),
    insertionPosition: text("insertion_position").$type<DocumentSuggestionInsertPosition>(),
    prefixText: text("prefix_text").notNull().default(""),
    suffixText: text("suffix_text").notNull().default(""),
    normalizedStart: integer("normalized_start").notNull(),
    normalizedEnd: integer("normalized_end").notNull(),
    markdownStart: integer("markdown_start").notNull(),
    markdownEnd: integer("markdown_end").notNull(),
    anchorSelector: jsonb("anchor_selector").$type<DocumentAnnotationAnchorSelector>().notNull(),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    acceptedByAgentId: uuid("accepted_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    acceptedByUserId: text("accepted_by_user_id"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedRevisionId: uuid("accepted_revision_id").references(() => documentRevisions.id, { onDelete: "set null" }),
    rejectedByAgentId: uuid("rejected_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    rejectedByUserId: text("rejected_by_user_id"),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    resolvedByAgentId: uuid("resolved_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    resolvedByUserId: text("resolved_by_user_id"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyDocumentStatusIdx: index("document_suggestions_company_document_status_idx").on(
      table.companyId,
      table.documentId,
      table.status,
    ),
    companyIssueStatusIdx: index("document_suggestions_company_issue_status_idx").on(
      table.companyId,
      table.issueId,
      table.status,
    ),
    companyCurrentRevisionPendingIdx: index("document_suggestions_company_current_revision_pending_idx").on(
      table.companyId,
      table.documentId,
      table.currentRevisionId,
      table.status,
    ),
    companyAnchorStateIdx: index("document_suggestions_company_anchor_state_idx").on(table.companyId, table.anchorState),
  }),
);
