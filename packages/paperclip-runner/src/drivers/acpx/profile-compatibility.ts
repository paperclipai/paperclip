import { QUALIFIED_ACPX_PROFILE_DATA } from "./generated-profiles.js";

/** Decodable profile revisions, not permission to launch them.
 * Exact current profile/package/digest admission is checked separately.
 * Every revision from 1 through the current one decodes, so saved runs reach
 * recovery and are refused there. Claude and Codex already retained revisions
 * 1 through 5 above their current revision 1. */
const RETAINED_THROUGH: Readonly<Record<string, number>> = { claude: 5, codex: 5 };

export type AcpxProfileVersion = number;

export function isSupportedAcpxProfileVersion(agent: string, value: unknown): value is AcpxProfileVersion {
  if (!Object.hasOwn(QUALIFIED_ACPX_PROFILE_DATA, agent) || !Number.isSafeInteger(value)) return false;
  const current = QUALIFIED_ACPX_PROFILE_DATA[agent as keyof typeof QUALIFIED_ACPX_PROFILE_DATA].agentProfileVersion;
  const latest = Math.max(current, Object.hasOwn(RETAINED_THROUGH, agent) ? RETAINED_THROUGH[agent]! : 0);
  return (value as number) >= 1 && (value as number) <= latest;
}
