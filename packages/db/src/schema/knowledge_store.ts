import {
  pgTable,
  uuid,
  text,
  integer,
  real,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { projects } from "./projects.js";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

export const knowledgeStore = pgTable(
  "knowledge_store",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").references(() => companies.id),
    sourceAgentId: uuid("source_agent_id").references(() => agents.id),
    sourcePlatform: text("source_platform").notNull().default("claude_local"),
    category: text("category").notNull().default("observation"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    tags: text("tags").array().notNull().default([]),
    projectId: uuid("project_id").references(() => projects.id),
    relevanceScore: real("relevance_score").notNull().default(1.0),
    accessCount: integer("access_count").notNull().default(0),
    supersededBy: uuid("superseded_by").references((): AnyPgColumn => knowledgeStore.id),
    ttlDays: integer("ttl_days"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCategoryIdx: index("knowledge_store_company_category_idx").on(table.companyId, table.category),
    sourceAgentIdx: index("knowledge_store_source_agent_idx").on(table.sourceAgentId),
    relevanceIdx: index("knowledge_store_relevance_idx").on(table.relevanceScore),
    projectIdx: index("knowledge_store_project_idx").on(table.projectId),
    createdIdx: index("knowledge_store_created_idx").on(table.createdAt),
  }),
);
