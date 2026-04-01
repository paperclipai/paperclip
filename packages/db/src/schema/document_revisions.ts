import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { documents } from "./documents.js";

export const documentRevisions = pgTable(
  "document_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    revisionNumber: integer("revision_number").notNull(),
    title: text("title"),
    format: text("format").notNull().default("markdown"),
    body: text("body").notNull(),
    changeSummary: text("change_summary"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    documentRevisionUq: uniqueIndex("document_revisions_document_revision_uq").on(
      table.documentId,
      table.revisionNumber,
    ),
    companyDocumentCreatedIdx: index("document_revisions_company_document_created_idx").on(
      table.companyId,
      table.documentId,
      table.createdAt,
    ),
  }),
);
