import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  vector,
} from "drizzle-orm/pg-core";
import { agents, companies, authUsers } from "./index.js";

/**
 * Knowledge base schema for document storage and semantic search
 */

export const knowledgeDocuments = pgTable(
  "knowledge_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").references(() => agents.id),
    name: text("name").notNull(),
    contentType: text("content_type"), // application/pdf, text/plain, text/markdown
    fileSize: integer("file_size"),
    originalPath: text("original_path"),
    status: text("status").notNull().default("processing"), // processing, ready, error
    errorMessage: text("error_message"),
    chunkCount: integer("chunk_count").default(0),
    embeddingModel: text("embedding_model"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => authUsers.id),
  },
  (table) => ({
    companyIdx: index("knowledge_documents_company_idx").on(table.companyId),
    agentIdx: index("knowledge_documents_agent_idx").on(table.agentId),
    statusIdx: index("knowledge_documents_status_idx").on(table.status),
  }),
);

export const knowledgeChunks = pgTable(
  "knowledge_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id").notNull().references(() => knowledgeDocuments.id),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    tokens: integer("tokens"),
    embedding: vector("embedding", { dimensions: 1536 }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    documentIdx: index("knowledge_chunks_document_idx").on(table.documentId, table.chunkIndex),
  }),
);

export const agentMemory = pgTable(
  "agent_memory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    memoryType: text("memory_type").notNull(), // conversation, learned_fact, preference, insight
    content: jsonb("content").$type<Record<string, unknown>>().notNull(),
    relevanceScore: integer("relevance_score").default(100), // 0-100
    lastAccessed: timestamp("last_accessed", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentIdx: index("agent_memory_agent_idx").on(table.agentId),
    typeIdx: index("agent_memory_type_idx").on(table.agentId, table.memoryType),
    accessedIdx: index("agent_memory_accessed_idx").on(table.agentId),
  }),
);

export const conversationHistory = pgTable(
  "conversation_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    role: text("role").notNull(), // user, assistant
    content: text("content").notNull(),
    tokens: integer("tokens"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentIdx: index("conversation_history_agent_idx").on(table.agentId, table.createdAt),
    createdIdx: index("conversation_history_created_idx").on(table.createdAt),
  }),
);

export const conversationSummaries = pgTable(
  "conversation_summaries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    summaryType: text("summary_type"), // periodic, long_term, learning
    summaryText: text("summary_text").notNull(),
    coveredFromId: uuid("covered_from_id").references(() => conversationHistory.id),
    coveredToId: uuid("covered_to_id").references(() => conversationHistory.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentIdx: index("conversation_summaries_agent_idx").on(table.agentId, table.createdAt),
  }),
);

export const agentKnowledgeAssociations = pgTable(
  "agent_knowledge_associations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    documentId: uuid("document_id").notNull().references(() => knowledgeDocuments.id),
    associationType: text("association_type"), // primary, secondary, reference
    customRelevance: integer("custom_relevance"), // 0-100, overrides default
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentIdx: index("agent_knowledge_agent_idx").on(table.agentId),
    documentIdx: index("agent_knowledge_document_idx").on(table.documentId),
    uniqueAssoc: uniqueIndex("agent_knowledge_unique").on(table.agentId, table.documentId),
  }),
);
