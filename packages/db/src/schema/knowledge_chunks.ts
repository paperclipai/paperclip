import {
  customType,
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { knowledgePages } from "./knowledge_pages.js";
import { companies } from "./companies.js";

/**
 * Custom Drizzle type for pgvector's vector(768) column.
 * Used for nomic-embed-text embeddings (768d) on playbook chunks.
 *
 * The column is nullable so chunks can exist temporarily without
 * embeddings (e.g., during reindex while batched embedding API calls
 * are still in flight, or if Ollama is unreachable).
 */
const embeddingColumn = customType<{ data: number[]; notNull: false; default: false }>({
  dataType() {
    return "vector(768)";
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: unknown): number[] {
    if (typeof value === "string") {
      return value
        .replace(/^\[/, "")
        .replace(/\]$/, "")
        .split(",")
        .map((v) => parseFloat(v));
    }
    if (Array.isArray(value)) return value as number[];
    return [];
  },
});

/**
 * Chunked sections of knowledge_pages playbooks, enabling RAG.
 *
 * Each row is one H2 section of a playbook (per PLAYBOOK_STANDARD.md).
 * Agents query by cosine similarity to retrieve 2-5 relevant chunks
 * instead of loading the entire playbook into every prompt.
 *
 * Embedding model: nomic-embed-text (768 dims) via Ollama Cloud.
 */
export const knowledgeChunks = pgTable(
  "knowledge_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pageId: uuid("page_id").notNull().references(() => knowledgePages.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),

    // Source metadata (denormalized from page for fast filtering)
    department: text("department"),
    ownerRole: text("owner_role"),
    audience: text("audience"),
    documentType: text("document_type"),

    // Chunk content
    anchor: text("anchor").notNull(),        // "#cost-attribution-model"
    heading: text("heading").notNull(),       // "Cost Attribution Model"
    headingPath: text("heading_path").notNull(), // "CFO Playbook > Cost Attribution Model"
    body: text("body").notNull(),
    tokenCount: integer("token_count").notNull(),
    orderNum: integer("order_num").notNull(),

    embedding: embeddingColumn("embedding"),

    sourceRevision: integer("source_revision").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pageIdx: index("knowledge_chunks_page_idx").on(table.pageId),
    companyDeptIdx: index("knowledge_chunks_company_dept_idx").on(table.companyId, table.department),
    companyDocTypeIdx: index("knowledge_chunks_company_doc_type_idx").on(table.companyId, table.documentType),
  }),
);
