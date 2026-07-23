import path from "node:path";

export type EnvironmentPlatform = NodeJS.Platform;

function environmentNamesMatch(left: string, right: string, platform: EnvironmentPlatform): boolean {
  return platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function readEnvironmentValue(
  env: Record<string, string>,
  key: string,
  platform: EnvironmentPlatform = process.platform,
): string | undefined {
  const matchingKey = Object.keys(env).find((candidate) => environmentNamesMatch(candidate, key, platform));
  return matchingKey === undefined ? undefined : env[matchingKey];
}

export function deleteEnvironmentValue(
  env: Record<string, string>,
  key: string,
  platform: EnvironmentPlatform = process.platform,
): void {
  for (const candidate of Object.keys(env)) {
    if (environmentNamesMatch(candidate, key, platform)) delete env[candidate];
  }
}

export function resolveHermesConfigPath(
  env: Record<string, string>,
  platform: EnvironmentPlatform = process.platform,
): string | null | undefined {
  const home = readEnvironmentValue(env, "HOME", platform);
  if (home !== undefined) return home === "" ? null : path.join(home, ".hermes", "config.yaml");

  const userProfile = readEnvironmentValue(env, "USERPROFILE", platform);
  if (userProfile !== undefined) {
    return userProfile === "" ? null : path.join(userProfile, ".hermes", "config.yaml");
  }

  return undefined;
}
