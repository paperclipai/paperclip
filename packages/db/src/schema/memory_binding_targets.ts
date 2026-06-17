import { foreignKey, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { memoryBindings } from "./memory_bindings.js";

export const memoryBindingTargets = pgTable(
  "memory_binding_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    targetType: text("target_type").$type<"company" | "agent">().notNull(),
    targetId: uuid("target_id").notNull(),
    bindingId: uuid("binding_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyTargetUq: uniqueIndex("memory_binding_targets_company_target_uq").on(
      table.companyId,
      table.targetType,
      table.targetId,
    ),
    bindingCompanyFk: foreignKey({
      name: "memory_binding_targets_binding_company_fk",
      columns: [table.bindingId, table.companyId],
      foreignColumns: [memoryBindings.id, memoryBindings.companyId],
    }).onDelete("cascade"),
  }),
);
