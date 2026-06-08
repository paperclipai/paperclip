import type { DocumentReviewThreadStatus } from "@paperclipai/shared";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { documents } from "./documents.js";
import { issues } from "./issues.js";

export const documentReviewThreads = pgTable(
  "document_review_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    documentKey: text("document_key").notNull(),
    status: text("status").$type<DocumentReviewThreadStatus>().notNull().default("open"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    resolvedByAgentId: uuid("resolved_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    resolvedByUserId: text("resolved_by_user_id"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyDocumentStatusIdx: index("document_review_threads_company_document_status_idx").on(
      table.companyId,
      table.documentId,
      table.status,
    ),
    companyIssueStatusIdx: index("document_review_threads_company_issue_status_idx").on(
      table.companyId,
      table.issueId,
      table.status,
    ),
  }),
);
