export const MINIMUM_NODE_VERSION = "24.11.0";

function parseVersion(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isSupportedNodeVersion(version: string): boolean {
  const current = parseVersion(version);
  const minimum = parseVersion(MINIMUM_NODE_VERSION);
  if (!current || !minimum) return false;

  for (let index = 0; index < current.length; index += 1) {
    if (current[index] > minimum[index]) return true;
    if (current[index] < minimum[index]) return false;
  }
  return true;
}
