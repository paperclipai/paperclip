import type {
  DocumentAnnotationAnchorConfidence,
  DocumentAnnotationAnchorSnapshot,
  DocumentAnnotationAnchorState,
} from "@paperclipai/shared";
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { documentAnnotationThreads } from "./document_annotation_threads.js";
import { documentRevisions } from "./document_revisions.js";
import { documents } from "./documents.js";

export const documentAnnotationAnchorSnapshots = pgTable(
  "document_annotation_anchor_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    threadId: uuid("thread_id").notNull().references(() => documentAnnotationThreads.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    fromRevisionId: uuid("from_revision_id").references(() => documentRevisions.id, { onDelete: "set null" }),
    fromRevisionNumber: integer("from_revision_number"),
    toRevisionId: uuid("to_revision_id").references(() => documentRevisions.id, { onDelete: "set null" }),
    toRevisionNumber: integer("to_revision_number").notNull(),
    previousAnchor: jsonb("previous_anchor").$type<DocumentAnnotationAnchorSnapshot>().notNull(),
    nextAnchor: jsonb("next_anchor").$type<DocumentAnnotationAnchorSnapshot | null>(),
    anchorState: text("anchor_state").$type<DocumentAnnotationAnchorState>().notNull(),
    anchorConfidence: text("anchor_confidence").$type<DocumentAnnotationAnchorConfidence>().notNull(),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyThreadCreatedAtIdx: index("document_annotation_anchor_snapshots_company_thread_created_at_idx").on(
      table.companyId,
      table.threadId,
      table.createdAt,
    ),
    companyDocumentRevisionIdx: index("document_annotation_anchor_snapshots_company_document_revision_idx").on(
      table.companyId,
      table.documentId,
      table.toRevisionNumber,
    ),
  }),
);
