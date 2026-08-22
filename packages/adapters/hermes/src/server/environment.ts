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

export function resolveEffectiveHermesHome(
  env: Record<string, string>,
  platform: EnvironmentPlatform = process.platform,
): string | null | undefined {
  const hermesHome = readEnvironmentValue(env, "HERMES_HOME", platform);
  if (hermesHome !== undefined) return hermesHome === "" ? null : hermesHome;

  if (platform === "win32") {
    const localAppData = readEnvironmentValue(env, "LOCALAPPDATA", platform);
    if (localAppData !== undefined) {
      return localAppData === "" ? null : path.join(localAppData, "hermes");
    }
  }

  const home = readEnvironmentValue(env, "HOME", platform);
  if (home !== undefined) return home === "" ? null : path.join(home, ".hermes");

  const userProfile = readEnvironmentValue(env, "USERPROFILE", platform);
  if (userProfile !== undefined) {
    return userProfile === "" ? null : path.join(userProfile, ".hermes");
  }

  return undefined;
}

export function resolveHermesConfigPath(
  env: Record<string, string>,
  platform: EnvironmentPlatform = process.platform,
): string | null | undefined {
  const hermesHome = resolveEffectiveHermesHome(env, platform);
  return hermesHome === null || hermesHome === undefined
    ? hermesHome
    : path.join(hermesHome, "config.yaml");
}

export function resolveHermesEnvPath(
  env: Record<string, string>,
  platform: EnvironmentPlatform = process.platform,
): string | null | undefined {
  const hermesHome = resolveEffectiveHermesHome(env, platform);
  return hermesHome === null || hermesHome === undefined
    ? hermesHome
    : path.join(hermesHome, ".env");
}
