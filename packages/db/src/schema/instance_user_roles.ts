import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";

export const instanceUserRoles = pgTable(
  "instance_user_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    role: text("role").notNull().default("instance_admin"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userRoleUniqueIdx: uniqueIndex("instance_user_roles_user_role_unique_idx").on(table.userId, table.role),
    roleIdx: index("instance_user_roles_role_idx").on(table.role),
  }),
);
