import path from "node:path";

export function managedAiHomeEnvironment(home: string): Record<string, string> {
  const providerHome = path.join(home, "provider");
  return {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_DATA_HOME: path.join(home, "data"),
    CODEX_HOME: providerHome,
    GROK_HOME: providerHome,
    CLAUDE_CONFIG_DIR: providerHome,
  };
}

/** Normalize only exact paths from the server-created home, never custom env. */
export function managedAiSessionEnvironment<T>(
  env: Record<string, T>,
  managedHome: string | undefined,
): Record<string, T | string> {
  if (!managedHome) return env;
  const result: Record<string, T | string> = { ...env };
  const stable = managedAiHomeEnvironment("<managed-ai-home>");
  for (const [key, value] of Object.entries(managedAiHomeEnvironment(managedHome))) {
    if (result[key] === value) result[key] = stable[key]!;
  }
  return result;
}
