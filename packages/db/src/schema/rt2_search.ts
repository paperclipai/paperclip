import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Search index metadata - tracks indexing state
 * M4.4: qmd 보조 검색을 위한 인덱스 메타데이터
 */
export const rt2SearchIndex = pgTable(
  "rt2_search_index",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    /** Document type being indexed */
    documentType: text("document_type").notNull(), // 'document', 'wiki_page', 'all'
    /** Last indexed document ID (for pagination) */
    lastIndexedId: uuid("last_indexed_id"),
    /** Total documents indexed */
    indexedCount: integer("indexed_count").notNull().default(0),
    /** Total pages indexed (for wiki) */
    indexedPages: integer("indexed_pages").notNull().default(0),
    /** Index status */
    status: text("status").notNull().default("idle"), // 'idle', 'indexing', 'error'
    /** Error message if failed */
    errorMessage: text("error_message"),
    /** When indexing started */
    indexingStartedAt: timestamp("indexing_started_at", { withTimezone: true }),
    /** When indexing completed */
    indexingCompletedAt: timestamp("indexing_completed_at", { withTimezone: true }),
    /** Search features enabled */
    featuresEnabled: text("features_enabled").notNull().default("keyword"), // 'keyword', 'hybrid'
    // Timestamps
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("search_index_company_idx").on(table.companyId),
    statusIdx: index("search_index_status_idx").on(table.status),
  }),
);

/**
 * Search log - tracks search queries for analytics
 * M4.4: 검색 로그
 */
export const rt2SearchLog = pgTable(
  "rt2_search_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    /** Search query */
    query: text("query").notNull(),
    /** Results returned */
    resultsCount: integer("results_count").notNull().default(0),
    /** Time taken in ms */
    searchTimeMs: integer("search_time_ms").notNull().default(0),
    /** Search type used */
    searchType: text("search_type").notNull().default("keyword"), // 'keyword', 'hybrid'
    /** User or agent who searched */
    actorId: text("actor_id"),
    actorType: text("actor_type"), // 'user', 'agent'
    // Timestamps
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyQueryIdx: index("search_log_company_query_idx").on(table.companyId, table.query),
    createdAtIdx: index("search_log_created_idx").on(table.createdAt),
  }),
);