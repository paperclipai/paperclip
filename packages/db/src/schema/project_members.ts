import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { projects } from "./projects.js";
import { companies } from "./companies.js";

export const projectMembers = pgTable(
  "project_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => projects.id),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    principalType: text("principal_type").notNull(),
    principalId: text("principal_id").notNull(),
    role: text("role").notNull().default("viewer"),
    addedByUserId: text("added_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectPrincipalUniqueIdx: uniqueIndex("project_members_project_principal_unique_idx").on(
      table.projectId,
      table.principalType,
      table.principalId,
    ),
    companyIdx: index("project_members_company_idx").on(table.companyId),
    principalIdx: index("project_members_principal_idx").on(
      table.principalType,
      table.principalId,
    ),
  }),
);
