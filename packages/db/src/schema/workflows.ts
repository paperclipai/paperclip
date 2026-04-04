import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, integer } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const workflows = pgTable(
  "workflows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    definitionYaml: text("definition_yaml").notNull(),
    definitionCompiled: jsonb("definition_compiled").$type<Record<string, unknown>>(),
    assigneeAgentId: uuid("assignee_agent_id").references(() => agents.id, { onDelete: "set null" }),
    status: text("status").notNull().default("draft"),
    version: integer("version").notNull().default(1),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    updatedByAgentId: uuid("updated_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySlugUq: uniqueIndex("workflows_company_slug_uq").on(table.companyId, table.slug),
    companyStatusIdx: index("workflows_company_status_idx").on(table.companyId, table.status),
  }),
);

export const workflowRevisions = pgTable(
  "workflow_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    definitionYaml: text("definition_yaml").notNull(),
    definitionCompiled: jsonb("definition_compiled").$type<Record<string, unknown>>(),
    changeSummary: text("change_summary"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workflowVersionUq: uniqueIndex("workflow_revisions_workflow_version_uq").on(table.workflowId, table.version),
    workflowCreatedIdx: index("workflow_revisions_workflow_created_idx").on(table.workflowId, table.createdAt),
  }),
);
