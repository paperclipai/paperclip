import {
  BOARD_ONLY_AGENT_PERMISSION_KEYS,
  PERMISSION_KEYS,
} from "@paperclipai/shared";
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

const BOARD_ONLY_AGENT_PERMISSION_KEY_SET = new Set<string>(
  BOARD_ONLY_AGENT_PERMISSION_KEYS,
);

export function boardOnlyAgentInviteGrantKeysFromDefaults(
  defaultsPayload: Record<string, unknown> | null | undefined,
): Array<(typeof BOARD_ONLY_AGENT_PERMISSION_KEYS)[number]> {
  return Array.from(new Set(
    grantsFromDefaults(defaultsPayload, "agent")
      .map((grant) => grant.permissionKey)
      .filter(
        (permissionKey): permissionKey is (typeof BOARD_ONLY_AGENT_PERMISSION_KEYS)[number] =>
          BOARD_ONLY_AGENT_PERMISSION_KEY_SET.has(permissionKey),
      ),
  ));
}

export function agentJoinGrantsFromDefaults(
  defaultsPayload: Record<string, unknown> | null | undefined
): Array<{
  permissionKey: (typeof PERMISSION_KEYS)[number];
  scope: Record<string, unknown> | null;
}> {
  // Existing invites may predate a permission becoming board-only. Keep the
  // approval path fail-safe by filtering it even though new invites are
  // rejected before persistence by the route.
  const grants = grantsFromDefaults(defaultsPayload, "agent").filter(
    (grant) => !BOARD_ONLY_AGENT_PERMISSION_KEY_SET.has(grant.permissionKey),
  );
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
