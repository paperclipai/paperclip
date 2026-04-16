import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  boolean,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { plugins } from "./plugins.js";

/**
 * `memory_bindings` table — company-scoped configuration records that bind a
 * memory provider (e.g. vector store, knowledge graph) to a company.
 *
 * Each binding carries provider-specific config and a capabilities manifest
 * describing what the provider supports (write, query, forget, browse, correct).
 */
export const memoryBindings = pgTable(
  "memory_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** Unique key within the company (e.g. "default", "long-term", "project-kb"). */
    key: text("key").notNull(),
    /** Identifies the provider implementation (e.g. "pinecone", "qdrant", "pg-vector"). */
    providerKey: text("provider_key").notNull(),
    /** Optional FK to the plugin that registered this binding. */
    pluginId: uuid("plugin_id").references(() => plugins.id, {
      onDelete: "set null",
    }),
    /** Provider-specific configuration (connection strings, model params, etc.). */
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    /** Capability manifest describing supported operations. */
    capabilities: jsonb("capabilities")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKeyIdx: uniqueIndex("memory_bindings_company_key_idx").on(
      table.companyId,
      table.key,
    ),
    companyIdx: index("memory_bindings_company_idx").on(table.companyId),
  }),
);
