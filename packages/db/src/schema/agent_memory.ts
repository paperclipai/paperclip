import { pgTable, uuid, text, timestamp, jsonb, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * Agent memory — persistent key-value store per agent.
 *
 * Each agent can store working memory (facts, preferences, learned context)
 * that survives across heartbeat invocations. Values are optionally
 * backed by HashiCorp Vault for encryption at rest.
 */
export const agentMemory = pgTable(
  "agent_memory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    /** Namespaced key, e.g. "preferences.language" or "context.last_task" */
    key: text("key").notNull(),
    /** Plain-text value (for non-sensitive data stored in DB) */
    value: text("value"),
    /** Structured metadata about this memory entry */
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    /** If stored in Vault, the Vault path reference */
    vaultRef: text("vault_ref"),
    /** TTL in seconds — null means permanent */
    ttlSeconds: integer("ttl_seconds"),
    /** Expiry timestamp (computed from TTL at write time) */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentIdx: index("agent_memory_agent_idx").on(table.agentId),
    companyIdx: index("agent_memory_company_idx").on(table.companyId),
    agentKeyUq: uniqueIndex("agent_memory_agent_key_uq").on(table.agentId, table.key),
    expiresIdx: index("agent_memory_expires_idx").on(table.expiresAt),
  }),
);
