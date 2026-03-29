import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { memoryBindings } from "./memory_bindings.js";

export const memoryEntries = pgTable(
  "memory_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    bindingId: uuid("binding_id").notNull().references(() => memoryBindings.id),
    content: text("content").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceRef: jsonb("source_ref").notNull().default({}),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyBindingIdx: index("memory_entries_company_binding_idx").on(table.companyId, table.bindingId),
    companyCreatedIdx: index("memory_entries_company_created_idx").on(table.companyId, table.createdAt),
  }),
);
