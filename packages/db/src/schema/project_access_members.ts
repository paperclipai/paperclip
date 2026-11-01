import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

/** Authorization membership for private projects; unrelated to sidebar project_memberships. */
export const projectAccessMembers = pgTable(
  "project_access_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    subjectTypeCheck: check(
      "project_access_members_subject_type_check",
      sql`${table.subjectType} in ('user', 'agent')`,
    ),
    projectSubjectUq: uniqueIndex("project_access_members_project_subject_uq").on(
      table.projectId,
      table.subjectType,
      table.subjectId,
    ),
    subjectLookupIdx: index("project_access_members_subject_lookup_idx").on(
      table.companyId,
      table.subjectType,
      table.subjectId,
      table.projectId,
    ),
  }),
);
