import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { teams } from "./teams.js";
import { documents } from "./documents.js";

/**
 * Join table between teams and documents.
 *
 * One team can have many documents, each identified by a URL-safe key
 * (e.g. "rules", "playbook", "readme"). The underlying markdown/body
 * lives in the shared `documents` table so that we reuse its revision
 * history, created/updated audit, and format support for free.
 *
 * (team_id, key) is unique — no two docs can share a slug within a team.
 * (document_id) is unique — a document belongs to at most one team.
 */
export const teamDocuments = pgTable(
  "team_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyTeamKeyUq: uniqueIndex("team_documents_company_team_key_uq").on(
      table.companyId,
      table.teamId,
      table.key,
    ),
    documentUq: uniqueIndex("team_documents_document_uq").on(table.documentId),
    companyTeamUpdatedIdx: index("team_documents_company_team_updated_idx").on(
      table.companyId,
      table.teamId,
      table.updatedAt,
    ),
  }),
);
