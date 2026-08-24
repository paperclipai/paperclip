import { PERMISSION_KEYS } from "@paperclipai/shared";
import type { HumanCompanyMembershipRole } from "@paperclipai/shared";

const HUMAN_COMPANY_MEMBERSHIP_ROLES: HumanCompanyMembershipRole[] = [
  "owner",
  "admin",
  "operator",
  "viewer",
];

export function normalizeHumanRole(
  value: unknown,
  fallback: HumanCompanyMembershipRole = "operator"
): HumanCompanyMembershipRole {
  if (value === "member") return "operator";
  return HUMAN_COMPANY_MEMBERSHIP_ROLES.includes(value as HumanCompanyMembershipRole)
    ? (value as HumanCompanyMembershipRole)
    : fallback;
}

/**
 * A role's default grant set, applied once when a principal first holds that
 * role and never again (`insertMissingPrincipalGrants`).
 *
 * **Adding a permission key here does not reach existing members.** Since
 * FAI-10190 the seeder is a bootstrap: a principal already settled at this role
 * is skipped outright, because "missing" has to be allowed to mean "revoked"
 * for a revocation to survive a server restart. Propagation is therefore an
 * explicit step, not a side effect of editing this function.
 *
 * Write the propagation as a backfill migration, the way
 * `0087_backfill_environment_manage_human_defaults.sql` and
 * `0111_backfill_skill_create_human_defaults.sql` already do: insert the one
 * new key for the memberships whose role now carries it, `ON CONFLICT DO
 * NOTHING`. That is deliberate rather than incidental — it states in the
 * migration exactly which existing members gain the new authority, which a
 * background sweep silently widening every member's grant set never did.
 *
 * Removing a key here is the mirror image: it stops being granted to principals
 * seeded from now on, and members who already hold it keep it until a migration
 * deletes it.
 */
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
      ];
    case "operator":
      return [{ permissionKey: "tasks:assign", scope: null }];
    case "viewer":
      return [];
  }
}

export function resolveHumanInviteRole(
  defaultsPayload: Record<string, unknown> | null | undefined
): HumanCompanyMembershipRole {
  if (!defaultsPayload || typeof defaultsPayload !== "object") return "operator";
  const scoped = defaultsPayload.human;
  if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) {
    return "operator";
  }
  return normalizeHumanRole((scoped as Record<string, unknown>).role, "operator");
}
