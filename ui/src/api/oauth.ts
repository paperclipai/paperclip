// OAuth connections API client.
//
// Translations are inlined as constants (see ./strings.ts) because the repo
// does not currently use an i18n loader. Introducing one for a single page is
// not justified — extract to a shared loader if/when other pages adopt i18n.

export type ConnectionStatus = "active" | "expired" | "revoked" | "error";

export interface ProviderSummary {
  id: string;
  displayName: string;
  iconUrl?: string;
  docUrl?: string;
  scopesDefault: string[];
  scopesOffered: string[];
}

export interface ConnectionSummary {
  id: string;
  providerId: string;
  status: ConnectionStatus;
  accountId: string | null;
  accountLabel: string | null;
  scopes: string[];
  accessTokenExpiresAt: string | null;
  lastRefreshedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  refreshAttemptCount: number;
}

interface Opts {
  fetch?: typeof fetch;
}

function fetchImpl(opts: Opts) {
  // The server routes set credentials cookies and 'fetch' is mockable in tests.
  return opts.fetch ?? fetch;
}

export async function listProviders(
  companyId: string,
  opts: Opts = {},
): Promise<{ providers: ProviderSummary[] }> {
  const f = fetchImpl(opts);
  const r = await f(`/api/companies/${encodeURIComponent(companyId)}/oauth/providers`, {
    credentials: "include",
  });
  if (!r.ok) throw new Error(`listProviders ${r.status}`);
  return r.json();
}

export async function listConnections(
  companyId: string,
  opts: Opts = {},
): Promise<{ connections: ConnectionSummary[] }> {
  const f = fetchImpl(opts);
  const r = await f(`/api/companies/${encodeURIComponent(companyId)}/oauth/connections`, {
    credentials: "include",
  });
  if (!r.ok) throw new Error(`listConnections ${r.status}`);
  return r.json();
}

export async function startConnect(
  companyId: string,
  providerId: string,
  body: { returnUrl?: string; scopes?: string[] },
  opts: Opts = {},
): Promise<{ authorizeUrl: string; state: string }> {
  const f = fetchImpl(opts);
  const r = await f(
    `/api/companies/${encodeURIComponent(companyId)}/oauth/connect/${encodeURIComponent(providerId)}`,
    {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!r.ok) {
    const err = (await r.json().catch(() => ({}))) as { errorCode?: string };
    throw new Error(err.errorCode ?? `connect ${r.status}`);
  }
  return r.json();
}

export async function refreshConnection(
  companyId: string,
  connectionId: string,
  opts: Opts = {},
): Promise<void> {
  const f = fetchImpl(opts);
  const r = await f(
    `/api/companies/${encodeURIComponent(companyId)}/oauth/connections/${encodeURIComponent(connectionId)}/refresh`,
    { method: "POST", credentials: "include" },
  );
  if (!r.ok) {
    const err = (await r.json().catch(() => ({}))) as { errorCode?: string };
    throw new Error(err.errorCode ?? `refresh ${r.status}`);
  }
}

export async function disconnectConnection(
  companyId: string,
  connectionId: string,
  opts: Opts = {},
): Promise<void> {
  const f = fetchImpl(opts);
  const r = await f(
    `/api/companies/${encodeURIComponent(companyId)}/oauth/connections/${encodeURIComponent(connectionId)}`,
    { method: "DELETE", credentials: "include" },
  );
  if (!r.ok) {
    const err = (await r.json().catch(() => ({}))) as { errorCode?: string };
    throw new Error(err.errorCode ?? `disconnect ${r.status}`);
  }
}
