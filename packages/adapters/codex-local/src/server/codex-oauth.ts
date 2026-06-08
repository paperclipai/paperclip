/**
 * Codex (ChatGPT) OAuth token refresh.
 *
 * The Codex CLI authenticates a ChatGPT subscription via a localhost-callback
 * OAuth flow and stores the result in `$CODEX_HOME/auth.json` under
 * `tokens.{access_token,refresh_token,id_token,account_id}`. Unlike Claude, the
 * blob has NO explicit `expiresAt` — expiry is the JWT `exp` claim of the
 * access/id token.
 *
 * Paperclip only needs the REFRESH half for pooled accounts (accounts are added
 * by pasting auth.json, not via in-app login). This mirrors claude-oauth's
 * `refreshToken`, but against the public OpenAI auth endpoint + Codex CLI client.
 *
 * ⚠ Best-effort (spec R4): the exact token URL / client_id / body for the
 * ChatGPT-subscription Codex refresh are not otherwise referenced in this repo.
 * These are the publicly-documented Codex CLI OAuth values. If they drift, the
 * caller (account-pool) treats a failed refresh as a non-fatal error and the
 * balancer rotates away from the account — no run breaks.
 */

const CODEX_OAUTH = {
  /** public Codex CLI OAuth client id */
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  tokenUrl: "https://auth.openai.com/oauth/token",
  scopes: "openid profile email offline_access",
} as const;

/** Normalized result of a Codex token refresh. */
export interface CodexTokenResult {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  /** epoch ms when the access token expires, derived from the JWT exp claim */
  expiresAt: number | null;
}

interface RawCodexTokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

/** Decode the `exp` (epoch seconds) claim from a JWT, as epoch ms, or null. */
function jwtExpiryMs(token: string | null | undefined): number | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    let normalized = (parts[1] ?? "").replace(/-/g, "+").replace(/_/g, "/");
    const remainder = normalized.length % 4;
    if (remainder > 0) normalized += "=".repeat(4 - remainder);
    const payload = JSON.parse(Buffer.from(normalized, "base64").toString("utf8")) as Record<string, unknown>;
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function normalizeCodexTokenResponse(raw: RawCodexTokenResponse): CodexTokenResult {
  if (!raw.access_token) throw new Error("codex token response missing access_token");
  const expiresAt =
    typeof raw.expires_in === "number"
      ? Date.now() + raw.expires_in * 1000
      : jwtExpiryMs(raw.id_token) ?? jwtExpiryMs(raw.access_token);
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token ?? null,
    idToken: raw.id_token ?? null,
    expiresAt,
  };
}

/** Exchange a refresh token for a fresh Codex access token. */
export async function refreshCodexToken(refresh: string): Promise<CodexTokenResult> {
  const resp = await fetch(CODEX_OAUTH.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: CODEX_OAUTH.clientId,
      scope: CODEX_OAUTH.scopes,
    }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`Codex token refresh failed (${resp.status})${detail ? `: ${detail.slice(0, 160)}` : ""}`);
  }
  return normalizeCodexTokenResponse((await resp.json()) as RawCodexTokenResponse);
}

/** Expose the JWT expiry helper so callers can compute staleness from a stored blob. */
export { jwtExpiryMs as codexJwtExpiryMs };
