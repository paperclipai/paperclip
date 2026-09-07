const STATIC_GITHUB_CREDENTIAL_ENVIRONMENT_KEYS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "PAPERCLIP_GIT_TOKEN",
  "GIT_TERMINAL_PROMPT",
  "GIT_CONFIG_COUNT",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
] as const;

const MAX_GIT_CONFIG_ENTRIES = 32;

function gitConfigCount(source: NodeJS.ProcessEnv): number | null {
  const raw = source.GIT_CONFIG_COUNT;
  if (raw === undefined || !/^\d+$/u.test(raw)) return null;
  const count = Number(raw);
  if (!Number.isSafeInteger(count) || count > MAX_GIT_CONFIG_ENTRIES) {
    return null;
  }
  return count;
}

/**
 * Returns the exact controller-projected GitHub environment accepted by the
 * native runner. Dynamic Git config entries are bounded by GIT_CONFIG_COUNT so
 * callers cannot smuggle arbitrary environment variables across the boundary.
 */
export function githubCredentialEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of STATIC_GITHUB_CREDENTIAL_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }

  const count = gitConfigCount(source);
  if (count === null) {
    delete environment.GIT_CONFIG_COUNT;
    return environment;
  }
  for (let index = 0; index < count; index += 1) {
    for (const prefix of ["GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_"] as const) {
      const key = `${prefix}${index}`;
      const value = source[key];
      if (value !== undefined) environment[key] = value;
    }
  }
  return environment;
}

export function githubCredentialEnvironmentKeys(
  source: NodeJS.ProcessEnv,
): string[] {
  return Object.keys(githubCredentialEnvironment(source)).sort();
}

export function hasGitHubCredentialEnvironment(
  source: NodeJS.ProcessEnv,
): boolean {
  return [
    source.GH_TOKEN,
    source.GITHUB_TOKEN,
    source.PAPERCLIP_GIT_TOKEN,
  ].some((value) => typeof value === "string" && value.trim().length > 0);
}
