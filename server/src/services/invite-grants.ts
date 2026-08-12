import { PERMISSION_KEYS } from "@paperclipai/shared";
import type { HumanCompanyMembershipRole } from "@paperclipai/shared";
import { grantsForHumanRole } from "./company-member-roles.js";

export function grantsFromDefaults(
  defaultsPayload: Record<string, unknown> | null | undefined,
  key: "human" | "agent"
): Array<{
  permissionKey: (typeof PERMISSION_KEYS)[number];
  scope: Record<string, unknown> | null;
}> {
  if (!defaultsPayload || typeof defaultsPayload !== "object") return [];
  const scoped = defaultsPayload[key];
  if (!scoped || typeof scoped !== "object") return [];
  const grants = (scoped as Record<string, unknown>).grants;
  if (!Array.isArray(grants)) return [];
  const validPermissionKeys = new Set<string>(PERMISSION_KEYS);
  const result: Array<{
    permissionKey: (typeof PERMISSION_KEYS)[number];
    scope: Record<string, unknown> | null;
  }> = [];
  for (const item of grants) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.permissionKey !== "string") continue;
    if (!validPermissionKeys.has(record.permissionKey)) continue;
    result.push({
      permissionKey: record.permissionKey as (typeof PERMISSION_KEYS)[number],
      scope:
        record.scope &&
        typeof record.scope === "object" &&
        !Array.isArray(record.scope)
          ? (record.scope as Record<string, unknown>)
          : null,
    });
  }
  return result;
}

export function agentJoinGrantsFromDefaults(
  defaultsPayload: Record<string, unknown> | null | undefined
): Array<{
  permissionKey: (typeof PERMISSION_KEYS)[number];
  scope: Record<string, unknown> | null;
}> {
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
): Array<{
  permissionKey: (typeof PERMISSION_KEYS)[number];
  scope: Record<string, unknown> | null;
}> {
  const grants = grantsFromDefaults(defaultsPayload, "human");
  return grants.length > 0 ? grants : grantsForHumanRole(membershipRole);
}
