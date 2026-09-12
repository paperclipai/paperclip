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
  | { kind: "membership"; roles: readonly string[] }
  | { kind: "instance_admin" }
  | { kind: "grants"; permissionKeys: readonly PermissionKey[] };

const readMembershipAuthority = {
  kind: "membership",
  roles: ["owner", "admin", "operator", "member", "viewer"],
} as const;
const administrativeMembershipAuthority = {
  kind: "membership",
  roles: ["owner", "admin"],
} as const;
const instanceAdminAuthority = { kind: "instance_admin" } as const;
const grantAuthority = (...permissionKeys: PermissionKey[]) => ({
  kind: "grants" as const,
  permissionKeys,
});

const OWNER_AUTHORITY_REQUIREMENTS = {
  "companies:read": readMembershipAuthority,
  "companies:write": administrativeMembershipAuthority,
  "agents:read": readMembershipAuthority,
  "agents:write": grantAuthority("agents:create", "agents:configure"),
  "agents:operate": grantAuthority("agents:configure"),
  "projects:read": readMembershipAuthority,
  "projects:write": administrativeMembershipAuthority,
  "issues:read": readMembershipAuthority,
  "issues:write": grantAuthority("tasks:assign"),
  "issues:control": grantAuthority("tasks:assign", "tasks:manage_active_checkouts"),
  "goals:read": readMembershipAuthority,
  "goals:write": administrativeMembershipAuthority,
  "routines:read": readMembershipAuthority,
  "routines:write": administrativeMembershipAuthority,
  "routines:run": administrativeMembershipAuthority,
  "approvals:read": readMembershipAuthority,
  "approvals:write": administrativeMembershipAuthority,
  "approvals:decide": administrativeMembershipAuthority,
  "costs:read": readMembershipAuthority,
  "costs:write": administrativeMembershipAuthority,
  "activity:read": readMembershipAuthority,
  "artifacts:read": readMembershipAuthority,
  "artifacts:write": administrativeMembershipAuthority,
  "workspaces:read": readMembershipAuthority,
  "workspaces:manage": administrativeMembershipAuthority,
  "skills:read": readMembershipAuthority,
  "skills:manage": grantAuthority("skills:create"),
  "tools:read": readMembershipAuthority,
  "tools:manage": grantAuthority("tools:admin"),
  "secrets:read_metadata": readMembershipAuthority,
  "secrets:manage": administrativeMembershipAuthority,
  "members:read": readMembershipAuthority,
  "members:manage": grantAuthority("users:invite", "users:manage_permissions", "joins:approve"),
  "decisions:read": readMembershipAuthority,
  "decisions:write": administrativeMembershipAuthority,
  "settings:read": readMembershipAuthority,
  "settings:write": administrativeMembershipAuthority,
  "environments:read": readMembershipAuthority,
  "environments:manage": grantAuthority("environments:manage"),
  "pipelines:read": readMembershipAuthority,
  "pipelines:write": grantAuthority("pipelines:write"),
  "search:read": readMembershipAuthority,
  "runtime:read": readMembershipAuthority,
  "runtime:manage": administrativeMembershipAuthority,
  "audit:read": grantAuthority("audit:view_agent_actions"),
  "instance:read": instanceAdminAuthority,
  "instance:manage": instanceAdminAuthority,
  "companies:create": instanceAdminAuthority,
  "companies:import_export": instanceAdminAuthority,
  "plugins:read": instanceAdminAuthority,
  "plugins:manage": instanceAdminAuthority,
  "adapters:read": instanceAdminAuthority,
  "adapters:manage": instanceAdminAuthority,
  "users:read": instanceAdminAuthority,
  "users:manage": instanceAdminAuthority,
  "catalogs:read": instanceAdminAuthority,
  "catalogs:manage": instanceAdminAuthority,
  "backups:create": instanceAdminAuthority,
  "board_api_keys:revoke_self": readMembershipAuthority,
} satisfies Record<BoardPermissionKey, OwnerAuthorityRequirement>;

export async function ownerHasRequiredGrant(
  db: Db,
  ownerUserId: string,
  companyIds: readonly string[],
  action: BoardPermissionKey,
) {
  const requirement = OWNER_AUTHORITY_REQUIREMENTS[action];
  if (requirement.kind === "instance_admin") {
    const row = await db
      .select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, ownerUserId), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows) => rows[0] ?? null);
    return row !== null;
  }
  if (requirement.kind === "membership") {
    const rows = await db
      .select({
        companyId: companyMemberships.companyId,
        membershipRole: companyMemberships.membershipRole,
      })
      .from(companyMemberships)
      .where(and(
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, ownerUserId),
        eq(companyMemberships.status, "active"),
        inArray(companyMemberships.companyId, [...companyIds]),
      ));
    const rolesByCompany = new Map(rows.map((row) => [row.companyId, row.membershipRole]));
    return companyIds.every((companyId) => {
      const role = rolesByCompany.get(companyId);
      return typeof role === "string" && requirement.roles.some((allowedRole) => allowedRole === role);
    });
  }
  const { permissionKeys } = requirement;
  const memberships = await db
    .select({
      companyId: companyMemberships.companyId,
      membershipRole: companyMemberships.membershipRole,
    })
    .from(companyMemberships)
    .where(and(
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, ownerUserId),
      eq(companyMemberships.status, "active"),
      inArray(companyMemberships.companyId, [...companyIds]),
    ));
  const membershipRoleByCompany = new Map(
    memberships.map((membership) => [membership.companyId, membership.membershipRole]),
  );
  if (companyIds.some((companyId) => !membershipRoleByCompany.has(companyId))) return false;

  const rows = await db
    .select({
      companyId: principalPermissionGrants.companyId,
      permissionKey: principalPermissionGrants.permissionKey,
      grantOrigin: principalPermissionGrants.grantOrigin,
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
