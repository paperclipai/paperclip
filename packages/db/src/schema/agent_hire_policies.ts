import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export type HireCombination = {
  adapterType: string | "*";
  role: string | "*";
  parent: string | "self" | "*" | null;
};

export const agentHirePolicies = pgTable(
  "agent_hire_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    allowedCombinations: jsonb("allowed_combinations")
      .$type<HireCombination[]>()
      .notNull()
      .default([]),
    maxHiresPerMinute: integer("max_hires_per_minute"),
    maxHiresPerHour: integer("max_hires_per_hour"),
    notes: text("notes"),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentUniqueIdx: uniqueIndex("agent_hire_policies_agent_unique_idx").on(table.agentId),
  }),
);
