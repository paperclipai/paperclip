/**
 * Stored shape and refresh logic for a Claude subscription credential.
 *
 * `claude auth login` writes an access token (about 8 hours of life) and a
 * refresh token. The connection secret used to keep only the access token, so
 * the connection stopped working when the token expired. The secret now keeps
 * the OAuth fields. `resolveClaudeAccessToken` renews the token on the server
 * and returns only the access token, so the CLI never sees the refresh token.
 * A plain-string secret (the old format) is returned unchanged.
 */

export const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const CLAUDE_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
/** Renew when less than this time is left, so a long run does not outlive its token. */
export const CLAUDE_REFRESH_MARGIN_MS = 60 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 15_000;

export interface ClaudeOauthFields {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
  [key: string]: unknown;
}
export interface ClaudeOauthCredential {
  claudeAiOauth: ClaudeOauthFields;
  [key: string]: unknown;
}

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** Parse a stored value. Returns null for a plain token or for invalid JSON. */
export function parseClaudeOauthCredential(raw: string): ClaudeOauthCredential | null {
  if (!raw.trimStart().startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const oauth = (parsed as { claudeAiOauth?: unknown } | null)?.claudeAiOauth;
  if (!oauth || typeof oauth !== "object" || !nonEmpty((oauth as ClaudeOauthFields).accessToken)) return null;
  return parsed as ClaudeOauthCredential;
}

/** The token a run injects for a stored value: the access token, or the plain token itself. */
export function claudeAccessTokenOf(raw: string): string {
  return parseClaudeOauthCredential(raw)?.claudeAiOauth.accessToken ?? raw;
}

/**
 * The value to store at connect time. Keeps only the OAuth fields. Returns
 * null when there is no refresh token or expiry, so the caller keeps the
 * plain access token.
 */
export function storedClaudeCredential(oauth: unknown): string | null {
  const source = oauth as Partial<ClaudeOauthFields> | null | undefined;
  if (!source || !nonEmpty(source.accessToken) || !nonEmpty(source.refreshToken)) return null;
  if (typeof source.expiresAt !== "number" || !Number.isFinite(source.expiresAt)) return null;
  const out: ClaudeOauthFields = {
    accessToken: source.accessToken,
    refreshToken: source.refreshToken,
    expiresAt: source.expiresAt,
  };
  if (Array.isArray(source.scopes)) out.scopes = source.scopes.filter((s): s is string => typeof s === "string");
  if (nonEmpty(source.subscriptionType)) out.subscriptionType = source.subscriptionType;
  if (nonEmpty(source.rateLimitTier)) out.rateLimitTier = source.rateLimitTier;
  return JSON.stringify({ claudeAiOauth: out });
}

export function claudeNeedsRefresh(credential: ClaudeOauthCredential, now = Date.now()): boolean {
  const { refreshToken, expiresAt } = credential.claudeAiOauth;
  if (!nonEmpty(refreshToken) || typeof expiresAt !== "number") return false;
  return expiresAt - CLAUDE_REFRESH_MARGIN_MS <= now;
}

export class ClaudeOauthRefreshError extends Error {
  /** True when the provider refused the refresh token, so the user must sign in again. */
  readonly rejected: boolean;
  readonly status: number | null;
  constructor(message: string, options: { status?: number | null; rejected?: boolean } = {}) {
    super(message);
    this.name = "ClaudeOauthRefreshError";
    this.status = options.status ?? null;
    this.rejected = options.rejected ?? false;
  }
}

export async function refreshClaudeOauthCredential(
  credential: ClaudeOauthCredential,
  options: { fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<ClaudeOauthCredential> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const oauth = credential.claudeAiOauth;
  const body: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: oauth.refreshToken as string,
    client_id: CLAUDE_OAUTH_CLIENT_ID,
  };
  if (Array.isArray(oauth.scopes) && oauth.scopes.length > 0) body.scope = oauth.scopes.join(" ");
  let response: Response;
  try {
    response = await fetchImpl(CLAUDE_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
  } catch {
    // Never include the underlying error: it can echo request data.
    throw new ClaudeOauthRefreshError("Claude OAuth refresh could not reach the provider");
  }
  let payload: Record<string, unknown> | null = null;
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    // A non-JSON body: only the status matters.
  }
  if (!response.ok) {
    const code = typeof payload?.error === "string" && /^[a-z_]{1,40}$/.test(payload.error) ? payload.error : null;
    throw new ClaudeOauthRefreshError(
      `Claude OAuth refresh failed with HTTP ${response.status}${code ? ` (${code})` : ""}`,
      { status: response.status, rejected: [400, 401, 403].includes(response.status) },
    );
  }
  if (!nonEmpty(payload?.access_token) || typeof payload?.expires_in !== "number") {
    throw new ClaudeOauthRefreshError("Claude OAuth refresh returned an unexpected response", {
      status: response.status,
    });
  }
  const next: ClaudeOauthFields = {
    ...oauth,
    accessToken: payload.access_token,
    // The provider rotates the refresh token. If it sends none, the old one stays valid.
    refreshToken: nonEmpty(payload.refresh_token) ? payload.refresh_token : oauth.refreshToken,
    expiresAt: now() + payload.expires_in * 1000,
  };
  if (nonEmpty(payload.scope)) next.scopes = payload.scope.split(/\s+/).filter(Boolean);
  return { ...credential, claudeAiOauth: next };
}

export interface ClaudeCredentialLock {
  readRaw(): Promise<string>;
  writeRaw(value: string): Promise<unknown>;
}

/**
 * Return the access token to inject. `withLock` runs its callback while it
 * holds a lock on the secret row, so two runs cannot spend the same rotating
 * refresh token.
 */
export async function resolveClaudeAccessToken(
  raw: string,
  options: {
    withLock: <T>(fn: (lock: ClaudeCredentialLock) => Promise<T>) => Promise<T>;
    fetchImpl?: typeof fetch;
    now?: () => number;
  },
): Promise<string> {
  const now = options.now ?? Date.now;
  const credential = parseClaudeOauthCredential(raw);
  if (!credential) return raw;
  if (!claudeNeedsRefresh(credential, now())) return credential.claudeAiOauth.accessToken;
  return options.withLock(async ({ readRaw, writeRaw }) => {
    // Another run can renew the token while this run waits for the lock.
    const latest = parseClaudeOauthCredential(await readRaw()) ?? credential;
    if (!claudeNeedsRefresh(latest, now())) return latest.claudeAiOauth.accessToken;
    let next: ClaudeOauthCredential;
    try {
      next = await refreshClaudeOauthCredential(latest, { fetchImpl: options.fetchImpl, now });
    } catch (error) {
      // A transient failure while the current token is still valid: use the current token.
      if (
        error instanceof ClaudeOauthRefreshError &&
        !error.rejected &&
        (latest.claudeAiOauth.expiresAt ?? 0) > now()
      ) {
        return latest.claudeAiOauth.accessToken;
      }
      throw error;
    }
    await writeRaw(JSON.stringify(next));
    return next.claudeAiOauth.accessToken;
  });
}
