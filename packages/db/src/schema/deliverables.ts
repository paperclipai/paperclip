import { pgTable, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";
import { reviewPipelineTemplates } from "./review_pipeline_templates.js";

export const deliverables = pgTable(
  "deliverables",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    description: text("description"),
    type: text("type").notNull().default("mixed"),
    status: text("status").notNull().default("draft"),
    priority: text("priority").notNull().default("medium"),
    currentStageIndex: integer("current_stage_index").notNull().default(0),
    reviewPipelineTemplateId: uuid("review_pipeline_template_id").references(() => reviewPipelineTemplates.id, { onDelete: "set null" }),
    submittedByAgentId: uuid("submitted_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    submittedByUserId: text("submitted_by_user_id"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("idx_deliverables_company_status").on(table.companyId, table.status),
    companyProjectIdx: index("idx_deliverables_company_project").on(table.companyId, table.projectId),
    companyIssueIdx: index("idx_deliverables_company_issue").on(table.companyId, table.issueId),
    submittedByAgentIdx: index("idx_deliverables_submitted_by_agent").on(table.submittedByAgentId),
  }),
);
