import { pgTable, uuid, text, jsonb, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import type { PermissionScope } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { companyRoles } from "./company_roles.js";

export const principalRoleAssignments = pgTable(
  "principal_role_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    roleId: uuid("role_id").notNull().references(() => companyRoles.id, { onDelete: "cascade" }),
    principalType: text("principal_type").notNull(),
    principalId: text("principal_id").notNull(),
    scope: jsonb("scope").$type<PermissionScope>(),
    assignedByUserId: text("assigned_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyRolePrincipalUq: uniqueIndex("principal_role_assignments_company_role_principal_uq").on(
      table.companyId,
      table.roleId,
      table.principalType,
      table.principalId,
    ),
    companyPrincipalIdx: index("principal_role_assignments_company_principal_idx").on(
      table.companyId,
      table.principalType,
      table.principalId,
    ),
    companyRoleIdx: index("principal_role_assignments_company_role_idx").on(table.companyId, table.roleId),
  }),
);
