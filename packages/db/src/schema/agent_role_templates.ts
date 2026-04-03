import {
  boolean,
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const agentRoleTemplates = pgTable(
  "agent_role_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    role: text("role").notNull(),
    department: text("department"),
    employmentType: text("employment_type").notNull().default("any"),
    title: text("title").notNull(),
    capabilities: text("capabilities"),
    defaultKbPageIds: jsonb("default_kb_page_ids").$type<string[]>().notNull().default([]),
    defaultPermissions: jsonb("default_permissions").$type<Record<string, unknown>>().notNull().default({}),
    systemPromptTemplate: text("system_prompt_template"),
    isSystem: boolean("is_system").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("agent_role_templates_company_idx").on(table.companyId),
  }),
);
