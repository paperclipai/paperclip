import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const agentMemoryEntries = pgTable(
  "agent_memory_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    memoryType: text("memory_type").notNull().default("semantic"),
    category: text("category"),
    content: text("content").notNull(),
    sourceIssueId: uuid("source_issue_id"),
    sourceProjectId: uuid("source_project_id"),
    confidence: integer("confidence").notNull().default(80),
    accessCount: integer("access_count").notNull().default(0),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentTypeIdx: index("agent_memory_entries_agent_type_idx").on(table.agentId, table.memoryType),
    companyAgentIdx: index("agent_memory_entries_company_agent_idx").on(table.companyId, table.agentId),
  }),
);
