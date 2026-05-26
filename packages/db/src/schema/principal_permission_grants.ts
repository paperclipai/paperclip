import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const principalPermissionGrants = pgTable(
  "principal_permission_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    principalType: text("principal_type").notNull(),
    principalId: text("principal_id").notNull(),
    permissionKey: text("permission_key").notNull(),
    scope: jsonb("scope").$type<Record<string, unknown> | null>(),
    grantedByUserId: text("granted_by_user_id"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: text("revoked_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Active-only unique index. Tombstones (revoked_at IS NOT NULL) are
    // preserved indefinitely as audit history and do NOT block re-grants —
    // a fresh grant for the same (company, principal, key) just inserts a
    // new active row alongside any existing tombstones.
    uniqueGrantIdx: uniqueIndex("principal_permission_grants_active_unique_idx")
      .on(table.companyId, table.principalType, table.principalId, table.permissionKey)
      .where(sql`${table.revokedAt} IS NULL`),
    companyPermissionIdx: index("principal_permission_grants_company_permission_idx").on(
      table.companyId,
      table.permissionKey,
    ),
  }),
);
