/**
 * Auth strategies for Azure OpenAI / Azure AI Foundry.
 *
 * Three modes, chosen by config.authMode (default: api_key):
 *
 *  - api_key    → sends `api-key: <key>` header. Many enterprise Azure OpenAI /
 *                 Foundry resources have API key auth disabled.
 *
 *  - bearer     → sends `Authorization: Bearer <token>` with a token the
 *                 operator supplies (via config.bearerToken). The adapter does
 *                 NOT refresh — external tooling (CI, `az account
 *                 get-access-token`, etc.) is responsible for keeping the
 *                 token fresh in the Paperclip secret.
 *
 *  - azure_ad   → uses @azure/identity's DefaultAzureCredential to obtain a
 *                 token for the `https://cognitiveservices.azure.com/.default`
 *                 scope. Handles managed identity, `az login`, environment
 *                 variables, and interactive browser transparently. Token is
 *                 cached in-process and refreshed 5 minutes before expiry.
 *                 @azure/identity is required only when this mode is selected.
 */

import { asString } from "@paperclipai/adapter-utils/server-utils";

export type AuthMode = "api_key" | "bearer" | "azure_ad";

export function resolveAuthMode(config: Record<string, unknown>): AuthMode {
  const raw = asString(config.authMode, "api_key");
  return raw === "bearer" || raw === "azure_ad" ? raw : "api_key";
}

export type ResolvedAuth = {
  headers: Record<string, string>;
  displayMode: AuthMode;
};

export const DEFAULT_AAD_SCOPE = "https://cognitiveservices.azure.com/.default";

type CachedToken = { token: string; expiresAt: number };
const tokenCache = new Map<string, CachedToken>();
let cachedCredential: unknown | null = null;

const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

async function getAzureAdToken(scope: string): Promise<string> {
  const now = Date.now();
  const cached = tokenCache.get(scope);
  if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > now) {
    return cached.token;
  }

  type IdentityModule = {
    DefaultAzureCredential: new (opts?: unknown) => {
      getToken: (scopes: string | string[]) => Promise<{ token: string; expiresOnTimestamp: number } | null>;
    };
  };
  let identityModule: IdentityModule;
  try {
    identityModule = (await import("@azure/identity")) as unknown as IdentityModule;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `azure_openai adapter: authMode='azure_ad' requires the '@azure/identity' package. Install it in the Paperclip server workspace (e.g. 'pnpm add @azure/identity') or switch config.authMode to 'api_key' or 'bearer'. Underlying error: ${message}`,
    );
  }

  if (!cachedCredential) {
    cachedCredential = new identityModule.DefaultAzureCredential();
  }
  const cred = cachedCredential as {
    getToken: (scopes: string | string[]) => Promise<{ token: string; expiresOnTimestamp: number } | null>;
  };
  const result = await cred.getToken([scope]);
  if (!result || !result.token) {
    throw new Error(
      `azure_openai adapter: DefaultAzureCredential returned no token for scope '${scope}'. Ensure the process is signed in (e.g. 'az login') or a managed identity is available.`,
    );
  }
  tokenCache.set(scope, {
    token: result.token,
    expiresAt: result.expiresOnTimestamp ?? now + 30 * 60 * 1000,
  });
  return result.token;
}

export async function resolveAuthHeaders(
  config: Record<string, unknown>,
): Promise<ResolvedAuth> {
  const mode = resolveAuthMode(config);

  if (mode === "api_key") {
    const apiKey = asString(config.apiKey, "");
    if (!apiKey) {
      throw new Error("azure_openai adapter: authMode='api_key' but config.apiKey is empty");
    }
    return { headers: { "api-key": apiKey }, displayMode: mode };
  }

  if (mode === "bearer") {
    const bearerToken = asString(config.bearerToken, "");
    if (!bearerToken) {
      throw new Error(
        "azure_openai adapter: authMode='bearer' but config.bearerToken is empty. Populate it with a valid AAD access token (e.g. 'az account get-access-token --resource https://cognitiveservices.azure.com').",
      );
    }
    return {
      headers: { Authorization: `Bearer ${bearerToken}` },
      displayMode: mode,
    };
  }

  const scope = asString(config.aadScope, DEFAULT_AAD_SCOPE);
  const token = await getAzureAdToken(scope);
  return { headers: { Authorization: `Bearer ${token}` }, displayMode: mode };
}

/** Test-only cache reset. */
export function _resetAuthCachesForTests(): void {
  tokenCache.clear();
  cachedCredential = null;
}
