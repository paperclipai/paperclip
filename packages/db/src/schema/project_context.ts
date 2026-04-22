import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";
import { assets } from "./assets.js";
import { agents } from "./agents.js";

export const projectContextProfiles = pgTable(
  "project_context_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    goalMarkdown: text("goal_markdown").notNull().default(""),
    instructionsMarkdown: text("instructions_markdown").notNull().default(""),
    defaultSkillKeys: jsonb("default_skill_keys").$type<string[]>().notNull().default([]),
    retrievalEnabled: boolean("retrieval_enabled").notNull().default(true),
    maxBundleChars: integer("max_bundle_chars").notNull().default(12_000),
    maxChunks: integer("max_chunks").notNull().default(8),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectUniqueIdx: uniqueIndex("project_context_profiles_project_uq").on(table.projectId),
    companyProjectIdx: index("project_context_profiles_company_project_idx").on(table.companyId, table.projectId),
  }),
);

export const contextSources = pgTable(
  "context_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    sourceType: text("source_type").notNull(),
    provider: text("provider"),
    title: text("title").notNull(),
    uri: text("uri"),
    status: text("status").notNull().default("ready"),
    statusMessage: text("status_message"),
    assetId: uuid("asset_id").references(() => assets.id, { onDelete: "set null" }),
    externalId: text("external_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProjectIdx: index("context_sources_company_project_idx").on(table.companyId, table.projectId),
    projectStatusIdx: index("context_sources_project_status_idx").on(table.projectId, table.status),
    sourceExternalIdx: index("context_sources_external_idx").on(table.companyId, table.sourceType, table.externalId),
  }),
);

export const contextSourceItems = pgTable(
  "context_source_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id").notNull().references(() => contextSources.id, { onDelete: "cascade" }),
    externalId: text("external_id"),
    title: text("title").notNull(),
    uri: text("uri"),
    mimeType: text("mime_type"),
    bodyText: text("body_text"),
    bodySha256: text("body_sha256"),
    status: text("status").notNull().default("ready"),
    statusMessage: text("status_message"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    sourceModifiedAt: timestamp("source_modified_at", { withTimezone: true }),
    indexedAt: timestamp("indexed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProjectIdx: index("context_source_items_company_project_idx").on(table.companyId, table.projectId),
    sourceIdx: index("context_source_items_source_idx").on(table.sourceId),
    sourceExternalUq: uniqueIndex("context_source_items_source_external_uq").on(table.sourceId, table.externalId),
  }),
);

export const contextSourceChunks = pgTable(
  "context_source_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id").notNull().references(() => contextSources.id, { onDelete: "cascade" }),
    itemId: uuid("item_id").notNull().references(() => contextSourceItems.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    tokenEstimate: integer("token_estimate").notNull().default(0),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProjectIdx: index("context_source_chunks_company_project_idx").on(table.companyId, table.projectId),
    sourceIdx: index("context_source_chunks_source_idx").on(table.sourceId),
    itemChunkUq: uniqueIndex("context_source_chunks_item_chunk_uq").on(table.itemId, table.chunkIndex),
    contentSearchIdx: index("context_source_chunks_content_search_idx").using(
      "gin",
      sql`to_tsvector('english', ${table.content})`,
    ),
  }),
);

export const contextSourceSyncRuns = pgTable(
  "context_source_sync_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id").notNull().references(() => contextSources.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    itemCount: integer("item_count").notNull().default(0),
    chunkCount: integer("chunk_count").notNull().default(0),
    error: text("error"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  },
  (table) => ({
    sourceStartedIdx: index("context_source_sync_runs_source_started_idx").on(table.sourceId, table.startedAt),
    companyProjectIdx: index("context_source_sync_runs_company_project_idx").on(table.companyId, table.projectId),
  }),
);
