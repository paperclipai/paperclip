import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { documents } from "./documents.js";

export const documentMemberships = pgTable(
  "document_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    starredAt: timestamp("starred_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUserStarredIdx: index("document_memberships_company_user_starred_idx").on(
      table.companyId,
      table.userId,
      table.starredAt,
    ),
    companyUserDocumentUq: uniqueIndex("document_memberships_company_user_document_uq").on(
      table.companyId,
      table.userId,
      table.documentId,
    ),
  }),
);
