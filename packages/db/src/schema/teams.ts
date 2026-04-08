import { type AnyPgColumn, pgTable, uuid, text, integer, timestamp, index, uniqueIndex, jsonb } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    identifier: text("identifier").notNull(),
    description: text("description"),
    icon: text("icon"),
    color: text("color"),
    parentId: uuid("parent_id").references((): AnyPgColumn => teams.id),
    leadAgentId: uuid("lead_agent_id").references(() => agents.id),
    leadUserId: text("lead_user_id"),
    status: text("status").notNull().default("active"),
    issueCounter: integer("issue_counter").notNull().default(0),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("teams_company_idx").on(table.companyId),
    companyIdentifierUniq: uniqueIndex("teams_company_identifier_uniq").on(table.companyId, table.identifier),
    parentIdx: index("teams_parent_idx").on(table.parentId),
  }),
);
