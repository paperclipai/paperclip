import { pgTable, uuid, text, timestamp, date, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { goals } from "./goals.js";
import { agents } from "./agents.js";
import { issuePrefixes } from "./issue_prefixes.js";

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    goalId: uuid("goal_id").references(() => goals.id),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("backlog"),
    leadAgentId: uuid("lead_agent_id").references(() => agents.id),
    issuePrefix: text("issue_prefix").references(() => issuePrefixes.prefix, { onDelete: "set null", onUpdate: "cascade" }),
    targetDate: date("target_date"),
    color: text("color"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("projects_company_idx").on(table.companyId),
  }),
);
