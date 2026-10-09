/** Decodable historical profile revisions, not permission to launch them.
 * Exact current profile/package/digest admission is checked separately. */
export type AcpxProfileVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;
const historicalVersions: Readonly<Record<string, readonly AcpxProfileVersion[]>> = {
  pi: [1, 2, 3, 4, 5], claude: [1, 2, 3, 4, 5], codex: [1, 2, 3, 4, 5],
  grok: [1, 2, 3, 4, 5], copilot: [1, 2, 3, 4, 5],
  cursor: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
};

export function isSupportedAcpxProfileVersion(agent: string, value: unknown): value is AcpxProfileVersion {
  return Object.hasOwn(historicalVersions, agent)
    && historicalVersions[agent]!.includes(value as AcpxProfileVersion);
}
