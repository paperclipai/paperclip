/**
 * Maps COPILOT_GITHUB_TOKEN to GH_TOKEN and GITHUB_TOKEN when the latter
 * are not already set.  This lets users configure a single token variable
 * that is automatically propagated to the GitHub-auth env vars expected by
 * the Copilot CLI at runtime.
 */
export function applyCopilotAuthEnvAliases(env: Record<string, string>): void {
  const token = env.COPILOT_GITHUB_TOKEN?.trim();
  if (!token) return;
  if (!env.GH_TOKEN?.trim()) env.GH_TOKEN = token;
  if (!env.GITHUB_TOKEN?.trim()) env.GITHUB_TOKEN = token;
}
