import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { records } from "./records.js";

// Knowledge entries are durable published artifacts derived from records or authored directly later.
export const knowledgeEntries = pgTable(
  "knowledge_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    title: text("title").notNull(),
    summary: text("summary"),
    bodyMd: text("body_md"),
    sourceRecordId: uuid("source_record_id").references(() => records.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    scopeType: text("scope_type").notNull(),
    scopeRefId: uuid("scope_ref_id").notNull(),
    status: text("status").notNull().default("draft"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyScopeIdx: index("knowledge_entries_company_scope_idx").on(table.companyId, table.scopeType, table.scopeRefId, table.updatedAt),
    sourceRecordUq: uniqueIndex("knowledge_entries_source_record_uq").on(table.sourceRecordId),
  }),
);
