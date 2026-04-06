import { pgTable, uuid, timestamp, index } from "drizzle-orm/pg-core";
import { projects } from "./projects.js";
import { companies } from "./companies.js";
import { reviewPipelineTemplates } from "./review_pipeline_templates.js";

export const projectReviewDefaults = pgTable(
  "project_review_defaults",
  {
    projectId: uuid("project_id").primaryKey().references(() => projects.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    reviewPipelineTemplateId: uuid("review_pipeline_template_id").notNull().references(() => reviewPipelineTemplates.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("idx_project_review_defaults_company").on(table.companyId),
  }),
);
