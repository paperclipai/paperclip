import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const rt2V33WikiPages = pgTable(
  "rt2_v33_wiki_pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    pageKey: text("page_key").notNull(),
    pageType: text("page_type").notNull(),
    title: text("title").notNull(),
    markdown: text("markdown").notNull().default(""),
    summary: jsonb("summary").$type<string[]>().notNull().default([]),
    sourceEventIds: jsonb("source_event_ids").$type<string[]>().notNull().default([]),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyPageKeyUq: uniqueIndex("rt2_v33_wiki_pages_company_page_key_uq").on(
      table.companyId,
      table.pageKey,
    ),
    companyTypeUpdatedIdx: index("rt2_v33_wiki_pages_company_type_updated_idx").on(
      table.companyId,
      table.pageType,
      table.updatedAt,
    ),
  }),
);
