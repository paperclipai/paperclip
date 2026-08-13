import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { goals } from "./goals.js";
import { goalTargets } from "./goal_targets.js";

/**
 * Directed relations in the goal layer. `serves`: an initiative/epic
 * (fromGoalId) advances a goal (toGoalId) or a specific goal target
 * (toTargetId) — exactly one of the two is set.
 */
export const goalRelations = pgTable(
  "goal_relations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    type: text("type").$type<"serves">().notNull(),
    fromGoalId: uuid("from_goal_id").notNull().references(() => goals.id, { onDelete: "cascade" }),
    toGoalId: uuid("to_goal_id").references(() => goals.id, { onDelete: "cascade" }),
    toTargetId: uuid("to_target_id").references(() => goalTargets.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyFromIdx: index("goal_relations_company_from_idx").on(table.companyId, table.fromGoalId),
    companyToGoalIdx: index("goal_relations_company_to_goal_idx").on(table.companyId, table.toGoalId),
    companyToTargetIdx: index("goal_relations_company_to_target_idx").on(table.companyId, table.toTargetId),
  }),
);
