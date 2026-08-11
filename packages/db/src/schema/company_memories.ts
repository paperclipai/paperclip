import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

// Durable company-scoped knowledge an agent chooses to remember and can later
// recall across runs. Row-per-fact (not a single blob) so recall can filter by
// tag and rank by recency. Keyword recall uses the same pg_trgm GIN index the
// documents table uses; semantic/vector recall is a deliberate later step.
export const companyMemories = pgTable(
  "company_memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    title: text("title"),
    content: text("content").notNull(),
    tags: text("tags").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("company_memories_company_created_idx").on(table.companyId, table.createdAt),
    contentSearchIdx: index("company_memories_content_search_idx").using("gin", table.content.op("gin_trgm_ops")),
  }),
);
