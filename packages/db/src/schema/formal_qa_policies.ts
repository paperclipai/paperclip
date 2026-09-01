import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { projects } from "./projects.js";
import { projectWorkspaces } from "./project_workspaces.js";

/**
 * A company administrator's versioned allow-list for Formal-QA issuance.
 *
 * This deliberately lives outside a caller-supplied issue, routine, or
 * workspace document. A board request may select a PR number only; the
 * server reads every security-relevant value below from this record.
 */
export const formalQaPolicies = pgTable(
  "formal_qa_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    projectWorkspaceId: uuid("project_workspace_id")
      .notNull()
      .references(() => projectWorkspaces.id, { onDelete: "cascade" }),
    reviewerAgentId: uuid("reviewer_agent_id").notNull().references(() => agents.id),
    repository: text("repository").notNull(),
    requiredWorkflowId: text("required_workflow_id").notNull(),
    requiredCheckName: text("required_check_name").notNull(),
    requiredCheckAppId: integer("required_check_app_id").notNull(),
    version: integer("version").notNull().default(1),
    enabled: boolean("enabled").notNull().default(false),
    createdByUserId: text("created_by_user_id").notNull(),
    updatedByUserId: text("updated_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceUq: uniqueIndex("formal_qa_policies_workspace_uq").on(table.projectWorkspaceId),
    companyProjectIdx: index("formal_qa_policies_company_project_idx")
      .on(table.companyId, table.projectId),
  }),
);
