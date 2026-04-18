import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * Cross-agent long-term memory store.
 *
 * Agents write learnings, patterns, and insights as structured JSON values
 * scoped by (company, namespace, key). All agents within a company can read
 * any namespace, enabling shared knowledge across the organisation.
 *
 * When `agentId` is set the memory is attributed to a specific author;
 * when null the memory is considered "shared / system-level".
 */
export const agentMemories = pgTable(
  "agent_memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").references(() => agents.id),
    namespace: text("namespace").notNull(),
    key: text("key").notNull(),
    value: jsonb("value").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyNamespaceKeyIdx: uniqueIndex("agent_memories_company_ns_key_idx").on(
      table.companyId,
      table.namespace,
      table.key,
    ),
    companyNamespaceIdx: index("agent_memories_company_ns_idx").on(table.companyId, table.namespace),
    agentIdx: index("agent_memories_agent_idx").on(table.agentId),
  }),
);
