import { createSign } from "node:crypto";
import { unprocessable } from "../../errors.js";
import type {
  GitHubAppTransport,
  GitHubInstallation,
  GitHubInstallationToken,
  GitHubRepository,
} from "./github-provider.js";

/**
 * Real GitHub App transport. Encapsulates App JWT minting (RS256 with the app
 * private key), installation-token exchange, and the installation REST calls the
 * provider needs. The private key and minted tokens live only inside this
 * transport; nothing here is persisted or returned to callers except the
 * short-lived installation token surfaced through the provider's credential
 * resolution (which the connection service never stores).
 */

export interface GitHubAppTransportConfig {
  appId: string;
  /** PEM-encoded RSA private key for the GitHub App. */
  privateKey: string;
  host?: string;
  apiBaseUrl?: string;
  /** Clock skew allowance in seconds for the app JWT `iat`. */
  clockSkewSeconds?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

interface CachedToken {
  token: string;
  expiresAt: Date;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function createGitHubAppTransport(config: GitHubAppTransportConfig): GitHubAppTransport {
  if (!config.appId) throw unprocessable("GitHub App id is required");
  if (!config.privateKey) throw unprocessable("GitHub App private key is required");
  const host = (config.host ?? "github.com").toLowerCase();
  const apiBaseUrl = (config.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, "");
  const doFetch = config.fetchImpl ?? fetch;
  const now = config.now ?? (() => new Date());
  const skew = config.clockSkewSeconds ?? 30;
  const tokenCache = new Map<string, CachedToken>();

  function mintAppJwt(): string {
    const iat = Math.floor(now().getTime() / 1000) - skew;
    const exp = iat + 9 * 60; // GitHub caps app JWTs at 10 minutes.
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = base64url(JSON.stringify({ iat, exp, iss: config.appId }));
    const signingInput = `${header}.${payload}`;
    const signature = createSign("RSA-SHA256").update(signingInput).sign(config.privateKey).toString("base64url");
    return `${signingInput}.${signature}`;
  }

  async function appRequest<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await doFetch(`${apiBaseUrl}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${mintAppJwt()}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init?.headers ?? {}),
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub app request ${path} failed with ${response.status}`);
    }
    return (await response.json()) as T;
  }

  async function installationToken(installationId: string): Promise<string> {
    const cached = tokenCache.get(installationId);
    // Refresh a minute before expiry to avoid using a token mid-request.
    if (cached && cached.expiresAt.getTime() - now().getTime() > 60_000) return cached.token;
    const minted = await createInstallationAccessToken(installationId);
    tokenCache.set(installationId, { token: minted.token, expiresAt: minted.expiresAt });
    return minted.token;
  }

  async function installationRequest<T>(installationId: string, path: string, init?: RequestInit): Promise<T> {
    const token = await installationToken(installationId);
    const response = await doFetch(`${apiBaseUrl}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init?.headers ?? {}),
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub installation request ${path} failed with ${response.status}`);
    }
    return (await response.json()) as T;
  }

  async function createInstallationAccessToken(installationId: string): Promise<GitHubInstallationToken> {
    const body = await appRequest<{ token: string; expires_at: string }>(
      `/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
      { method: "POST" },
    );
    return { token: body.token, expiresAt: new Date(body.expires_at) };
  }

  return {
    host,
    apiBaseUrl,

    async getInstallation(installationId: string): Promise<GitHubInstallation | null> {
      try {
        return await appRequest<GitHubInstallation>(`/app/installations/${encodeURIComponent(installationId)}`);
      } catch {
        return null;
      }
    },

    createInstallationAccessToken,

    async listRepositories(input) {
      const params = new URLSearchParams({ per_page: String(input.perPage), page: String(input.page) });
      const body = await installationRequest<{ total_count: number; repositories: GitHubRepository[] }>(
        input.installationId,
        `/installation/repositories?${params.toString()}`,
      );
      const query = input.query?.trim().toLowerCase();
      if (!query) {
        return { totalCount: body.total_count ?? null, items: body.repositories ?? [] };
      }
      // The installation-repositories endpoint has no server-side search; filter
      // the page client-side. total_count no longer reflects the filtered set.
      return {
        totalCount: null,
        items: (body.repositories ?? []).filter((repo) => repo.full_name.toLowerCase().includes(query)),
      };
    },

    async getRepository(input) {
      try {
        return await installationRequest<GitHubRepository>(
          input.installationId,
          `/repositories/${encodeURIComponent(input.providerRepositoryId)}`,
        );
      } catch {
        return null;
      }
    },
  };
}
