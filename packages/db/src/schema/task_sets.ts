import { type AnyPgColumn, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const taskSets = pgTable(
  "task_sets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    title: text("title").notNull(),
    description: text("description"),
    info: text("info"),
    templateId: uuid("template_id").references((): AnyPgColumn => taskSets.id, { onDelete: "set null" }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("task_sets_company_idx").on(table.companyId),
    companyTemplateIdx: index("task_sets_company_template_idx").on(table.companyId, table.templateId),
  }),
);

export const taskSetMembers = pgTable(
  "task_set_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskSetId: uuid("task_set_id").notNull().references(() => taskSets.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull().default(0),
    templateIssueId: uuid("template_issue_id").references(() => issues.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    setIdx: index("task_set_members_set_idx").on(table.taskSetId),
    issueIdx: index("task_set_members_issue_idx").on(table.issueId),
    setIssueUq: uniqueIndex("task_set_members_set_issue_uq").on(table.taskSetId, table.issueId),
  }),
);
