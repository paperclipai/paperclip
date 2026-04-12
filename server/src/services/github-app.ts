/**
 * GitHub App installation token minting.
 *
 * When `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH` (or
 * `GITHUB_APP_PRIVATE_KEY`), and `GITHUB_APP_INSTALLATION_ID` are configured,
 * this module mints a short-lived installation access token by:
 *   1. Building an RS256 JWT signed with the app's private key (iss = app id).
 *   2. Exchanging the JWT at `POST /app/installations/{id}/access_tokens` for
 *      an installation token (~60 min TTL).
 *
 * The resulting token is cached in memory until 5 min before expiry and
 * reused across all `ghFetch` calls. A single in-flight promise deduplicates
 * concurrent refreshes.
 *
 * Installation tokens are scoped to whichever repos the app has been granted
 * access to on the target org — for Lucitra, that is the whole `lucitra`
 * org with `contents:read` + `metadata:read`, which is enough to import
 * private company packages during onboarding.
 *
 * Falls back to `null` when the app is not configured so callers can
 * continue to use PAT / unauthenticated requests.
 */

import { createPrivateKey, createSign } from "node:crypto";
import { readFile } from "node:fs/promises";

interface CachedToken {
  token: string;
  /** Absolute ms timestamp at which the cached token should be discarded. */
  expiresAt: number;
}

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

let cachedToken: CachedToken | null = null;
let cachedPrivateKey: string | null = null;
let inFlight: Promise<string | null> | null = null;

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function signRs256Jwt(privateKey: string, payload: Record<string, unknown>): string {
  const header = { alg: "RS256", typ: "JWT" };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const keyObject = createPrivateKey(privateKey);
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(keyObject);
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

async function loadPrivateKey(): Promise<string | null> {
  if (cachedPrivateKey) return cachedPrivateKey;

  const inlineKey = process.env.GITHUB_APP_PRIVATE_KEY?.trim();
  if (inlineKey && inlineKey.length > 0) {
    // Support both literal newlines and escaped `\n` (common when pasting
    // .pem contents into an env file as a single line).
    cachedPrivateKey = inlineKey.includes("\\n")
      ? inlineKey.replace(/\\n/g, "\n")
      : inlineKey;
    return cachedPrivateKey;
  }

  const keyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH?.trim();
  if (!keyPath) return null;

  const expanded = keyPath.startsWith("~/")
    ? `${process.env.HOME ?? ""}${keyPath.slice(1)}`
    : keyPath;

  try {
    cachedPrivateKey = await readFile(expanded, "utf8");
    return cachedPrivateKey;
  } catch {
    return null;
  }
}

function readAppConfig(): { appId: string; installationId: string } | null {
  const appId = process.env.GITHUB_APP_ID?.trim();
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID?.trim();
  if (!appId || !installationId) return null;
  return { appId, installationId };
}

export function isGitHubAppConfigured(): boolean {
  return readAppConfig() !== null
    && (!!process.env.GITHUB_APP_PRIVATE_KEY?.trim()
      || !!process.env.GITHUB_APP_PRIVATE_KEY_PATH?.trim());
}

/**
 * Resolve a cached installation access token, minting a fresh one if needed.
 * Returns `null` when the GitHub App is not configured or the exchange fails.
 */
export async function getGitHubAppInstallationToken(): Promise<string | null> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - REFRESH_MARGIN_MS > now) {
    return cachedToken.token;
  }

  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const config = readAppConfig();
      if (!config) return null;

      const privateKey = await loadPrivateKey();
      if (!privateKey) return null;

      const iat = Math.floor(now / 1000) - 60;
      const exp = iat + 9 * 60; // GitHub accepts up to 10 min; use 9 for clock drift
      const jwt = signRs256Jwt(privateKey, { iat, exp, iss: config.appId });

      const response = await fetch(
        `https://api.github.com/app/installations/${config.installationId}/access_tokens`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${jwt}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
      );

      if (!response.ok) return null;
      const body = (await response.json()) as { token?: string; expires_at?: string };
      if (!body.token) return null;

      const expiresAt = body.expires_at ? Date.parse(body.expires_at) : now + 55 * 60 * 1000;
      cachedToken = { token: body.token, expiresAt };
      return body.token;
    } catch {
      return null;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}
