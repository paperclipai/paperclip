import { and, eq, inArray } from "drizzle-orm";
import {
  companyMemberships,
  instanceUserRoles,
  principalPermissionGrants,
  type Db,
} from "@paperclipai/db";
import type {
  BoardApiKeyScopeConfig,
  BoardPermissionKey,
  PermissionKey,
} from "@paperclipai/shared";

export function isBoardKeyWriteAction(action: BoardPermissionKey) {
  return /:(?:write|manage|control|operate|run|decide|create|import_export)$/.test(action);
}

type OwnerAuthorityRequirement =
  | { kind: "membership" }
  | { kind: "grants"; permissionKeys: readonly PermissionKey[] };

const membershipAuthority = { kind: "membership" } as const;
const grantAuthority = (...permissionKeys: PermissionKey[]) => ({
  kind: "grants" as const,
  permissionKeys,
});

const OWNER_AUTHORITY_REQUIREMENTS = {
  "companies:read": membershipAuthority,
  "companies:write": membershipAuthority,
  "agents:read": membershipAuthority,
  "agents:write": grantAuthority("agents:create", "agents:configure"),
  "agents:operate": grantAuthority("agents:configure"),
  "projects:read": membershipAuthority,
  "projects:write": membershipAuthority,
  "issues:read": membershipAuthority,
  "issues:write": grantAuthority("tasks:assign"),
  "issues:control": grantAuthority("tasks:assign", "tasks:manage_active_checkouts"),
  "goals:read": membershipAuthority,
  "goals:write": membershipAuthority,
  "routines:read": membershipAuthority,
  "routines:write": membershipAuthority,
  "routines:run": membershipAuthority,
  "approvals:read": membershipAuthority,
  "approvals:write": membershipAuthority,
  "approvals:decide": membershipAuthority,
  "costs:read": membershipAuthority,
  "costs:write": membershipAuthority,
  "activity:read": membershipAuthority,
  "artifacts:read": membershipAuthority,
  "artifacts:write": membershipAuthority,
  "workspaces:read": membershipAuthority,
  "workspaces:manage": membershipAuthority,
  "skills:read": membershipAuthority,
  "skills:manage": grantAuthority("skills:create"),
  "tools:read": membershipAuthority,
  "tools:manage": grantAuthority("tools:admin"),
  "secrets:read_metadata": membershipAuthority,
  "secrets:manage": membershipAuthority,
  "members:read": membershipAuthority,
  "members:manage": grantAuthority("users:invite", "users:manage_permissions", "joins:approve"),
  "decisions:read": membershipAuthority,
  "decisions:write": membershipAuthority,
  "settings:read": membershipAuthority,
  "settings:write": membershipAuthority,
  "environments:read": membershipAuthority,
  "environments:manage": grantAuthority("environments:manage"),
  "pipelines:read": membershipAuthority,
  "pipelines:write": grantAuthority("pipelines:write"),
  "search:read": membershipAuthority,
  "runtime:read": membershipAuthority,
  "runtime:manage": membershipAuthority,
  "audit:read": grantAuthority("audit:view_agent_actions"),
  "instance:read": membershipAuthority,
  "instance:manage": membershipAuthority,
  "companies:create": membershipAuthority,
  "companies:import_export": membershipAuthority,
  "plugins:read": membershipAuthority,
  "plugins:manage": membershipAuthority,
  "adapters:read": membershipAuthority,
  "adapters:manage": membershipAuthority,
  "users:read": membershipAuthority,
  "users:manage": membershipAuthority,
  "catalogs:read": membershipAuthority,
  "catalogs:manage": membershipAuthority,
  "backups:create": membershipAuthority,
  "board_api_keys:revoke_self": membershipAuthority,
} satisfies Record<BoardPermissionKey, OwnerAuthorityRequirement>;

export async function ownerHasRequiredGrant(
  db: Db,
  ownerUserId: string,
  companyIds: readonly string[],
  action: BoardPermissionKey,
) {
  const requirement = OWNER_AUTHORITY_REQUIREMENTS[action];
  if (requirement.kind === "membership") return true;
  const { permissionKeys } = requirement;
  const rows = await db
    .select({
      companyId: principalPermissionGrants.companyId,
      permissionKey: principalPermissionGrants.permissionKey,
    })
    .from(principalPermissionGrants)
    .where(and(
      inArray(principalPermissionGrants.companyId, [...companyIds]),
      eq(principalPermissionGrants.principalType, "user"),
      eq(principalPermissionGrants.principalId, ownerUserId),
      inArray(principalPermissionGrants.permissionKey, [...permissionKeys]),
    ));
  const liveKeysByCompany = new Map<string, Set<string>>();
  for (const row of rows) {
    const liveKeys = liveKeysByCompany.get(row.companyId) ?? new Set<string>();
    liveKeys.add(row.permissionKey);
    liveKeysByCompany.set(row.companyId, liveKeys);
  }
  return companyIds.every((companyId) => {
    const liveKeys = liveKeysByCompany.get(companyId);
    return permissionKeys.every((permissionKey) => liveKeys?.has(permissionKey));
  });
}

export type BoardKeyScopeAuthorityViolation =
  | "instance_admin_required"
  | "company_access_missing"
  | "owner_role_read_only"
  | "owner_permission_grant_missing";

export async function validateBoardKeyScopeOwnerAuthority(
  db: Db,
  ownerUserId: string,
  scope: BoardApiKeyScopeConfig,
): Promise<BoardKeyScopeAuthorityViolation | null> {
  const [adminRole, memberships] = await Promise.all([
    db
      .select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, ownerUserId), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows) => rows[0] ?? null),
    db
      .select({
        companyId: companyMemberships.companyId,
        membershipRole: companyMemberships.membershipRole,
      })
      .from(companyMemberships)
      .where(and(
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, ownerUserId),
        eq(companyMemberships.status, "active"),
        inArray(companyMemberships.companyId, scope.companyIds),
      )),
  ]);

  if (scope.instanceCapabilities.length > 0 && !adminRole) return "instance_admin_required";

  const membershipByCompany = new Map(memberships.map((row) => [row.companyId, row]));
  if (scope.companyIds.some((companyId) => !membershipByCompany.has(companyId))) {
    return "company_access_missing";
  }
  if (
    scope.permissions.some(isBoardKeyWriteAction)
    && scope.companyIds.some((companyId) => membershipByCompany.get(companyId)?.membershipRole === "viewer")
  ) {
    return "owner_role_read_only";
  }

  for (const permission of scope.permissions) {
    if (!await ownerHasRequiredGrant(db, ownerUserId, scope.companyIds, permission)) {
      return "owner_permission_grant_missing";
    }
  }
  return null;
}
