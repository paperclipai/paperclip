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
 * Parses and validates raw content from an Antigravity OAuth token file.
 */
export function parseAgyOAuthToken(content: string): {
  valid: boolean;
  payload: any;
  accessToken: string | null;
  refreshToken: string | null;
  idToken: string | null;
  isExpired: boolean;
  expiryMs: number | null;
} {
  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object") {
      return { valid: false, payload: null, accessToken: null, refreshToken: null, idToken: null, isExpired: false, expiryMs: null };
    }

    const tokenObj = typeof parsed.token === "object" && parsed.token !== null ? parsed.token : null;
    const accessToken =
      (tokenObj && typeof tokenObj.access_token === "string" && tokenObj.access_token.length > 0)
        ? tokenObj.access_token
        : typeof parsed.access_token === "string" && parsed.access_token.length > 0
          ? parsed.access_token
          : typeof parsed.token === "string" && parsed.token.length > 0
            ? parsed.token
            : null;

    const refreshToken =
      (tokenObj && typeof tokenObj.refresh_token === "string" && tokenObj.refresh_token.length > 0)
        ? tokenObj.refresh_token
        : typeof parsed.refresh_token === "string" && parsed.refresh_token.length > 0
          ? parsed.refresh_token
          : null;

    const idToken =
      (tokenObj && typeof tokenObj.id_token === "string" && tokenObj.id_token.length > 0)
        ? tokenObj.id_token
        : typeof parsed.id_token === "string" && parsed.id_token.length > 0
          ? parsed.id_token
          : null;

    const expiryStr = (tokenObj && typeof tokenObj.expiry === "string")
      ? tokenObj.expiry
      : typeof parsed.expiry === "string"
        ? parsed.expiry
        : typeof parsed.expires_at === "string"
          ? parsed.expires_at
          : null;

    let isExpired = false;
    let expiryMs: number | null = null;
    if (expiryStr) {
      const ms = new Date(expiryStr).getTime();
      if (!Number.isNaN(ms)) {
        expiryMs = ms;
        if (ms <= Date.now()) {
          isExpired = true;
        }
      }
    }

    const hasTokens = Boolean(accessToken || refreshToken || idToken);
    const valid = hasTokens && (!isExpired || Boolean(refreshToken));

    return {
      valid,
      payload: parsed,
      accessToken,
      refreshToken,
      idToken,
      isExpired,
      expiryMs,
    };
  } catch {
    const trimmed = content.trim();
    return {
      valid: trimmed.length > 0,
      payload: trimmed,
      accessToken: trimmed || null,
      refreshToken: null,
      idToken: null,
      isExpired: false,
      expiryMs: null,
    };
  }
}

/**
 * Validates whether the OAuth token file exists, is non-empty, and contains a valid token.
 */
export function hasUsableAgyOAuthToken(tokenPath: string): boolean {
  try {
    if (!fs.existsSync(tokenPath)) return false;
    const stat = fs.statSync(tokenPath);
    if (stat.size === 0) return false;
    const content = fs.readFileSync(tokenPath, "utf8");
    return parseAgyOAuthToken(content).valid;
  } catch {
    return false;
  }
}

/**
 * Resolves the path to the Antigravity settings.json file.
 */
export function resolveAgySettingsPath(
  homedir: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const dir =
    env.ANTIGRAVITY_CLI_HOME ||
    env.GEMINI_CLI_HOME ||
    path.join(homedir, ".gemini", "antigravity-cli");
  return path.join(dir, "settings.json");
}

/**
 * Guarantees that settings.json exists at ~/.gemini/antigravity-cli/settings.json
 * (or $ANTIGRAVITY_CLI_HOME / $GEMINI_CLI_HOME) with { "modelProvider": "gemini" }
 * so agy uses the configured GEMINI_API_KEY.
 */
export async function ensureAgyApiKeySettings(
  homedir: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const settingsPath = resolveAgySettingsPath(homedir, env);
  const dir = path.dirname(settingsPath);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });

  let settings: Record<string, unknown> = {};
  try {
    const raw = await fs.promises.readFile(settingsPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      settings = parsed;
    }
  } catch {
    // Missing or invalid JSON; start fresh
  }

  if (settings.modelProvider !== "gemini") {
    settings.modelProvider = "gemini";
    await fs.promises.writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", {
      mode: 0o600,
    });
  }

  return settingsPath;
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

/**
  * Exit code 10: Replace destination credential with source.
  * Exit code 20: Keep destination credential.
  */
export async function decideAgyAuthMerge(
  sourcePath: string,
  destinationPath: string,
): Promise<number> {
  try {
    const sourceContent = await fs.promises.readFile(sourcePath, "utf8");
    const source = parseAgyOAuthToken(sourceContent);
    if (!source.valid) return 20;

    let destContent: string | null = null;
    try {
      destContent = await fs.promises.readFile(destinationPath, "utf8");
    } catch {
      return 10;
    }

    const dest = parseAgyOAuthToken(destContent);
    if (!dest.valid) return 10;

    if (source.expiryMs && dest.expiryMs) {
      if (source.expiryMs > dest.expiryMs) return 10;
      if (source.expiryMs < dest.expiryMs) return 20;
    }

    if (source.accessToken !== dest.accessToken || source.refreshToken !== dest.refreshToken) {
      return 10;
    }

    return 20;
  } catch {
    return 20;
  }
}
