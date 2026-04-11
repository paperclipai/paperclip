import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issueWorkProducts } from "./issue_work_products.js";
import { issues } from "./issues.js";
import { reviewPipelineTemplates } from "./review-pipeline-templates.js";

export const reviewRuns = pgTable(
  "review_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    workProductId: uuid("work_product_id")
      .notNull()
      .references(() => issueWorkProducts.id),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id),
    pipelineTemplateId: uuid("pipeline_template_id")
      .notNull()
      .references(() => reviewPipelineTemplates.id),
    status: text("status").notNull().default("running"),
    triggeredBy: text("triggered_by").notNull().default("webhook"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("review_runs_company_status_idx").on(
      table.companyId,
      table.status,
    ),
    workProductIdx: index("review_runs_work_product_idx").on(table.workProductId),
    issueIdx: index("review_runs_issue_idx").on(table.issueId),
  }),
);
