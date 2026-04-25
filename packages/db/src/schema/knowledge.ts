import { index, pgTable, text, timestamp, uuid, integer, boolean } from "drizzle-orm/pg-core";

export const knowledgeTopics = pgTable(
  "knowledge_topics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull().unique(),
    slug: text("slug").notNull().unique(),
    description: text("description"),
    tier: integer("tier").notNull().default(1),
    status: text("status").notNull().default("active"),
    refreshIntervalHours: integer("refresh_interval_hours").notNull().default(48),
    lastCrawledAt: timestamp("last_crawled_at", { withTimezone: true }),
    nextCrawlAt: timestamp("next_crawl_at", { withTimezone: true }),
    chunkCount: integer("chunk_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    slugIdx: index("knowledge_topics_slug_idx").on(table.slug),
    tierIdx: index("knowledge_topics_tier_idx").on(table.tier),
    statusIdx: index("knowledge_topics_status_idx").on(table.status),
  }),
);

export type KnowledgeTopic = typeof knowledgeTopics.$inferSelect;
export type NewKnowledgeTopic = typeof knowledgeTopics.$inferInsert;

export const knowledgeSources = pgTable(
  "knowledge_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    topicId: uuid("topic_id")
      .notNull()
      .references(() => knowledgeTopics.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    sourceType: text("source_type").notNull().default("documentation"),
    title: text("title"),
    robotsAllowed: boolean("robots_allowed").notNull().default(true),
    rateLimitRespect: boolean("rate_limit_respect").notNull().default(true),
    crawlFrequencyHours: integer("crawl_frequency_hours").notNull().default(168),
    lastCrawledAt: timestamp("last_crawled_at", { withTimezone: true }),
    lastScrapedAt: timestamp("last_scraped_at", { withTimezone: true }),
    lastError: text("last_error"),
    pageCount: integer("page_count").notNull().default(0),
    isAllowed: boolean("is_allowed").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    topicIdIdx: index("knowledge_sources_topic_id_idx").on(table.topicId),
    urlIdx: index("knowledge_sources_url_idx").on(table.url),
    isAllowedIdx: index("knowledge_sources_is_allowed_idx").on(table.isAllowed),
  }),
);

export type KnowledgeSource = typeof knowledgeSources.$inferSelect;
export type NewKnowledgeSource = typeof knowledgeSources.$inferInsert;

export const knowledgeChunks = pgTable(
  "knowledge_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => knowledgeSources.id, { onDelete: "cascade" }),
    topicId: uuid("topic_id")
      .notNull()
      .references(() => knowledgeTopics.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    urlPath: text("url_path").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull().unique(),
    embedding: text("embedding").notNull(),
    bm25Score: text("bm25_score"),
    chunkIndex: integer("chunk_index").notNull().default(0),
    tokenEstimate: integer("token_estimate").notNull().default(0),
    heading: text("heading"),
    section: text("section"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sourceIdIdx: index("knowledge_chunks_source_id_idx").on(table.sourceId),
    topicIdIdx: index("knowledge_chunks_topic_id_idx").on(table.topicId),
    contentHashIdx: index("knowledge_chunks_content_hash_idx").on(table.contentHash),
    urlPathIdx: index("knowledge_chunks_url_path_idx").on(table.urlPath),
    tokenEstimateIdx: index("knowledge_chunks_token_estimate_idx").on(table.tokenEstimate),
  }),
);

export type KnowledgeChunk = typeof knowledgeChunks.$inferSelect;
export type NewKnowledgeChunk = typeof knowledgeChunks.$inferInsert;

export const knowledgeCrawlRuns = pgTable(
  "knowledge_crawl_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => knowledgeSources.id, { onDelete: "cascade" }),
    topicId: uuid("topic_id")
      .notNull()
      .references(() => knowledgeTopics.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    pagesDiscovered: integer("pages_discovered").notNull().default(0),
    pagesCrawled: integer("pages_crawled").notNull().default(0),
    pagesIndexed: integer("pages_indexed").notNull().default(0),
    chunksCreated: integer("chunks_created").notNull().default(0),
    errorMessage: text("error_message"),
    errorCode: text("error_code"),
    crawlerVersion: text("crawler_version"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sourceIdIdx: index("knowledge_crawl_runs_source_id_idx").on(table.sourceId),
    topicIdIdx: index("knowledge_crawl_runs_topic_id_idx").on(table.topicId),
    statusIdx: index("knowledge_crawl_runs_status_idx").on(table.status),
    startedAtIdx: index("knowledge_crawl_runs_started_at_idx").on(table.startedAt),
  }),
);

export type KnowledgeCrawlRun = typeof knowledgeCrawlRuns.$inferSelect;
export type NewKnowledgeCrawlRun = typeof knowledgeCrawlRuns.$inferInsert;

export const knowledgeStaleReports = pgTable(
  "knowledge_stale_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    topicSlug: text("topic_slug").notNull(),
    agentId: uuid("agent_id").notNull(),
    agentName: text("agent_name").notNull(),
    issueLink: text("issue_link").notNull(),
    companyId: uuid("company_id").notNull(),
    priority: text("priority").notNull().default("medium"),
    trigger: text("trigger").notNull().default("agent_stale_report"),
    resolutionStatus: text("resolution_status").notNull().default("pending"),
    resolutionDetail: text("resolution_detail"),
    crawlRunId: uuid("crawl_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => ({
    topicSlugIdx: index("knowledge_stale_reports_topic_slug_idx").on(table.topicSlug),
    agentIdIdx: index("knowledge_stale_reports_agent_id_idx").on(table.agentId),
    companyIdIdx: index("knowledge_stale_reports_company_id_idx").on(table.companyId),
    resolutionStatusIdx: index("knowledge_stale_reports_resolution_status_idx").on(table.resolutionStatus),
    createdAtIdx: index("knowledge_stale_reports_created_at_idx").on(table.createdAt),
  }),
);

export type KnowledgeStaleReport = typeof knowledgeStaleReports.$inferSelect;
export type NewKnowledgeStaleReport = typeof knowledgeStaleReports.$inferInsert;