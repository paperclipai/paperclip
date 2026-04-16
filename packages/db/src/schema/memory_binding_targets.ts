import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { memoryBindings } from "./memory_bindings.js";

/**
 * `memory_binding_targets` table — assignment join that maps a memory binding
 * to a target entity (company-wide or a specific agent).
 *
 * Priority determines resolution order when multiple bindings match the same
 * target scope.
 */
export const memoryBindingTargets = pgTable(
  "memory_binding_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bindingId: uuid("binding_id")
      .notNull()
      .references(() => memoryBindings.id, { onDelete: "cascade" }),
    /** Target scope: "company" or "agent". */
    targetType: text("target_type").notNull(),
    /** UUID of the target entity (company ID or agent ID). */
    targetId: uuid("target_id").notNull(),
    /** Lower value = higher priority when resolving overlapping bindings. */
    priority: integer("priority").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    bindingIdx: index("memory_binding_targets_binding_idx").on(table.bindingId),
    targetIdx: index("memory_binding_targets_target_idx").on(
      table.targetType,
      table.targetId,
    ),
    uniqueAssignment: uniqueIndex("memory_binding_targets_unique_idx").on(
      table.bindingId,
      table.targetType,
      table.targetId,
    ),
  }),
);
