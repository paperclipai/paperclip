import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

export const projectMemberships = pgTable(
  "project_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    state: text("state").notNull().default("joined"),
    starredAt: timestamp("starred_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUserIdx: index("project_memberships_company_user_idx").on(table.companyId, table.userId),
    companyUserStarredIdx: index("project_memberships_company_user_starred_idx").on(
      table.companyId,
      table.userId,
      table.starredAt,
    ),
    projectIdx: index("project_memberships_project_idx").on(table.projectId),
    companyUserProjectUq: uniqueIndex("project_memberships_company_user_project_uq").on(
      table.companyId,
      table.userId,
      table.projectId,
    ),
  }),
);
