import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

export type Rt2SemanticIndexSourceType = "daily_wiki_page" | "graph_node" | "graph_edge" | "work_artifact";

export const rt2V33SemanticIndexChunks = pgTable(
  "rt2_v33_semantic_index_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    sourceType: text("source_type").$type<Rt2SemanticIndexSourceType>().notNull(),
    sourceId: text("source_id").notNull(),
    sourceKey: text("source_key").notNull(),
    chunkKey: text("chunk_key").notNull(),
    chunkText: text("chunk_text").notNull(),
    contentHash: text("content_hash").notNull(),
    embedding: jsonb("embedding").$type<number[]>().notNull().default([]),
    embeddingModel: text("embedding_model").notNull(),
    embeddingProvider: text("embedding_provider").notNull(),
    embeddingDimension: integer("embedding_dimension").notNull(),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }).notNull(),
    freshness: text("freshness").notNull().default("fresh"),
    provenance: jsonb("provenance").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySourceChunkUq: uniqueIndex("rt2_v33_semantic_chunks_company_source_chunk_uq").on(
      table.companyId,
      table.sourceType,
      table.sourceId,
      table.chunkKey,
    ),
    companyProjectSourceIdx: index("rt2_v33_semantic_chunks_company_project_source_idx").on(
      table.companyId,
      table.projectId,
      table.sourceType,
    ),
    companyFreshnessIdx: index("rt2_v33_semantic_chunks_company_freshness_idx").on(
      table.companyId,
      table.freshness,
    ),
    companyContentHashIdx: index("rt2_v33_semantic_chunks_company_content_hash_idx").on(
      table.companyId,
      table.contentHash,
    ),
  }),
);

export const rt2V33SemanticIndexRuns = pgTable(
  "rt2_v33_semantic_index_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    mode: text("mode").$type<"full" | "changed">().notNull(),
    status: text("status").$type<"running" | "completed" | "error">().notNull().default("running"),
    providerMode: text("provider_mode").$type<"provider" | "fallback">().notNull(),
    embeddingModel: text("embedding_model").notNull(),
    sourcesScanned: integer("sources_scanned").notNull().default(0),
    chunksRefreshed: integer("chunks_refreshed").notNull().default(0),
    chunksSkipped: integer("chunks_skipped").notNull().default(0),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStartedIdx: index("rt2_v33_semantic_runs_company_started_idx").on(table.companyId, table.startedAt),
    companyStatusIdx: index("rt2_v33_semantic_runs_company_status_idx").on(table.companyId, table.status),
  }),
);
