import { PERMISSION_KEYS, portableGrantExpirySchema } from "@paperclipai/shared";
import type { HumanCompanyMembershipRole } from "@paperclipai/shared";
import { grantsForHumanRole } from "./company-member-roles.js";

/**
 * One grant an invite's defaults payload asks for.
 *
 * `expiresAt` absent means the payload did not mention a bound, which is how
 * every writer of `principal_permission_grants` spells "leave whatever bound is
 * already there alone". On a join there is no row yet, so absent and null both
 * land as no expiry — but keeping the distinction here means these grants can be
 * handed to `setPrincipalGrants` without a special case (FAI-10144).
 */
export type JoinGrant = {
  permissionKey: (typeof PERMISSION_KEYS)[number];
  scope: Record<string, unknown> | null;
  expiresAt?: Date | null;
};

/**
 * The expiry a defaults payload names for one grant, or `"invalid"`.
 *
 * A string is held to `portableGrantExpirySchema` — an ISO instant that names
 * its own offset — for the same reason the portable manifest is: a zone-free
 * instant resolves against whichever machine happens to read it, so the same
 * invite would confer a different window in a different deployment.
 *
 * An unparseable expiry drops the whole grant rather than degrading to no
 * expiry. The payload is operator-authored and unvalidated, the join creates the
 * row fresh, and "the bound could not be read" must never resolve to standing
 * authority.
 */
function grantExpiryFromDefaults(value: unknown): Date | null | undefined | "invalid" {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const parsed = portableGrantExpirySchema.safeParse(value);
  if (!parsed.success || typeof parsed.data !== "string") return "invalid";
  return new Date(parsed.data);
}

export function grantsFromDefaults(
  defaultsPayload: Record<string, unknown> | null | undefined,
  key: "human" | "agent"
): JoinGrant[] {
  if (!defaultsPayload || typeof defaultsPayload !== "object") return [];
  const scoped = defaultsPayload[key];
  if (!scoped || typeof scoped !== "object") return [];
  const grants = (scoped as Record<string, unknown>).grants;
  if (!Array.isArray(grants)) return [];
  const validPermissionKeys = new Set<string>(PERMISSION_KEYS);
  const result: JoinGrant[] = [];
  for (const item of grants) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.permissionKey !== "string") continue;
    if (!validPermissionKeys.has(record.permissionKey)) continue;
    const expiresAt = grantExpiryFromDefaults(record.expiresAt);
    if (expiresAt === "invalid") continue;
    result.push({
      permissionKey: record.permissionKey as (typeof PERMISSION_KEYS)[number],
      scope:
        record.scope &&
        typeof record.scope === "object" &&
        !Array.isArray(record.scope)
          ? (record.scope as Record<string, unknown>)
          : null,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
  }
  return result;
}

export function agentJoinGrantsFromDefaults(
  defaultsPayload: Record<string, unknown> | null | undefined
): JoinGrant[] {
  const grants = grantsFromDefaults(defaultsPayload, "agent");
  if (grants.some((grant) => grant.permissionKey === "tasks:assign")) {
    return grants;
  }
  return [
    ...grants,
    {
      permissionKey: "tasks:assign",
      scope: null,
    },
  ];
}

export function humanJoinGrantsFromDefaults(
  defaultsPayload: Record<string, unknown> | null | undefined,
  membershipRole: HumanCompanyMembershipRole
): JoinGrant[] {
  const grants = grantsFromDefaults(defaultsPayload, "human");
  return grants.length > 0 ? grants : grantsForHumanRole(membershipRole);
}
