import { sql } from "drizzle-orm";
import { pgTable, uuid, timestamp, boolean, index, primaryKey, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";

export const issueProjects = pgTable(
  "issue_projects",
  {
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.issueId, table.projectId], name: "issue_projects_pk" }),
    onePrimaryUq: uniqueIndex("issue_projects_one_primary_uq").on(table.issueId).where(sql`${table.isPrimary}`),
    companyProjectIdx: index("issue_projects_company_project_idx").on(table.companyId, table.projectId),
    projectIdx: index("issue_projects_project_idx").on(table.projectId),
    issueIdx: index("issue_projects_issue_idx").on(table.issueId),
  }),
);
