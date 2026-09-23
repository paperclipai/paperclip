/**
 * The app-server compatibility window is separate from the reproducible install
 * pin. 0.149.0 shipped on 2026-08-20; 0.156.0 shipped on 2026-09-22.
 * Revisit both bounds when qualifying a new Codex minor release. Do not age out
 * an installed version based on the wall clock or query a registry at startup.
 */
export const REMOTE_CODEX_MINIMUM_VERSION = "0.149.0";
export const REMOTE_CODEX_MAXIMUM_VERSION_EXCLUSIVE = "0.157.0";
export const REMOTE_CODEX_SUPPORTED_RANGE =
  `>=${REMOTE_CODEX_MINIMUM_VERSION} <${REMOTE_CODEX_MAXIMUM_VERSION_EXCLUSIVE}`;

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function stableVersionParts(version: string): number[] | null {
  const match = STABLE_VERSION.exec(version);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

/** Parse a complete version line so alpha/dev suffixes cannot pass as stable. */
export function parseCodexCliVersion(output: string): string | null {
  const versions = output.split(/\r?\n/)
    .map((line) => /^codex-cli (\S+)$/.exec(line.trim())?.[1])
    .filter((version): version is string => version !== undefined);
  if (versions.length !== 1 || !stableVersionParts(versions[0]!)) return null;
  return versions[0]!;
}

export function isSupportedRemoteCodexVersion(version: string): boolean {
  const parts = stableVersionParts(version);
  if (!parts) return false;
  const minimum = stableVersionParts(REMOTE_CODEX_MINIMUM_VERSION)!;
  const maximum = stableVersionParts(REMOTE_CODEX_MAXIMUM_VERSION_EXCLUSIVE)!;
  const compare = (other: number[]) => {
    for (let index = 0; index < parts.length; index++) {
      if (parts[index] !== other[index]) return parts[index]! - other[index]!;
    }
    return 0;
  };
  return compare(minimum) >= 0 && compare(maximum) < 0;
}
