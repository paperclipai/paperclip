import { pgTable, uuid, text, timestamp, jsonb, integer, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { memoryBindings } from "./memory_bindings.js";

export const memoryOperations = pgTable(
  "memory_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    bindingId: uuid("binding_id").notNull().references(() => memoryBindings.id),
    operationType: text("operation_type").notNull(),
    scope: jsonb("scope").notNull().default({}),
    latencyMs: integer("latency_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("memory_operations_company_created_idx").on(table.companyId, table.createdAt),
    companyBindingIdx: index("memory_operations_company_binding_idx").on(table.companyId, table.bindingId),
  }),
);
