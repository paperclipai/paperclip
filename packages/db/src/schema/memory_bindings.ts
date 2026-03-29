import { pgTable, uuid, text, boolean, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const memoryBindings = pgTable(
  "memory_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    key: text("key").notNull(),
    providerType: text("provider_type").notNull(),
    config: jsonb("config").notNull().default({}),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKeyUniqueIdx: uniqueIndex("memory_bindings_company_key_idx").on(table.companyId, table.key),
  }),
);
