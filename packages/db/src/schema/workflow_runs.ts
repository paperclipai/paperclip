import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { workflows } from "./workflows.js";

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id").notNull().references(() => workflows.id),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    status: text("status").notNull().default("running"),
    triggerData: jsonb("trigger_data").$type<Record<string, unknown>>(),
    variables: jsonb("variables").$type<Record<string, unknown>>().notNull().default({}),
    logs: jsonb("logs").$type<unknown[]>().notNull().default([]),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workflowIdIdx: index("workflow_runs_workflow_id_idx").on(table.workflowId),
    companyStatusIdx: index("workflow_runs_company_status_idx").on(table.companyId, table.status),
    workflowCompanyIdx: index("workflow_runs_workflow_company_idx").on(table.workflowId, table.companyId),
  }),
);
