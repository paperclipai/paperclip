import type { DocumentLinkTargetType } from "@paperclipai/shared";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { documents } from "./documents.js";
import { issueDocuments } from "./issue_documents.js";

export const documentLinks = pgTable(
  "document_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    targetType: text("target_type").$type<DocumentLinkTargetType>().notNull(),
    targetId: uuid("target_id").notNull(),
    relationship: text("relationship").notNull().default("related"),
    issueDocumentId: uuid("issue_document_id").references(() => issueDocuments.id, { onDelete: "cascade" }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    documentTargetUq: uniqueIndex("document_links_document_target_uq").on(
      table.companyId,
      table.documentId,
      table.targetType,
      table.targetId,
    ),
    companyTargetIdx: index("document_links_company_target_idx").on(
      table.companyId,
      table.targetType,
      table.targetId,
    ),
    companyDocumentIdx: index("document_links_company_document_idx").on(table.companyId, table.documentId),
    issueDocumentIdx: index("document_links_issue_document_idx").on(table.issueDocumentId),
  }),
);
