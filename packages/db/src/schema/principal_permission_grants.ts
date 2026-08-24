import { gt, isNull, or, sql, type SQL } from "drizzle-orm";
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
 * drift; `gt` here is the same exclusive boundary.
 *
 * Built from drizzle's typed operators rather than a raw `sql` fragment on
 * purpose. A raw fragment carries no column type, so postgres.js has nothing to
 * encode a `Date` parameter with and throws `ERR_INVALID_ARG_TYPE` when the
 * query runs. Going through `gt` on the column hands the driver the
 * timestamptz encoder.
 */
export function principalGrantNotExpired(now: Date = new Date()): SQL {
  return or(
    isNull(principalPermissionGrants.expiresAt),
    gt(principalPermissionGrants.expiresAt, now),
  )!;
}

/**
 * The lock that serializes everything touching one principal's grants: taken
 * exclusively by every writer, and in shared mode by the cross-issue write
 * fence, which has to stay binding through commit.
 *
 * It is an advisory lock rather than a row lock because no row reliably exists
 * for the identity being serialized. The grant rows are *deleted and
 * reinserted* by a wholesale replacement, so a lock on one orders nothing
 * against the replacement that recycles it. The principal's
 * `company_memberships` row — the previous choice — is not guaranteed to exist
 * either: nothing in this schema ties a grant to a membership, and the revoke
 * path writes without one, so two writers racing on a principal whose
 * membership row was already gone locked nothing at all and serialized nothing
 * (FAI-10144). An advisory key is derived from the identity, so it exists
 * exactly when the identity does.
 *
 * Must run inside a real transaction: `_xact_` releases at commit or rollback,
 * and in autocommit it is released before the statement it was meant to guard.
 */
export function principalGrantLock(
  input: { companyId: string; principalType: string; principalId: string },
  mode: "exclusive" | "shared" = "exclusive",
): SQL {
  const key = `principal_permission_grants:${input.companyId}:${input.principalType}:${input.principalId}`;
  return mode === "shared"
    ? sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`
    : sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}
