import { boolean, index, integer, pgTable, text, timestamp, uuid, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const agentPolicies = pgTable(
  "agent_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    key: text("key").notNull(),
    title: text("title").notNull(),
    format: text("format").notNull().default("markdown"),
    latestBody: text("latest_body").notNull().default(""),
    latestRevisionId: uuid("latest_revision_id"),
    latestRevisionNumber: integer("latest_revision_number").notNull().default(0),
    scope: text("scope").notNull().default("agent"),
    scopeId: uuid("scope_id"),
    active: boolean("active").notNull().default(true),
    createdByAgentId: uuid("created_by_agent_id"),
    createdByUserId: text("created_by_user_id"),
    updatedByAgentId: uuid("updated_by_agent_id"),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentKeyUniqueIdx: uniqueIndex("agent_policies_agent_key_unique_idx").on(
      table.agentId,
      table.key,
    ),
    companyAgentActiveIdx: index("agent_policies_company_agent_active_idx").on(
      table.companyId,
      table.agentId,
      table.active,
    ),
  }),
);
