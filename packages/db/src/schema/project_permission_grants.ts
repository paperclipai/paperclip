import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { projects } from "./projects.js";
import { companies } from "./companies.js";

export const projectPermissionGrants = pgTable(
  "project_permission_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => projects.id),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    principalType: text("principal_type").notNull(),
    principalId: text("principal_id").notNull(),
    permissionKey: text("permission_key").notNull(),
    grantedByUserId: text("granted_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectPrincipalPermissionUniqueIdx: uniqueIndex(
      "project_permission_grants_unique_idx",
    ).on(table.projectId, table.principalType, table.principalId, table.permissionKey),
    projectPermissionIdx: index("project_permission_grants_project_permission_idx").on(
      table.projectId,
      table.permissionKey,
    ),
    companyIdx: index("project_permission_grants_company_idx").on(table.companyId),
  }),
);
