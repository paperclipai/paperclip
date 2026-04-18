import { pgTable, uuid, text, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { slaPolicies } from "./sla_policies.js";

export const slaPolicyRules = pgTable(
  "sla_policy_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    policyId: uuid("policy_id").notNull().references(() => slaPolicies.id, { onDelete: "cascade" }),
    priority: text("priority").notNull(),
    targetHours: integer("target_hours").notNull(),
    warningHours: integer("warning_hours"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    policyPriorityUq: uniqueIndex("sla_policy_rules_policy_priority_uq").on(table.policyId, table.priority),
  }),
);
