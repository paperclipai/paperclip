import { createHash, randomBytes } from "node:crypto";

/**
 * Claude "Login with Claude" OAuth (Authorization Code + PKCE, public client).
 *
 * Used to add a Claude subscription account to the Account Pool without pasting
 * a raw .credentials.json. Flow:
 *   1. generatePkce() + buildAuthorizeUrl() → user opens the URL in any browser,
 *      logs in, and Claude shows a "CODE#STATE" string on the callback page.
 *   2. user pastes CODE#STATE back → exchangeCode(code, verifier) → tokens + email.
 *   3. refreshToken(rt) keeps the pooled token alive past its 8h expiry.
 *
 * client_id is Claude Code's public client (no client_secret). The redirect_uri
 * is Anthropic's hosted page that DISPLAYS the code for manual paste — there is
 * no callback to our server.
 */

export const CLAUDE_OAUTH = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authorizeUrl: "https://claude.ai/oauth/authorize",
  // primary token endpoint; some deployments use /api/oauth/token — exchange()
  // falls back to it on a network/404 failure.
  tokenUrl: "https://console.anthropic.com/v1/oauth/token",
  tokenUrlFallback: "https://console.anthropic.com/api/oauth/token",
  redirectUri: "https://console.anthropic.com/oauth/code/callback",
  scopes: "org:create_api_key user:profile user:inference",
} as const;

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface Pkce {
  codeVerifier: string;
  codeChallenge: string;
  state: string;
}

/** Generate a PKCE verifier/challenge. The verifier doubles as the state. */
export function generatePkce(): Pkce {
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest());
  return { codeVerifier, codeChallenge, state: codeVerifier };
}

/** Build the authorize URL the user opens in a browser. */
export function buildAuthorizeUrl(codeChallenge: string, state: string): string {
  const params = new URLSearchParams({
    code: "true",
    response_type: "code",
    client_id: CLAUDE_OAUTH.clientId,
    redirect_uri: CLAUDE_OAUTH.redirectUri,
    scope: CLAUDE_OAUTH.scopes,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  });
  return `${CLAUDE_OAUTH.authorizeUrl}?${params.toString()}`;
}

/** Normalized result of a token exchange / refresh. */
export interface ClaudeTokenResult {
  accessToken: string;
  refreshToken: string | null;
  /** epoch ms when the access token expires */
  expiresAt: number | null;
  scopes: string[];
  email: string | null;
  organizationName: string | null;
}

interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  account?: { email_address?: string } | null;
  organization?: { name?: string } | null;
}

function normalizeTokenResponse(raw: RawTokenResponse): ClaudeTokenResult {
  if (!raw.access_token) throw new Error("token response missing access_token");
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token ?? null,
    expiresAt: typeof raw.expires_in === "number" ? Date.now() + raw.expires_in * 1000 : null,
    scopes: typeof raw.scope === "string" ? raw.scope.split(/\s+/).filter(Boolean) : [],
    email: raw.account?.email_address ?? null,
    organizationName: raw.organization?.name ?? null,
  };
}

async function postToken(body: Record<string, unknown>): Promise<ClaudeTokenResult> {
  const attempt = async (url: string): Promise<Response> =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "anthropic" },
      body: JSON.stringify(body),
    });

  let resp: Response;
  try {
    resp = await attempt(CLAUDE_OAUTH.tokenUrl);
    if (resp.status === 404) resp = await attempt(CLAUDE_OAUTH.tokenUrlFallback);
  } catch {
    resp = await attempt(CLAUDE_OAUTH.tokenUrlFallback);
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`claude oauth token endpoint returned ${resp.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  return normalizeTokenResponse((await resp.json()) as RawTokenResponse);
}

/** Exchange an authorization code (+ PKCE verifier) for tokens. */
export function exchangeCode(code: string, codeVerifier: string): Promise<ClaudeTokenResult> {
  return postToken({
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
    client_id: CLAUDE_OAUTH.clientId,
    redirect_uri: CLAUDE_OAUTH.redirectUri,
  });
}

/** Exchange a refresh token for a fresh access token. */
export function refreshToken(refresh: string): Promise<ClaudeTokenResult> {
  return postToken({
    grant_type: "refresh_token",
    refresh_token: refresh,
    client_id: CLAUDE_OAUTH.clientId,
  });
}

/** Build the `.credentials.json`-shaped blob Paperclip stores as a pool secret. */
export function buildCredentialsBlob(token: ClaudeTokenResult, subscriptionType?: string | null): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: token.expiresAt,
      scopes: token.scopes,
      ...(subscriptionType ? { subscriptionType } : {}),
    },
  });
}

/** Split a pasted "CODE#STATE" string into its parts. */
export function parsePastedCode(pasted: string): { code: string; state: string | null } {
  const trimmed = pasted.trim();
  const hash = trimmed.indexOf("#");
  if (hash === -1) return { code: trimmed, state: null };
  return { code: trimmed.slice(0, hash), state: trimmed.slice(hash + 1) };
}
