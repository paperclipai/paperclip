import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

export const hiringRequests = pgTable(
  "hiring_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    approvalId: uuid("approval_id"),
    requestedByAgentId: uuid("requested_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    requestedByUserId: text("requested_by_user_id"),
    employmentType: text("employment_type").notNull().default("full_time"),
    role: text("role").notNull(),
    title: text("title").notNull(),
    department: text("department"),
    justification: text("justification"),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    contractDurationDays: integer("contract_duration_days"),
    contractBudgetCents: integer("contract_budget_cents"),
    onboardingKbPageIds: jsonb("onboarding_kb_page_ids").$type<string[]>().notNull().default([]),
    reportsToAgentId: uuid("reports_to_agent_id").references(() => agents.id, { onDelete: "set null" }),
    status: text("status").notNull().default("draft"),
    fulfilledAgentId: uuid("fulfilled_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("hiring_requests_company_status_idx").on(table.companyId, table.status),
  }),
);
