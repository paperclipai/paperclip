import { and, eq, inArray, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companyMemberships, principalPermissionGrants } from "@paperclipai/db";
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

  // Read before writing. Cloud tenant authentication re-seeds role defaults
  // on every sync, and the grants almost always exist already. An INSERT ...
  // ON CONFLICT still waits on another transaction that is deleting or
  // re-inserting a conflicting row, which stalled authentication until the
  // statement timeout. A plain read never waits on row locks.
  const existing = await db
    .select({ permissionKey: principalPermissionGrants.permissionKey })
    .from(principalPermissionGrants)
    .where(
      and(
        eq(principalPermissionGrants.companyId, input.companyId),
        eq(principalPermissionGrants.principalType, input.principalType),
        eq(principalPermissionGrants.principalId, input.principalId),
        inArray(
          principalPermissionGrants.permissionKey,
          input.grants.map((grant) => grant.permissionKey),
        ),
      ),
    );
  const existingKeys = new Set(existing.map((row) => row.permissionKey));
  const missing = input.grants.filter((grant) => !existingKeys.has(grant.permissionKey));
  if (missing.length === 0) return 0;

  const now = new Date();
  const inserted = await db
    .insert(principalPermissionGrants)
    .values(
      missing.map((grant) => ({
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
