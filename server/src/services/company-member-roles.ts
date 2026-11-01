import {
  HUMAN_COMPANY_MEMBERSHIP_ROLES,
  LEAST_PRIVILEGED_HUMAN_COMPANY_MEMBERSHIP_ROLE,
  PERMISSION_KEYS,
} from "@paperclipai/shared";
import type { HumanCompanyMembershipRole } from "@paperclipai/shared";

/**
 * NOTE: the role list is imported from `@paperclipai/shared` on purpose. It
 * used to be re-declared here, which meant adding a role to the shared
 * constant did not reach the check below: the new role stayed "unrecognized"
 * and normalized to the `fallback`, historically `operator`. Any future role
 * must be recognized by this module the moment it is added to the shared list.
 */
export function isHumanCompanyMembershipRole(
  value: unknown,
): value is HumanCompanyMembershipRole {
  return (HUMAN_COMPANY_MEMBERSHIP_ROLES as readonly string[]).includes(value as string);
}

export function normalizeHumanRole(
  value: unknown,
  fallback: HumanCompanyMembershipRole = "operator"
): HumanCompanyMembershipRole {
  if (value === "member") return "operator";
  return isHumanCompanyMembershipRole(value) ? value : fallback;
}

export type MembershipRoleSummary = {
  companyId: string;
  membershipRole?: string | null;
  status?: string;
};

export function isClientMembershipRole(role: string | null | undefined): boolean {
  return role === "client";
}

function isActiveMembership(membership: MembershipRoleSummary): boolean {
  return membership.status === undefined || membership.status === "active";
}

/**
 * The actor's membership role in one company, or null when there is no active
 * membership to read. Shared so that company-scope decisions made outside
 * `routes/authz.ts` cannot drift from the ones made inside it.
 */
export function activeMembershipRoleFor(
  memberships: MembershipRoleSummary[] | undefined,
  companyId: string,
): string | null {
  if (!Array.isArray(memberships)) return null;
  const membership = memberships.find((item) => item.companyId === companyId);
  if (!membership || !isActiveMembership(membership)) return null;
  return membership.membershipRole ?? null;
}

export function hasClientMembershipFor(
  memberships: MembershipRoleSummary[] | undefined,
  companyId: string,
): boolean {
  return isClientMembershipRole(activeMembershipRoleFor(memberships, companyId));
}

/**
 * True when at least one active membership is a staff membership. Used by the
 * org-level gate: a principal whose only memberships are `client` memberships
 * is not staff anywhere and has no org surface.
 *
 * Absent or empty membership data returns true, which preserves the historical
 * behavior of gating purely on a non-empty company list rather than denying an
 * actor we cannot classify.
 */
/**
 * Narrow a company-id scope to the companies where the actor is staff.
 *
 * For list/scope decisions that are company-scoped but do not run through
 * `assertCompanyAccess` -- "which companies may this actor read rows for" --
 * this drops the companies where the actor is only a client.
 */
export function filterStaffCompanyIds(
  companyIds: string[] | undefined,
  memberships: MembershipRoleSummary[] | undefined,
): string[] {
  const ids = Array.isArray(companyIds) ? companyIds : [];
  if (!Array.isArray(memberships)) return ids;
  return ids.filter((companyId) => !hasClientMembershipFor(memberships, companyId));
}

export function hasActiveStaffMembership(
  memberships: MembershipRoleSummary[] | undefined,
): boolean {
  if (!Array.isArray(memberships)) return true;
  const active = memberships.filter(isActiveMembership);
  if (active.length === 0) return true;
  return active.some((item) => !isClientMembershipRole(item.membershipRole));
}

export function grantsForHumanRole(
  role: HumanCompanyMembershipRole
): Array<{
  permissionKey: (typeof PERMISSION_KEYS)[number];
  scope: Record<string, unknown> | null;
}> {
  switch (role) {
    case "owner":
      return [
        { permissionKey: "agents:create", scope: null },
        { permissionKey: "agents:configure", scope: null },
        { permissionKey: "skills:create", scope: null },
        { permissionKey: "environments:manage", scope: null },
        { permissionKey: "users:invite", scope: null },
        { permissionKey: "users:manage_permissions", scope: null },
        { permissionKey: "tasks:assign", scope: null },
        { permissionKey: "joins:approve", scope: null },
        { permissionKey: "tools:manage_connections", scope: null },
        { permissionKey: "tools:manage_runtime", scope: null },
        { permissionKey: "tools:use", scope: null },
        { permissionKey: "tools:admin", scope: null },
        { permissionKey: "commentary:view", scope: null },
      ];
    case "admin":
      return [
        { permissionKey: "agents:create", scope: null },
        { permissionKey: "agents:configure", scope: null },
        { permissionKey: "skills:create", scope: null },
        { permissionKey: "environments:manage", scope: null },
        { permissionKey: "users:invite", scope: null },
        { permissionKey: "tasks:assign", scope: null },
        { permissionKey: "joins:approve", scope: null },
        { permissionKey: "tools:manage_connections", scope: null },
        { permissionKey: "tools:manage_runtime", scope: null },
        { permissionKey: "tools:use", scope: null },
        { permissionKey: "tools:admin", scope: null },
        { permissionKey: "commentary:view", scope: null },
      ];
    case "operator":
      return [
        { permissionKey: "agents:create", scope: null },
        { permissionKey: "agents:configure", scope: null },
        { permissionKey: "skills:create", scope: null },
        { permissionKey: "environments:manage", scope: null },
        { permissionKey: "users:invite", scope: null },
        { permissionKey: "tasks:assign", scope: null },
        { permissionKey: "tools:manage_connections", scope: null },
        { permissionKey: "tools:manage_profiles", scope: null },
        { permissionKey: "tools:manage_runtime", scope: null },
        { permissionKey: "tools:use", scope: null },
        { permissionKey: "tools:admin", scope: null },
        { permissionKey: "tools:view_audit", scope: null },
        { permissionKey: "audit:view_agent_actions", scope: null },
        { permissionKey: "commentary:view", scope: null },
      ];
    case "viewer":
      return [{ permissionKey: "commentary:view", scope: null }];
    case "client":
      // A client has no default authority whatsoever -- not even
      // `commentary:view`, which `viewer` carries. Everything a client can
      // reach must be opted into explicitly.
      return [];
  }
}

export function resolveHumanInviteRole(
  defaultsPayload: Record<string, unknown> | null | undefined
): HumanCompanyMembershipRole {
  // An invite with no human defaults at all predates per-invite roles and
  // keeps the historical `operator` default.
  if (!defaultsPayload || typeof defaultsPayload !== "object") return "operator";
  const scoped = defaultsPayload.human;
  if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) {
    return "operator";
  }
  const role = (scoped as Record<string, unknown>).role;
  if (role === undefined || role === null) return "operator";
  // A role was asked for but is not one we recognize. Previously this fell
  // back to `operator`, so a request for a weak principal was answered with a
  // strong one (`tools:admin`, `users:invite`, `agents:create`). Fail closed
  // instead: an unrecognized role yields the least privileged principal.
  return normalizeHumanRole(role, LEAST_PRIVILEGED_HUMAN_COMPANY_MEMBERSHIP_ROLE);
}
