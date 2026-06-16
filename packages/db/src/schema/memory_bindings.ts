import { boolean, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Per-binding provider configuration. All fields are optional; the memory
 * service applies defaults (see server/src/services/memory/types.ts).
 */
export interface MemoryBindingConfig {
  binPath?: string;
  queryTimeoutMs?: number;
  captureTimeoutMs?: number;
  topK?: number;
  hydrateEnabled?: boolean;
  captureRunsEnabled?: boolean;
  maxSnippetChars?: number;
  maxBundleChars?: number;
}

export const memoryBindings = pgTable(
  "memory_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    key: text("key").notNull().default("default"),
    provider: text("provider").notNull(),
    config: jsonb("config").$type<MemoryBindingConfig>().notNull().default({}),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKeyUq: uniqueIndex("memory_bindings_company_key_uq").on(table.companyId, table.key),
    idCompanyUq: unique("memory_bindings_id_company_uq").on(table.id, table.companyId),
  }),
);
