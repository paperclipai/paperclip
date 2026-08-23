import { sql, type SQL } from "drizzle-orm";
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
    /**
     * When the grant stops conferring anything. Null means no expiry, which is
     * what every grant written before FAI-10144 carries, so existing behaviour
     * is unchanged. An expired row is left in place rather than swept: it is the
     * record that the authority existed and when it lapsed, and a sweeper would
     * make "denied because it expired" indistinguishable from "never granted".
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueGrantIdx: uniqueIndex("principal_permission_grants_unique_idx").on(
      table.companyId,
      table.principalType,
      table.principalId,
      table.permissionKey,
    ),
    companyPermissionIdx: index("principal_permission_grants_company_permission_idx").on(
      table.companyId,
      table.permissionKey,
    ),
  }),
);

/**
 * The one place expiry is defined, so every reader agrees on the boundary.
 *
 * Expiry is exclusive at the instant itself — `expiresAt` is when the grant
 * stops conferring, so a grant whose `expiresAt` equals `now` is already
 * expired. That matters because `assertCrossIssueWriteFence` re-evaluates this
 * against the wall clock inside the persistence transaction, and a boundary
 * that allowed the exact instant would let a write land on a lapsed grant.
 */
export function principalGrantIsActive(
  grant: { expiresAt: Date | null },
  now: Date = new Date(),
): boolean {
  return grant.expiresAt === null || grant.expiresAt > now;
}

/**
 * The same rule as a SQL predicate, for readers that filter in the query
 * instead of in JS. Kept beside `principalGrantIsActive` so the two cannot
 * drift; `>` here is the same exclusive boundary.
 */
export function principalGrantNotExpired(now: Date = new Date()): SQL {
  return sql`(${principalPermissionGrants.expiresAt} is null or ${principalPermissionGrants.expiresAt} > ${now})`;
}
