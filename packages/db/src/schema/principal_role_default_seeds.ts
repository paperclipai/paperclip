import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * One row per principal whose role defaults have already been applied.
 *
 * `principal_permission_grants` has no way to say "this role default was
 * deliberately revoked": absence is the only representation, and absence is
 * exactly what the role-default seeder is built to fill. So a revocation looked
 * like it took — the row was gone and the UI showed it gone — and the next
 * server start, cloud-tenant sync, `setUserCompanyAccess` or company clone put
 * it straight back (FAI-10190).
 *
 * This marker turns the seeder from seed-every-run into seed-once, which is
 * what its name already claimed. Role defaults become a bootstrap: they are
 * applied when a principal first holds a role, and after that the principal's
 * grant set is whatever an operator has made it.
 *
 * A row here is not "the defaults were inserted" but "the defaults for this
 * role are settled" — either the seeder applied them, or an operator wrote the
 * principal's grant set explicitly and that set is now the answer. Both bar the
 * seeder, and for the same reason: a grant set someone decided on must not be
 * widened by a background sweep.
 *
 * `role` is what makes the difference legible after the fact, which is the
 * audit half of the fix. Given the seeded role, a reader takes that role's
 * default set and subtracts the principal's live grants: what is left was
 * deliberately revoked. A key outside that set was never carried in the first
 * place. Without the role recorded the two are indistinguishable, because both
 * are just a missing row.
 *
 * Keyed on the principal's identity rather than on `company_memberships.id`,
 * and with no foreign key to it, for the same reason the grants themselves are:
 * nothing ties a grant to a membership row, and the membership row is not
 * guaranteed to exist when a grant is written. Every removal path that deletes
 * a principal's grants deletes this row alongside them, so a re-added principal
 * is bootstrapped again rather than arriving with nothing.
 *
 * Only human principals ever get a row. Agent grants come from
 * `built-in-agents` and company import, which write each permission
 * deliberately rather than expanding a role.
 */
export const principalRoleDefaultSeeds = pgTable(
  "principal_role_default_seeds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * Cascades, unlike `principal_permission_grants`. A marker is bookkeeping
     * about a company that no longer exists — there is no authority in it to
     * audit, and nothing else to do with the row but drop it.
     */
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    principalType: text("principal_type").notNull(),
    principalId: text("principal_id").notNull(),
    /** The human role whose default set is settled, already normalized. */
    role: text("role").notNull(),
    /** Null when the bootstrap seeder settled it rather than a named operator. */
    settledByUserId: text("settled_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniquePrincipalIdx: uniqueIndex("principal_role_default_seeds_unique_idx").on(
      table.companyId,
      table.principalType,
      table.principalId,
    ),
  }),
);
