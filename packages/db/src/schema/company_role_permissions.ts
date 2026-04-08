import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companyRoles } from "./company_roles.js";

export const companyRolePermissions = pgTable(
  "company_role_permissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roleId: uuid("role_id").notNull().references(() => companyRoles.id, { onDelete: "cascade" }),
    permissionKey: text("permission_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    rolePermissionUq: uniqueIndex("company_role_permissions_role_permission_uq").on(
      table.roleId,
      table.permissionKey,
    ),
    permissionIdx: index("company_role_permissions_permission_idx").on(table.permissionKey),
  }),
);
