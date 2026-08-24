import { and, eq, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companyMemberships, principalGrantLock, principalPermissionGrants } from "@paperclipai/db";
import type { PermissionKey, PrincipalType } from "@paperclipai/shared";
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
 * Seeds a principal's role-default grants, skipping any that already exist.
 *
 * This is a writer of `principal_permission_grants`, so it takes the same
 * per-principal advisory lock every other writer takes. `ON CONFLICT DO
 * NOTHING` makes it idempotent against rows that exist *when it runs*, which is
 * not the same as safe against a concurrent revocation: unlocked, an operator's
 * delete can commit and this insert can then land after it, putting back a
 * default grant the operator had just removed. The seeder runs when company
 * access is granted, on company clone, and once at startup over every active
 * human membership, so the window is real (FAI-10144, Greptile P1 at
 * `9ec80cd9c`).
 *
 * The lock is `_xact_`-scoped, so the insert has to sit inside a transaction
 * for the lock to still be held when it runs.
 *
 * It does not write `expires_at`, and that is what lets it stay an insert-only
 * seeder: a row that already exists is skipped outright, so a re-seed can never
 * un-time-box a grant an operator deliberately bounded.
 */
export async function insertMissingPrincipalGrants(
  db: Db,
  input: {
    companyId: string;
    principalType: PrincipalType;
    principalId: string;
    grants: GrantInput[];
    grantedByUserId: string | null;
  },
): Promise<number> {
  if (input.grants.length === 0) return 0;

  const now = new Date();
  return db.transaction(async (tx) => {
    await tx.execute(principalGrantLock(input));
    const inserted = await tx
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
