import { logger } from "../../../middleware/logger.js";

const ENV_NAME = "PAPERCLIP_OAUTH_REDIRECT_OVERRIDES";

let warnedFor: string | null = null;

function warnOnce(raw: string, message: string, detail?: Record<string, unknown>) {
  const key = `${raw}\u0000${message}`;
  if (warnedFor === key) return;
  warnedFor = key;
  logger.warn({ env: ENV_NAME, ...detail }, message);
}

function httpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Parse `PAPERCLIP_OAUTH_REDIRECT_OVERRIDES`: a JSON object mapping an MCP server
 * origin to the OAuth redirect URI Paperclip must use for connections to that
 * server (for authorization servers that refuse the public Paperclip host).
 * Invalid JSON or entries are skipped with a warning.
 */
export function parseOAuthRedirectOverrides(raw: string | undefined): Map<string, string> {
  const overrides = new Map<string, string>();
  const text = raw?.trim();
  if (!text) return overrides;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    warnOnce(text, `${ENV_NAME} is not valid JSON; ignoring it`);
    return overrides;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    warnOnce(text, `${ENV_NAME} must be a JSON object; ignoring it`);
    return overrides;
  }
  for (const [server, redirect] of Object.entries(parsed)) {
    const origin = httpOrigin(server);
    let redirectUri: string | null = null;
    if (origin && typeof redirect === "string" && httpOrigin(redirect)) {
      const url = new URL(redirect);
      if (!url.hash) redirectUri = url.toString();
    }
    if (!origin || !redirectUri) {
      warnOnce(text, `${ENV_NAME} entry is not a valid server origin and redirect URL; ignoring it`, { server });
      continue;
    }
    overrides.set(origin, redirectUri);
  }
  return overrides;
}

/**
 * The redirect URI for one OAuth flow: the configured override for the
 * connection's MCP server origin, otherwise the deployment's default callback.
 */
export function resolveOAuthRedirectUri(
  connectionUrl: unknown,
  defaultRedirectUri: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = env[ENV_NAME];
  if (!raw?.trim() || typeof connectionUrl !== "string") return defaultRedirectUri;
  const origin = httpOrigin(connectionUrl);
  if (!origin) return defaultRedirectUri;
  return parseOAuthRedirectOverrides(raw).get(origin) ?? defaultRedirectUri;
}
