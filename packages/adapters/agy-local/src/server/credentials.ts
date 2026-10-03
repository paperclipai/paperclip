import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface AgyCredentialReadinessInput {
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  configuredApiKey?: string | null;
}

export interface AgyCredentialReadiness {
  ready: boolean;
  authMode: "subscription" | "api" | "none";
  tokenPath?: string | null;
  detail?: string | null;
}

/**
 * Searches for the Antigravity CLI OAuth token file across standard locations:
 * - $ANTIGRAVITY_CLI_HOME/antigravity-oauth-token
 * - $GEMINI_CLI_HOME/antigravity-oauth-token
 * - ~/.gemini/antigravity-cli/antigravity-oauth-token
 * - ~/.gemini/antigravity/antigravity-oauth-token
 */
export function resolveAgyOAuthTokenPath(
  homedir: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const candidatePaths = [
    env.ANTIGRAVITY_CLI_HOME ? path.join(env.ANTIGRAVITY_CLI_HOME, "antigravity-oauth-token") : null,
    env.GEMINI_CLI_HOME ? path.join(env.GEMINI_CLI_HOME, "antigravity-oauth-token") : null,
    path.join(homedir, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
    path.join(homedir, ".gemini", "antigravity", "antigravity-oauth-token"),
  ].filter((p): p is string => Boolean(p));

  for (const candidate of candidatePaths) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // Ignore filesystem access errors
    }
  }
  return null;
}

/**
 * Validates whether the OAuth token file exists, is non-empty, and contains a valid token.
 */
export function hasUsableAgyOAuthToken(tokenPath: string): boolean {
  try {
    if (!fs.existsSync(tokenPath)) return false;
    const stat = fs.statSync(tokenPath);
    if (stat.size === 0) return false;
    const content = fs.readFileSync(tokenPath, "utf8").trim();
    if (!content) return false;

    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === "object") {
        return Boolean(
          (typeof parsed.token === "string" && parsed.token.length > 0) ||
          (typeof parsed.access_token === "string" && parsed.access_token.length > 0) ||
          (typeof parsed.id_token === "string" && parsed.id_token.length > 0)
        );
      }
    } catch {
      // If not JSON, non-empty plain string counts as valid token material
      return content.length > 0;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Checks whether Antigravity credentials are ready to use.
 * Checks for:
 * 1. Explicitly configured API key
 * 2. Environment API keys (GEMINI_API_KEY, AGY_API_KEY, ANTIGRAVITY_API_KEY)
 * 3. Local OAuth token in ~/.gemini/antigravity-cli (or alternate homes)
 */
export function evaluateAgyCredentialReadiness(
  input: AgyCredentialReadinessInput = {},
): AgyCredentialReadiness {
  const env = input.env ?? process.env;
  const homedir = input.homedir ?? os.homedir();

  const explicitKey = (input.configuredApiKey ?? "").trim();
  if (explicitKey.length > 0) {
    return { ready: true, authMode: "api", detail: "configured_api_key" };
  }

  const envKey = (env.GEMINI_API_KEY || env.AGY_API_KEY || env.ANTIGRAVITY_API_KEY || "").trim();
  if (envKey.length > 0) {
    return { ready: true, authMode: "api", detail: "env_api_key" };
  }

  const tokenPath = resolveAgyOAuthTokenPath(homedir, env);
  if (tokenPath && hasUsableAgyOAuthToken(tokenPath)) {
    return {
      ready: true,
      authMode: "subscription",
      tokenPath,
      detail: "oauth_token_file",
    };
  }

  return { ready: false, authMode: "none", detail: "missing_credentials" };
}
