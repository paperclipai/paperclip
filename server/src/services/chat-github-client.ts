import { createPrivateKey, createSign } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  chatEndpoints,
  companySecretBindings,
  companySecrets,
  toolConnections,
  type Db,
} from "@paperclipai/db";
import { secretService } from "./secrets.js";
import { HttpError, conflict, forbidden, unprocessable } from "../errors.js";
import { githubPublicationRetry, githubProviderRetry, GITHUB_INLINE_RETRY_WINDOW_MS, GITHUB_INLINE_MAX_ATTEMPTS } from "./chat-channels/github/retry.js";

export function githubAppJwt(
  appId: string,
  privateKey: string,
  now = new Date(),
): string {
  const epoch = Math.floor(now.getTime() / 1000);
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: epoch - 60, exp: epoch + 540, iss: appId })}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(createPrivateKey(privateKey)).toString("base64url")}`;
}

/** Fixed origin, no redirects, bounded responses, no credential-bearing errors. */
export async function githubBotRequest<T>(
  fetchImpl: typeof fetch,
  token: string | null,
  path: string,
  options: { method?: string; body?: unknown; accept?: string } = {},
): Promise<T> {
  const deadline = Date.now() + GITHUB_INLINE_RETRY_WINDOW_MS;
  const safeToRetry = (options.method ?? "GET") === "GET" ||
    (options.method === "POST" && /^\/app\/installations\/[1-9][0-9]*\/access_tokens$/.test(path));
  for (let attempt = 1; ; attempt++) {
    try {
      return await githubBotRequestOnce<T>(fetchImpl, token, path, options, Math.min(25_000, Math.max(1, deadline - Date.now())));
    } catch (error) {
      const retry = githubPublicationRetry(error, attempt);
      const delay = Date.parse(retry.retryAt) - Date.now();
      if (!safeToRetry || !retry.retryable || attempt >= GITHUB_INLINE_MAX_ATTEMPTS || Date.now() + delay >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

async function githubBotRequestOnce<T>(
  fetchImpl: typeof fetch,
  token: string | null,
  path: string,
  options: { method?: string; body?: unknown; accept?: string },
  timeoutMs: number,
): Promise<T> {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    path.split("/").includes("..")
  )
    throw forbidden("Invalid GitHub operation path");
  let response: Response;
  try {
    response = await fetchImpl(`https://api.github.com${path}`, {
      method: options.method ?? "GET",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        accept: options.accept ?? "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(options.body !== undefined
          ? { "content-type": "application/json" }
          : {}),
      },
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
    });
  } catch {
    throw unprocessable(
      "GitHub is temporarily unavailable. Retry this operation.",
      { code: "github_bot_temporarily_unavailable", retryable: true },
    );
  }
  if (!response.ok) {
    let secondaryRateLimit = false;
    if (response.status === 403) {
      const reader = response.body?.getReader();
      try {
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (reader) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 8192) break;
          chunks.push(part.value);
        }
        secondaryRateLimit = /secondary rate limit|rate limit exceeded|abuse detection/i.test(Buffer.concat(chunks).toString("utf8"));
      } catch {
      } finally {
        await reader?.cancel().catch(() => {});
        reader?.releaseLock();
      }
    }
    await response.body?.cancel();
    throw unprocessable(
      `GitHub rejected this operation (HTTP ${response.status}).`,
      githubProviderRetry(response, secondaryRateLimit),
    );
  }
  if (response.status === 204) return undefined as T;
  const reader = response.body?.getReader();
  if (!reader) throw unprocessable("GitHub returned an empty response", { code: "github_bot_invalid_response", retryable: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 8 * 1024 * 1024)
        throw unprocessable(
          "GitHub response exceeds the review limit. Narrow the request or report incomplete coverage.",
        );
      chunks.push(part.value);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    try {
      return (options.accept?.includes("diff") ? body : JSON.parse(body)) as T;
    } catch {
      throw unprocessable("GitHub returned an invalid response", { code: "github_bot_invalid_response", retryable: true });
    }
  } catch (error) {
    if (error instanceof Error && "status" in error) throw error;
    throw unprocessable("GitHub response was interrupted. Retry this operation.", { code: "github_bot_temporarily_unavailable", retryable: true });
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Resolve only this endpoint's vaulted App. Never consult personal grants. */
export async function githubBotCredentials(
  db: Db,
  companyId: string,
  endpointId: string,
) {
  const [row] = await db
    .select({ endpoint: chatEndpoints, connection: toolConnections })
    .from(chatEndpoints)
    .innerJoin(
      toolConnections,
      and(
        eq(toolConnections.id, chatEndpoints.connectionId),
        eq(toolConnections.companyId, companyId),
      ),
    )
    .where(
      and(
        eq(chatEndpoints.companyId, companyId),
        eq(chatEndpoints.id, endpointId),
        eq(chatEndpoints.provider, "github"),
      ),
    );
  if (!row || ["archived", "revoked", "paused"].includes(row.endpoint.status))
    throw conflict("GitHub bot connection is unavailable");
  const secrets = secretService(db);
  const credentials: Record<string, string> = {};
  for (const key of [
    "appId",
    "privateKey",
    "installationId",
    "webhookSecret",
    "clientId",
    "clientSecret",
    "identityCodeVerifier",
  ]) {
    const ref = row.connection.credentialSecretRefs.find(
      (r) => r.configPath === `credentials.${key}`,
    );
    if (!ref) continue;
    credentials[key] = await secrets.resolveSecretValue(
      companyId,
      ref.secretId,
      ref.versionSelector ?? "latest",
      {
        consumerType: "tool_connection",
        consumerId: row.connection.id,
        configPath: ref.configPath,
        actorType: "system",
        actorId: null,
      },
    );
  }
  if (!credentials.appId || !credentials.privateKey)
    throw conflict("Connect the GitHub App before continuing");
  return {
    ...row,
    credentials,
    appJwt: githubAppJwt(credentials.appId, credentials.privateKey),
  };
}

const GITHUB_REPOSITORY_TOKEN_PERMISSIONS = {
  contents: "read",
  metadata: "read",
  issues: "write",
  pull_requests: "write",
  checks: "write",
} as const;
/** Only these secrets are needed to mint; the App's other credentials are not read here. */
const GITHUB_MINT_CREDENTIALS = ["appId", "privateKey", "installationId"] as const;
const GITHUB_REPOSITORY_TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
const GITHUB_REPOSITORY_TOKEN_MAX_LIFETIME_MS = 60 * 60_000;
const GITHUB_REPOSITORY_TOKEN_CACHE_LIMIT = 512;

type CachedRepositoryToken = { token: string; endpointId: string; refreshAt: number };
type RepositoryToken = { token: string; key: string; cached: boolean };

// Per process and in memory only. Tokens are never persisted or logged.
const repositoryTokens = new Map<string, CachedRepositoryToken>();

function forgetEndpointRepositoryTokens(endpointId: string) {
  for (const [key, entry] of repositoryTokens)
    if (entry.endpointId === endpointId) repositoryTokens.delete(key);
}

function rememberRepositoryToken(key: string, entry: CachedRepositoryToken) {
  repositoryTokens.delete(key);
  if (repositoryTokens.size >= GITHUB_REPOSITORY_TOKEN_CACHE_LIMIT) {
    const now = Date.now();
    for (const [stale, cached] of repositoryTokens)
      if (cached.refreshAt <= now) repositoryTokens.delete(stale);
  }
  // Map order is least recently used first.
  for (const oldest of repositoryTokens.keys()) {
    if (repositoryTokens.size < GITHUB_REPOSITORY_TOKEN_CACHE_LIMIT) break;
    repositoryTokens.delete(oldest);
  }
  repositoryTokens.set(key, entry);
}

/**
 * Current minting authority, read from the database on every call. The
 * revision covers everything that changes what a token may do: the endpoint's
 * runtime generation (bumped on pause, revoke and availability changes), the
 * connection, and each mint credential's secret ref, selected version, state
 * and binding. Any change makes every token cached under the old revision
 * unreachable. Secret values are not read here.
 */
async function githubBotRepositoryAuthority(
  db: Db,
  companyId: string,
  endpointId: string,
) {
  const [row] = await db
    .select({
      endpointStatus: chatEndpoints.status,
      runtimeGeneration: sql<unknown>`${chatEndpoints.setup}->'runtimeGeneration'`,
      connectionId: toolConnections.id,
      enabled: toolConnections.enabled,
      connectionStatus: toolConnections.status,
      refs: toolConnections.credentialSecretRefs,
    })
    .from(chatEndpoints)
    .innerJoin(
      toolConnections,
      and(
        eq(toolConnections.id, chatEndpoints.connectionId),
        eq(toolConnections.companyId, companyId),
      ),
    )
    .where(
      and(
        eq(chatEndpoints.companyId, companyId),
        eq(chatEndpoints.id, endpointId),
        eq(chatEndpoints.provider, "github"),
      ),
    );
  if (!row || ["archived", "revoked", "paused"].includes(row.endpointStatus))
    throw conflict("GitHub bot connection is unavailable");
  const [appId, privateKey, installationId] = GITHUB_MINT_CREDENTIALS.map(
    (key) => row.refs.find((ref) => ref.configPath === `credentials.${key}`),
  );
  if (!appId || !privateKey)
    throw conflict("Connect the GitHub App before continuing");
  if (
    !row.enabled ||
    row.connectionStatus !== "active" ||
    !["active", "verifying"].includes(row.endpointStatus)
  )
    throw conflict("GitHub bot connection is not active");
  if (!installationId) throw conflict("Verify the GitHub App installation first");
  const refs = [appId, privateKey, installationId];
  const secrets = await db
    .select({
      id: companySecrets.id,
      status: companySecrets.status,
      latestVersion: companySecrets.latestVersion,
      updatedAt: companySecrets.updatedAt,
      bindingId: companySecretBindings.id,
      bindingPath: companySecretBindings.configPath,
      bindingSelector: companySecretBindings.versionSelector,
      bindingUpdatedAt: companySecretBindings.updatedAt,
    })
    .from(companySecrets)
    .leftJoin(
      companySecretBindings,
      and(
        eq(companySecretBindings.secretId, companySecrets.id),
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "tool_connection"),
        eq(companySecretBindings.targetId, row.connectionId),
      ),
    )
    .where(
      and(
        eq(companySecrets.companyId, companyId),
        inArray(companySecrets.id, [...new Set(refs.map((ref) => ref.secretId))]),
      ),
    );
  const revision = JSON.stringify([
    row.connectionId,
    row.runtimeGeneration ?? 0,
    refs.map((ref) => {
      const selector = ref.versionSelector ?? "latest";
      const secret = secrets.find((candidate) => candidate.id === ref.secretId);
      const binding = secrets.find(
        (candidate) =>
          candidate.id === ref.secretId && candidate.bindingPath === ref.configPath,
      );
      return [
        ref.configPath,
        ref.secretId,
        selector,
        secret
          ? [
              secret.status,
              selector === "latest" ? secret.latestVersion : selector,
              secret.updatedAt.getTime(),
            ]
          : null,
        binding
          ? [binding.bindingId, binding.bindingSelector, binding.bindingUpdatedAt?.getTime()]
          : null,
      ];
    }),
  ]);
  return { connectionId: row.connectionId, refs, revision };
}

async function githubBotRepositoryTokenFor(
  db: Db,
  companyId: string,
  endpointId: string,
  repositoryId: string,
  fetchImpl: typeof fetch,
  options: { refresh?: boolean } = {},
): Promise<RepositoryToken> {
  let authority: Awaited<ReturnType<typeof githubBotRepositoryAuthority>>;
  try {
    authority = await githubBotRepositoryAuthority(db, companyId, endpointId);
  } catch (error) {
    // A connection that cannot mint must not keep its earlier tokens either.
    forgetEndpointRepositoryTokens(endpointId);
    throw error;
  }
  if (!/^[1-9][0-9]*$/.test(repositoryId) || !Number.isSafeInteger(Number(repositoryId)))
    throw conflict("Verify the GitHub App installation first");
  const key = JSON.stringify([
    companyId,
    endpointId,
    repositoryId,
    GITHUB_REPOSITORY_TOKEN_PERMISSIONS,
    authority.revision,
  ]);
  const cached = repositoryTokens.get(key);
  if (cached && !options.refresh && cached.refreshAt > Date.now()) {
    rememberRepositoryToken(key, cached);
    return { token: cached.token, key, cached: true };
  }
  if (cached) repositoryTokens.delete(key);
  // Resolve (and audit) the App's secrets only when a token is actually minted.
  const secrets = secretService(db);
  const values: string[] = [];
  for (const ref of authority.refs)
    values.push(
      await secrets.resolveSecretValue(
        companyId,
        ref.secretId,
        ref.versionSelector ?? "latest",
        {
          consumerType: "tool_connection",
          consumerId: authority.connectionId,
          configPath: ref.configPath,
          actorType: "system",
          actorId: null,
        },
      ),
    );
  const [appId, privateKey, installationId] = values;
  if (!appId || !privateKey)
    throw conflict("Connect the GitHub App before continuing");
  if (!installationId) throw conflict("Verify the GitHub App installation first");
  const issued = await githubBotRequest<{ token?: string; expires_at?: string }>(
    fetchImpl,
    githubAppJwt(appId, privateKey),
    `/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    {
      method: "POST",
      body: {
        repository_ids: [Number(repositoryId)],
        permissions: GITHUB_REPOSITORY_TOKEN_PERMISSIONS,
      },
    },
  );
  if (!issued.token)
    throw unprocessable("GitHub did not issue an installation token");
  const now = Date.now();
  const refreshAt =
    Math.min(
      Date.parse(issued.expires_at ?? ""),
      now + GITHUB_REPOSITORY_TOKEN_MAX_LIFETIME_MS,
    ) - GITHUB_REPOSITORY_TOKEN_REFRESH_MARGIN_MS;
  // Without a usable expiry the token serves this call only.
  if (Number.isFinite(refreshAt) && refreshAt > now)
    rememberRepositoryToken(key, { token: issued.token, endpointId, refreshAt });
  return { token: issued.token, key, cached: false };
}

/**
 * Least-privilege short-lived token restricted to the single task repository.
 * Reused until shortly before GitHub's expiry while the connection's current
 * authority is unchanged.
 */
export async function githubBotRepositoryToken(
  db: Db,
  companyId: string,
  endpointId: string,
  repositoryId: string,
  fetchImpl = fetch,
) {
  return (
    await githubBotRepositoryTokenFor(db, companyId, endpointId, repositoryId, fetchImpl)
  ).token;
}

export type GitHubBotRepositoryRequest = <T>(
  path: string,
  options?: Parameters<typeof githubBotRequest>[3],
) => Promise<T>;

function githubUnauthorized(error: unknown) {
  return (
    error instanceof HttpError &&
    !!error.details &&
    typeof error.details === "object" &&
    (error.details as { providerStatus?: unknown }).providerStatus === 401
  );
}

/**
 * GitHub requests with a repository token. When GitHub rejects a cached token
 * (401), that token is dropped and the request is sent once more with a newly
 * minted one. GitHub did not act on the rejected request, so the retry is safe.
 */
export async function githubBotRepositoryClient(
  db: Db,
  companyId: string,
  endpointId: string,
  repositoryId: string,
  fetchImpl = fetch,
): Promise<GitHubBotRepositoryRequest> {
  let current = Promise.resolve(
    await githubBotRepositoryTokenFor(db, companyId, endpointId, repositoryId, fetchImpl),
  );
  return async <T>(path: string, options?: Parameters<typeof githubBotRequest>[3]) => {
    const used = current;
    const issued = await used;
    try {
      return await githubBotRequest<T>(fetchImpl, issued.token, path, options);
    } catch (error) {
      if (!issued.cached || !githubUnauthorized(error)) throw error;
      if (current === used) {
        if (repositoryTokens.get(issued.key)?.token === issued.token)
          repositoryTokens.delete(issued.key);
        current = githubBotRepositoryTokenFor(
          db,
          companyId,
          endpointId,
          repositoryId,
          fetchImpl,
          { refresh: true },
        );
      }
      return githubBotRequest<T>(fetchImpl, (await current).token, path, options);
    }
  };
}
