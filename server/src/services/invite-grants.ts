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

/**
 * What a defaults payload asked for, including what had to be thrown away.
 *
 * Dropping an unreadable expiry is only fail-closed if the caller knows the
 * drop happened. Both fallbacks below re-add a permission when it is missing
 * from the result, and "missing because the payload never mentioned it" and
 * "missing because its bound could not be read" call for opposite answers
 * (FAI-10144, FAI-10152 round 4).
 */
type DefaultsGrants = {
  grants: JoinGrant[];
  /** Keys the payload named but whose expiry could not be read. */
  unreadableExpiryKeys: Set<string>;
};

function collectGrantsFromDefaults(
  defaultsPayload: Record<string, unknown> | null | undefined,
  key: "human" | "agent"
): DefaultsGrants {
  const empty: DefaultsGrants = { grants: [], unreadableExpiryKeys: new Set() };
  if (!defaultsPayload || typeof defaultsPayload !== "object") return empty;
  const scoped = defaultsPayload[key];
  if (!scoped || typeof scoped !== "object") return empty;
  const grants = (scoped as Record<string, unknown>).grants;
  if (!Array.isArray(grants)) return empty;
  const validPermissionKeys = new Set<string>(PERMISSION_KEYS);
  const result: JoinGrant[] = [];
  const unreadableExpiryKeys = new Set<string>();
  for (const item of grants) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.permissionKey !== "string") continue;
    if (!validPermissionKeys.has(record.permissionKey)) continue;
    const expiresAt = grantExpiryFromDefaults(record.expiresAt);
    if (expiresAt === "invalid") {
      unreadableExpiryKeys.add(record.permissionKey);
      continue;
    }
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
  return { grants: result, unreadableExpiryKeys };
}

export function grantsFromDefaults(
  defaultsPayload: Record<string, unknown> | null | undefined,
  key: "human" | "agent"
): JoinGrant[] {
  return collectGrantsFromDefaults(defaultsPayload, key).grants;
}

export function agentJoinGrantsFromDefaults(
  defaultsPayload: Record<string, unknown> | null | undefined
): JoinGrant[] {
  const { grants, unreadableExpiryKeys } = collectGrantsFromDefaults(defaultsPayload, "agent");
  if (grants.some((grant) => grant.permissionKey === "tasks:assign")) {
    return grants;
  }
  // The payload *did* ask for `tasks:assign`, with a bound nobody could read.
  // Appending the default here would hand out the indefinite version of exactly
  // the grant the operator was trying to time-box — dropping the entry upstream
  // would have widened authority instead of narrowing it. No grant at all is the
  // fail-closed reading of "they wanted this bounded and the bound is unusable".
  if (unreadableExpiryKeys.has("tasks:assign")) {
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
  const { grants, unreadableExpiryKeys } = collectGrantsFromDefaults(defaultsPayload, "human");
  if (grants.length > 0) return grants;
  // Same widening, wider blast radius: a payload whose human grants were *all*
  // unreadable leaves an empty list, and falling through to the role defaults
  // would grant an admin the full indefinite set the invite was bounding. An
  // empty result caused by rejected entries is not the same as an invite that
  // named no human grants, which still gets the role defaults.
  if (unreadableExpiryKeys.size > 0) return [];
  return grantsForHumanRole(membershipRole);
}
