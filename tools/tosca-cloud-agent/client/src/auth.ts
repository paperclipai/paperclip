import type { PATCredentials, SSOCredentials, ToscaCredentials } from "./types.js";
import { ToscaAuthError } from "./types.js";

export interface ResolvedAuth {
  readonly authorizationHeader: string;
}

interface SSOTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface TokenCache {
  token: string;
  expiresAt: number;
}

const ssoTokenCache = new Map<string, TokenCache>();

function cacheKey(creds: SSOCredentials): string {
  return `${creds.tenantUrl}::${creds.clientId}`;
}

async function fetchSSOToken(
  creds: SSOCredentials,
  fetchFn: typeof globalThis.fetch,
): Promise<string> {
  const key = cacheKey(creds);
  const cached = ssoTokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 30_000) {
    return cached.token;
  }

  const tokenUrl = new URL("/oauth/token", creds.tenantUrl).toString();
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  });

  const response = await fetchFn(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new ToscaAuthError(
      `SSO token request failed with status ${response.status}`,
    );
  }

  const data = (await response.json()) as SSOTokenResponse;
  if (!data.access_token) {
    throw new ToscaAuthError("SSO token response missing access_token");
  }

  ssoTokenCache.set(key, {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  });

  return data.access_token;
}

export function resolvePatAuth(creds: PATCredentials): ResolvedAuth {
  return { authorizationHeader: `Bearer ${creds.token}` };
}

export async function resolveAuth(
  creds: ToscaCredentials,
  fetchFn: typeof globalThis.fetch,
): Promise<ResolvedAuth> {
  if (creds.type === "pat") {
    return resolvePatAuth(creds);
  }
  const token = await fetchSSOToken(creds, fetchFn);
  return { authorizationHeader: `Bearer ${token}` };
}

export function clearSSOTokenCache(): void {
  ssoTokenCache.clear();
}
