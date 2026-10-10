import { QUALIFIED_ACPX_PROFILE_DATA } from "./generated-profiles.js";

/** Decodable historical profile revisions, not permission to launch them.
 * Exact current profile/package/digest admission is checked separately. */
type HistoricalAcpxProfileVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 | 26 | 27 | 28 | 29 | 30 | 31 | 32 | 33 | 34 | 35;
type CurrentAcpxProfileVersion = typeof QUALIFIED_ACPX_PROFILE_DATA[keyof typeof QUALIFIED_ACPX_PROFILE_DATA]["agentProfileVersion"];
export type AcpxProfileVersion = HistoricalAcpxProfileVersion | CurrentAcpxProfileVersion;

const historicalVersions: Readonly<Record<string, readonly HistoricalAcpxProfileVersion[]>> = {
  pi: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20], claude: [1, 2, 3, 4, 5], codex: [1, 2, 3, 4, 5],
  grok: [1, 2, 3, 4, 5], copilot: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35],
  cursor: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
};

export function isSupportedAcpxProfileVersion(agent: string, value: unknown): value is AcpxProfileVersion {
  if (!Object.hasOwn(QUALIFIED_ACPX_PROFILE_DATA, agent)) return false;
  const current = QUALIFIED_ACPX_PROFILE_DATA[agent as keyof typeof QUALIFIED_ACPX_PROFILE_DATA];
  return value === current.agentProfileVersion
    || historicalVersions[agent]?.includes(value as HistoricalAcpxProfileVersion) === true;
}
