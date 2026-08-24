import { and, eq, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companyMemberships,
  principalPermissionGrants,
  principalRoleDefaultSeeds,
} from "@paperclipai/db";
import type { HumanCompanyMembershipRole, PermissionKey, PrincipalType } from "@paperclipai/shared";
import { grantsForHumanRole, normalizeHumanRole } from "./company-member-roles.js";

type GrantInput = {
  permissionKey: PermissionKey;
  scope?: Record<string, unknown> | null;
};

export type PrincipalAccessCompatibilityBackfillStats = {
  agentMembershipsInserted: number;
  humanGrantsInserted: number;
};

/**
 * Records that a principal's grant set is now settled at a role, so the
 * bootstrap seeder leaves it alone.
 *
 * Called from two kinds of place, for one reason. The seeder calls it when it
 * has just applied a role's defaults. Every writer that states a principal's
 * grant set — the members UI, the principal-level replacement the invite and
 * plugin flows use, a single permission toggle — calls it too, because a set
 * someone decided on must not be widened afterwards by a background sweep. In
 * both cases the answer is no longer the role's default set, and the seeder's
 * job is done (FAI-10190).
 *
 * The membership standing and role are passed in rather than read here. On the
 * writers they are the state being written, inside the same transaction — the
 * state the marker has to describe — and a read here would see the pre-write
 * row instead.
 *
 * Three states carry no marker.
 *
 * Agent principals: the seeder only ever expands a *human* role, so there is no
 * default set for a marker to bound. Agent grants are written key by key by
 * `built-in-agents` and company import.
 *
 * An absent membership: nothing names a role, and `decidePrincipalGrant`
 * refuses every key behind a principal that is not an active member anyway, so
 * there is no authority to protect.
 *
 * And `archived`, which is the tombstone every removal path leaves. Removal
 * deletes the principal's grants, so there is nothing left to keep; a marker
 * there would mean a re-added principal arrived with no permissions at all
 * instead of their role's defaults. The removal paths delete the marker for the
 * same reason.
 */
export async function settleRoleDefaults(
  tx: Pick<Db, "insert">,
  input: {
    companyId: string;
    principalType: PrincipalType;
    principalId: string;
    membershipStatus: string | null | undefined;
    membershipRole: string | null | undefined;
    settledByUserId: string | null;
  },
): Promise<void> {
  if (input.principalType !== "user") return;
  if (!input.membershipStatus || input.membershipStatus === "archived") return;

  const now = new Date();
  const settled = {
    role: normalizeHumanRole(input.membershipRole, "operator"),
    settledByUserId: input.settledByUserId,
    updatedAt: now,
  };
  await tx
    .insert(principalRoleDefaultSeeds)
    .values({
      companyId: input.companyId,
      principalType: input.principalType,
      principalId: input.principalId,
      createdAt: now,
      ...settled,
    })
    .onConflictDoUpdate({
      target: [
        principalRoleDefaultSeeds.companyId,
        principalRoleDefaultSeeds.principalType,
        principalRoleDefaultSeeds.principalId,
      ],
      set: settled,
    });
}

/**
 * Seeds a principal's role-default grants once, and only once per role.
 *
 * `ON CONFLICT DO NOTHING` made this idempotent against rows that exist when it
 * runs, which is not the same as leaving a decision alone. A default an
 * operator had deliberately revoked is, by definition, missing, so every run
 * put it back: the revocation looked like it took — the row was gone and the UI
 * showed it gone — and then silently reversed at the next server start, the
 * member's next cloud-tenant sync, a `setUserCompanyAccess` call or a company
 * clone (FAI-10190).
 *
 * The marker is what makes the difference representable, because absence in
 * `principal_permission_grants` cannot be: it says "this role's defaults have
 * already been applied", so a missing row afterwards is an answer rather than a
 * gap to fill. Role defaults become a bootstrap, which is what this function's
 * name already claimed.
 *
 * The check and the insert share a transaction so a marker cannot be read
 * before another seeder's grants land and then written as if this run had
 * applied them.
 *
 * `role` is part of the marker, not just the seeding, so a role *change* still
 * propagates: promoted from operator to admin, the principal's settled role no
 * longer matches and the new role's defaults are applied once. What does not
 * propagate is a new permission key added to a role that existing members
 * already hold — see `grantsForHumanRole` in `company-member-roles.ts`.
 */
export async function insertMissingPrincipalGrants(
  db: Db,
  input: {
    companyId: string;
    principalType: PrincipalType;
    principalId: string;
    grants: GrantInput[];
    grantedByUserId: string | null;
    /** The role whose default set `grants` is, recorded so this runs once. */
    role: HumanCompanyMembershipRole;
  },
): Promise<number> {
  return db.transaction(async (tx) => {
    const settledRole = await tx
      .select({ role: principalRoleDefaultSeeds.role })
      .from(principalRoleDefaultSeeds)
      .where(
        and(
          eq(principalRoleDefaultSeeds.companyId, input.companyId),
          eq(principalRoleDefaultSeeds.principalType, input.principalType),
          eq(principalRoleDefaultSeeds.principalId, input.principalId),
        ),
      )
      .then((rows) => rows[0]?.role ?? null);
    if (settledRole === input.role) return 0;

    // Read here rather than taken from the caller: the marker this run is about
    // to write has to describe the standing the grants land against, and every
    // caller establishes the membership on a separate handle before this
    // transaction opens.
    const membershipStatus = await tx
      .select({ status: companyMemberships.status })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, input.companyId),
          eq(companyMemberships.principalType, input.principalType),
          eq(companyMemberships.principalId, input.principalId),
        ),
      )
      .then((rows) => rows[0]?.status ?? null);

    const now = new Date();
    // A role with no defaults — `viewer` — still gets a marker. Nothing is
    // inserted, but "settled as a viewer" and "never seeded" have to stay
    // distinguishable, or the audit reading of a missing grant loses its
    // baseline.
    const inserted = input.grants.length === 0 ? [] : await tx
      .insert(principalPermissionGrants)
      .values(
        input.grants.map((grant) => ({
          companyId: input.companyId,
          principalType: input.principalType,
          principalId: input.principalId,
          permissionKey: grant.permissionKey,
          scope: grant.scope ?? null,
          grantedByUserId: input.grantedByUserId,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .onConflictDoNothing({
        target: [
          principalPermissionGrants.companyId,
          principalPermissionGrants.principalType,
          principalPermissionGrants.principalId,
          principalPermissionGrants.permissionKey,
        ],
      })
      .returning({ id: principalPermissionGrants.id });

    await settleRoleDefaults(tx, {
      companyId: input.companyId,
      principalType: input.principalType,
      principalId: input.principalId,
      membershipStatus,
      membershipRole: input.role,
      settledByUserId: input.grantedByUserId,
    });

    return inserted.length;
  });
}

export async function ensureHumanRoleDefaultGrants(
  db: Db,
  input: {
    companyId: string;
    principalId: string;
    membershipRole: string | null | undefined;
    grantedByUserId: string | null;
  },
): Promise<number> {
  const role = normalizeHumanRole(input.membershipRole, "operator");
  return insertMissingPrincipalGrants(db, {
    companyId: input.companyId,
    principalType: "user",
    principalId: input.principalId,
    grants: grantsForHumanRole(role),
    grantedByUserId: input.grantedByUserId,
    role,
  });
}

export async function backfillPrincipalAccessCompatibility(
  db: Db,
): Promise<PrincipalAccessCompatibilityBackfillStats> {
  const now = new Date();
  const nonTerminalAgents = await db
    .select({
      companyId: agents.companyId,
      principalId: agents.id,
    })
    .from(agents)
    .where(notInArray(agents.status, ["pending_approval", "terminated"]));

  const agentMembershipsInserted = nonTerminalAgents.length > 0
    ? await db
      .insert(companyMemberships)
      .values(
        nonTerminalAgents.map((agent) => ({
          companyId: agent.companyId,
          principalType: "agent",
          principalId: agent.principalId,
          status: "active",
          membershipRole: "member",
          createdAt: now,
          updatedAt: now,
        })),
      )
      .onConflictDoNothing({
        target: [
          companyMemberships.companyId,
          companyMemberships.principalType,
          companyMemberships.principalId,
        ],
      })
      .returning({ id: companyMemberships.id })
      .then((rows) => rows.length)
    : 0;

  const activeHumanMemberships = await db
    .select({
      companyId: companyMemberships.companyId,
      principalId: companyMemberships.principalId,
      membershipRole: companyMemberships.membershipRole,
    })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.status, "active"),
      ),
    );

  let humanGrantsInserted = 0;
  for (const membership of activeHumanMemberships) {
    humanGrantsInserted += await ensureHumanRoleDefaultGrants(db, {
      companyId: membership.companyId,
      principalId: membership.principalId,
      membershipRole: membership.membershipRole,
      grantedByUserId: null,
    });
  }

  return {
    agentMembershipsInserted,
    humanGrantsInserted,
  };
}
