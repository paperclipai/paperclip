import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const agentMemories = pgTable(
  "agent_memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    category: text("category").notNull().default("general"),
    key: text("key").notNull(),
    content: text("content").notNull(),
    importance: integer("importance").notNull().default(5),
    sourceRunId: uuid("source_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    sourceIssueId: uuid("source_issue_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentUpdatedIdx: index("agent_memories_company_agent_updated_idx").on(
      table.companyId,
      table.agentId,
      table.updatedAt,
    ),
    companyAgentCategoryIdx: index("agent_memories_company_agent_category_idx").on(
      table.companyId,
      table.agentId,
      table.category,
    ),
    companyAgentCategoryKeyUniq: uniqueIndex("agent_memories_company_agent_category_key_uniq").on(
      table.companyId,
      table.agentId,
      table.category,
      table.key,
    ),
  }),
);
