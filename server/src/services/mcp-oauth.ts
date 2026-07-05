import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import net from "node:net";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { notFound, unprocessable } from "../errors.js";
import { agentService } from "./agents.js";
import { secretService } from "./secrets.js";

/**
 * SSRF guard. The OAuth broker fetches URLs derived from the agent-controlled
 * MCP server URL (discovery documents, then the authorization-server endpoints
 * those documents point at). A malicious/compromised config could aim those at
 * the host's own metadata service or internal network, so every server-side
 * fetch resolves the host and rejects private, loopback, link-local, and
 * unique-local addresses.
 */
function ipv4ToParts(address: string): number[] | null {
  const parts = address.split(".").map((part) => Number(part));
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ? parts
    : null;
}

function isPrivateAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) {
    const parts = ipv4ToParts(address);
    if (!parts) return true;
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local (incl. 169.254.169.254 metadata)
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (family === 6) {
    const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
    if (normalized === "::1" || normalized === "::") return true;
    if (normalized.startsWith("fe80")) return true; // link-local
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // unique-local
    // IPv4-mapped IPv6 (::ffff:a.b.c.d)
    const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true; // not a recognizable IP literal
}

async function assertPublicHttpUrl(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw unprocessable(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw unprocessable(`Refusing to fetch non-http(s) URL: ${rawUrl}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw unprocessable(`Refusing to fetch internal host: ${host}`);
  }
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) {
      throw unprocessable(`Refusing to fetch private address: ${host}`);
    }
    return;
  }
  let resolved: Array<{ address: string }>;
  try {
    resolved = await lookup(host, { all: true });
  } catch {
    throw unprocessable(`Could not resolve host: ${host}`);
  }
  if (resolved.length === 0 || resolved.some((entry) => isPrivateAddress(entry.address))) {
    throw unprocessable(`Refusing to fetch host resolving to a private address: ${host}`);
  }
}

/**
 * OAuth 2.1 broker for remote MCP servers (MCP Authorization spec).
 *
 * Headless agents can't run interactive OAuth logins, so Paperclip brokers the
 * grant: a board user authorizes once in the UI, Paperclip performs the
 * authorization-code + PKCE flow (with RFC 9728 protected-resource discovery,
 * RFC 8414 AS metadata, RFC 7591 dynamic client registration, and RFC 8707
 * resource indicators), stores the token payload as a company secret, and the
 * runtime resolver injects `Authorization: Bearer <access token>` into the
 * agent's MCP config. Refresh happens lazily before each run.
 *
 * Pending authorization state is held in memory with a short TTL — fine for
 * Paperclip's single-process deployments; a multi-node deployment would need
 * to pin the callback to the initiating node or persist challenges.
 */

const CHALLENGE_TTL_MS = 10 * 60 * 1000;
/** Refresh tokens that expire within this window before a run. */
const TOKEN_REFRESH_LEEWAY_MS = 5 * 60 * 1000;
const DISCOVERY_TIMEOUT_MS = 15_000;

export interface McpOauthTokenPayload {
  accessToken: string;
  refreshToken?: string;
  /** Epoch millis. Absent = treat as non-expiring. */
  expiresAt?: number;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  resource: string;
  scope?: string;
}

interface McpOauthChallenge {
  state: string;
  companyId: string;
  agentId: string;
  serverName: string;
  serverUrl: string;
  codeVerifier: string;
  clientId: string;
  clientSecret?: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  redirectUri: string;
  resource: string;
  scope?: string;
  createdAt: number;
}

const pendingChallenges = new Map<string, McpOauthChallenge>();

/**
 * Per-secret refresh serialization. Two runs of the same agent start
 * concurrently and would otherwise both POST grant_type=refresh_token with the
 * SAME refresh token — an OAuth 2.1 server that rotates refresh tokens treats
 * the second use as replay and revokes the whole grant. Coalesce concurrent
 * refreshers of a given token secret onto one in-flight promise; the second
 * caller re-reads the (now-rotated) secret and skips.
 */
const refreshInFlight = new Map<string, Promise<void>>();

function withRefreshLock(secretId: string, fn: () => Promise<void>): Promise<void> {
  const prior = refreshInFlight.get(secretId) ?? Promise.resolve();
  const next = prior.catch(() => undefined).then(fn);
  refreshInFlight.set(secretId, next);
  void next.finally(() => {
    if (refreshInFlight.get(secretId) === next) refreshInFlight.delete(secretId);
  });
  return next;
}

function prunePendingChallenges() {
  const now = Date.now();
  for (const [state, challenge] of pendingChallenges) {
    if (now - challenge.createdAt > CHALLENGE_TTL_MS) pendingChallenges.delete(state);
  }
}

function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function fetchJson(url: string, init?: RequestInit): Promise<Record<string, unknown> | null> {
  try {
    await assertPublicHttpUrl(url);
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      headers: { Accept: "application/json", ...(init?.headers ?? {}) },
    });
    if (!response.ok) return null;
    const parsed = (await response.json()) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readString(record: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Well-known URL candidates honoring path components per RFC 8414 / RFC 9728
 * (path-aware form first, then root form, then OIDC discovery for AS metadata).
 */
function wellKnownCandidates(baseUrl: string, suffix: string, includeOidc = false): string[] {
  const url = new URL(baseUrl);
  const pathname = url.pathname.replace(/\/$/, "");
  const candidates: string[] = [];
  if (pathname && pathname !== "") {
    candidates.push(`${url.origin}/.well-known/${suffix}${pathname}`);
  }
  candidates.push(`${url.origin}/.well-known/${suffix}`);
  if (includeOidc) {
    if (pathname && pathname !== "") {
      candidates.push(`${url.origin}${pathname}/.well-known/openid-configuration`);
    }
    candidates.push(`${url.origin}/.well-known/openid-configuration`);
  }
  return candidates;
}

export interface McpAuthorizationServerMetadata {
  issuer: string | null;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  scopesSupported: string[];
}

/**
 * Discover the authorization server for an MCP server URL:
 * 1. RFC 9728 protected-resource metadata (well-known, path-aware).
 * 2. Fallback: 401 response's WWW-Authenticate `resource_metadata` parameter.
 * 3. Fallback: treat the MCP origin itself as the authorization server.
 * Then fetch RFC 8414 / OIDC metadata from the discovered AS.
 */
export async function discoverMcpAuthorizationServer(
  serverUrl: string,
): Promise<McpAuthorizationServerMetadata> {
  let resourceMetadata: Record<string, unknown> | null = null;
  for (const candidate of wellKnownCandidates(serverUrl, "oauth-protected-resource")) {
    resourceMetadata = await fetchJson(candidate);
    if (resourceMetadata) break;
  }

  if (!resourceMetadata) {
    try {
      await assertPublicHttpUrl(serverUrl);
      const probe = await fetch(serverUrl, {
        method: "GET",
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
        headers: { Accept: "application/json, text/event-stream" },
      });
      const wwwAuthenticate = probe.headers.get("www-authenticate") ?? "";
      const match = wwwAuthenticate.match(/resource_metadata="([^"]+)"/i);
      if (match?.[1]) {
        resourceMetadata = await fetchJson(match[1]);
      }
    } catch {
      // ignore; fall through to origin-as-AS
    }
  }

  const authorizationServers = Array.isArray(resourceMetadata?.authorization_servers)
    ? (resourceMetadata?.authorization_servers as unknown[]).filter(
        (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
      )
    : [];
  const authorizationServerUrl = authorizationServers[0] ?? new URL(serverUrl).origin;

  let asMetadata: Record<string, unknown> | null = null;
  for (const candidate of wellKnownCandidates(authorizationServerUrl, "oauth-authorization-server", true)) {
    asMetadata = await fetchJson(candidate);
    if (asMetadata?.authorization_endpoint && asMetadata?.token_endpoint) break;
    asMetadata = null;
  }
  if (!asMetadata) {
    throw unprocessable(
      `Could not discover OAuth authorization server metadata for ${serverUrl}. ` +
        "The MCP server may not support OAuth — use an API key (bearer/header secret) instead.",
    );
  }

  const authorizationEndpoint = readString(asMetadata, "authorization_endpoint");
  const tokenEndpoint = readString(asMetadata, "token_endpoint");
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw unprocessable(`Authorization server metadata for ${serverUrl} is missing endpoints`);
  }

  return {
    issuer: readString(asMetadata, "issuer"),
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint: readString(asMetadata, "registration_endpoint"),
    scopesSupported: Array.isArray(asMetadata.scopes_supported)
      ? (asMetadata.scopes_supported as unknown[]).filter(
          (scope): scope is string => typeof scope === "string",
        )
      : [],
  };
}

/** RFC 7591 dynamic client registration as a public client (PKCE, no secret). */
async function registerOauthClient(input: {
  registrationEndpoint: string;
  redirectUri: string;
}): Promise<{ clientId: string; clientSecret?: string }> {
  await assertPublicHttpUrl(input.registrationEndpoint);
  const response = await fetch(input.registrationEndpoint, {
    method: "POST",
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "Paperclip",
      redirect_uris: [input.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw unprocessable(
      `Dynamic client registration failed (${response.status}): ${body.slice(0, 300)}`,
    );
  }
  const registration = (await response.json()) as Record<string, unknown>;
  const clientId = readString(registration, "client_id");
  if (!clientId) throw unprocessable("Dynamic client registration returned no client_id");
  return {
    clientId,
    clientSecret: readString(registration, "client_secret") ?? undefined,
  };
}

interface TokenEndpointResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
}

async function callTokenEndpoint(
  tokenEndpoint: string,
  params: Record<string, string>,
  clientSecret?: string,
): Promise<TokenEndpointResult> {
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${params.client_id}:${clientSecret}`).toString("base64")}`;
    body.delete("client_id");
  }
  await assertPublicHttpUrl(tokenEndpoint);
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    headers,
    body: body.toString(),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw unprocessable(`Token endpoint returned ${response.status}: ${raw.slice(0, 300)}`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw unprocessable("Token endpoint returned a non-JSON response");
  }
  const accessToken = readString(parsed, "access_token");
  if (!accessToken) throw unprocessable("Token endpoint returned no access_token");
  const expiresIn = typeof parsed.expires_in === "number" ? parsed.expires_in : null;
  return {
    accessToken,
    refreshToken: readString(parsed, "refresh_token") ?? undefined,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
    scope: readString(parsed, "scope") ?? undefined,
  };
}

function parseTokenPayload(raw: string): McpOauthTokenPayload | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const accessToken = readString(parsed, "accessToken");
    const tokenEndpoint = readString(parsed, "tokenEndpoint");
    const clientId = readString(parsed, "clientId");
    const resource = readString(parsed, "resource");
    if (!accessToken || !tokenEndpoint || !clientId || !resource) return null;
    return {
      accessToken,
      refreshToken: readString(parsed, "refreshToken") ?? undefined,
      expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : undefined,
      tokenEndpoint,
      clientId,
      clientSecret: readString(parsed, "clientSecret") ?? undefined,
      resource,
      scope: readString(parsed, "scope") ?? undefined,
    };
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function mcpOauthService(db: Db) {
  const agents = agentService(db);
  const secrets = secretService(db);

  async function persistTokenForServer(input: {
    challenge: Pick<
      McpOauthChallenge,
      "companyId" | "agentId" | "serverName" | "tokenEndpoint" | "clientId" | "clientSecret" | "resource"
    >;
    token: TokenEndpointResult;
    actor?: { userId?: string | null; agentId?: string | null };
  }): Promise<{ secretId: string }> {
    const { challenge, token } = input;
    const payload: McpOauthTokenPayload = {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: token.expiresAt,
      tokenEndpoint: challenge.tokenEndpoint,
      clientId: challenge.clientId,
      clientSecret: challenge.clientSecret,
      resource: challenge.resource,
      scope: token.scope,
    };
    const serialized = JSON.stringify(payload);

    const agent = await agents.getById(challenge.agentId);
    if (!agent) throw notFound("Agent not found");
    const adapterConfig = asRecord(agent.adapterConfig) ?? {};
    const mcpServers = asRecord(adapterConfig.mcpServers) ?? {};
    const server = asRecord(mcpServers[challenge.serverName]);
    if (!server) throw notFound(`MCP server not found: ${challenge.serverName}`);

    const existingAuth = asRecord(server.auth);
    const existingSecretId =
      existingAuth?.type === "oauth" && typeof existingAuth.secretId === "string"
        ? existingAuth.secretId
        : null;

    let secretId: string;
    if (existingSecretId) {
      await secrets.rotate(existingSecretId, { value: serialized }, input.actor);
      secretId = existingSecretId;
    } else {
      // Random suffix so a reconnect never 409s against an orphaned token
      // secret whose binding was dropped (e.g. after an adapter-type switch).
      const created = await secrets.create(
        challenge.companyId,
        {
          name: `mcp-oauth-${challenge.serverName}-${challenge.agentId.slice(0, 8)}-${base64UrlEncode(randomBytes(4))}`,
          provider: "local_encrypted",
          value: serialized,
          description: `OAuth token for MCP server "${challenge.serverName}" (agent ${challenge.agentId})`,
        },
        input.actor,
      );
      secretId = created.id;
    }

    const nextServer = { ...server, auth: { type: "oauth", secretId } };
    const nextAdapterConfig = {
      ...adapterConfig,
      mcpServers: { ...mcpServers, [challenge.serverName]: nextServer },
    };
    await agents.update(challenge.agentId, { adapterConfig: nextAdapterConfig }, {
      recordRevision: {
        createdByAgentId: input.actor?.agentId ?? null,
        createdByUserId: input.actor?.userId ?? null,
        source: "mcp_oauth",
      },
    });
    await secrets.syncMcpBindingsForTarget(
      challenge.companyId,
      { targetType: "agent", targetId: challenge.agentId },
      nextAdapterConfig.mcpServers,
    );
    return { secretId };
  }

  return {
    /**
     * Begin the brokered flow for one agent + server. Returns the authorize
     * URL the board user's browser should open.
     */
    startAuthorization: async (input: {
      companyId: string;
      agentId: string;
      serverName: string;
      serverUrl: string;
      redirectUri: string;
      scope?: string;
    }): Promise<{ authorizeUrl: string; state: string }> => {
      prunePendingChallenges();
      const metadata = await discoverMcpAuthorizationServer(input.serverUrl);
      if (!metadata.registrationEndpoint) {
        throw unprocessable(
          `The authorization server for ${input.serverUrl} does not support dynamic client ` +
            "registration. Use an API key (bearer/header secret) for this server instead.",
        );
      }
      const client = await registerOauthClient({
        registrationEndpoint: metadata.registrationEndpoint,
        redirectUri: input.redirectUri,
      });

      const state = base64UrlEncode(randomBytes(32));
      const codeVerifier = base64UrlEncode(randomBytes(48));
      const codeChallenge = base64UrlEncode(createHash("sha256").update(codeVerifier).digest());
      const scope = input.scope ?? (metadata.scopesSupported.length > 0
        ? metadata.scopesSupported.join(" ")
        : undefined);

      const challenge: McpOauthChallenge = {
        state,
        companyId: input.companyId,
        agentId: input.agentId,
        serverName: input.serverName,
        serverUrl: input.serverUrl,
        codeVerifier,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        authorizationEndpoint: metadata.authorizationEndpoint,
        tokenEndpoint: metadata.tokenEndpoint,
        redirectUri: input.redirectUri,
        resource: input.serverUrl,
        scope,
        createdAt: Date.now(),
      };
      pendingChallenges.set(state, challenge);

      const authorizeUrl = new URL(metadata.authorizationEndpoint);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", client.clientId);
      authorizeUrl.searchParams.set("redirect_uri", input.redirectUri);
      authorizeUrl.searchParams.set("state", state);
      authorizeUrl.searchParams.set("code_challenge", codeChallenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
      authorizeUrl.searchParams.set("resource", input.serverUrl);
      if (scope) authorizeUrl.searchParams.set("scope", scope);

      return { authorizeUrl: authorizeUrl.toString(), state };
    },

    /** Redeem the authorization code from the browser redirect. */
    handleCallback: async (input: {
      state: string;
      code: string;
      actor?: { userId?: string | null; agentId?: string | null };
    }): Promise<{ agentId: string; serverName: string; secretId: string }> => {
      prunePendingChallenges();
      const challenge = pendingChallenges.get(input.state);
      if (!challenge) {
        throw notFound("Unknown or expired OAuth state. Restart the connection from the agent page.");
      }
      pendingChallenges.delete(input.state);

      const token = await callTokenEndpoint(
        challenge.tokenEndpoint,
        {
          grant_type: "authorization_code",
          code: input.code,
          redirect_uri: challenge.redirectUri,
          client_id: challenge.clientId,
          code_verifier: challenge.codeVerifier,
          resource: challenge.resource,
        },
        challenge.clientSecret,
      );

      const { secretId } = await persistTokenForServer({ challenge, token, actor: input.actor });
      return { agentId: challenge.agentId, serverName: challenge.serverName, secretId };
    },

    /**
     * Refresh any OAuth MCP tokens for this agent that expire within the
     * leeway window. Called by the heartbeat right before secret resolution;
     * failures are logged and never block the run (the server will 401 and
     * that surfaces in the agent's own logs).
     */
    refreshExpiringTokensForAgent: async (agent: {
      id: string;
      companyId: string;
      adapterConfig: unknown;
    }): Promise<void> => {
      const mcpServers = asRecord(asRecord(agent.adapterConfig)?.mcpServers);
      if (!mcpServers) return;

      for (const [serverName, rawServer] of Object.entries(mcpServers)) {
        const server = asRecord(rawServer);
        const auth = asRecord(server?.auth);
        if (auth?.type !== "oauth" || typeof auth.secretId !== "string" || !auth.secretId) continue;
        const secretId = auth.secretId;

        const readPayload = async () => {
          const raw = await secrets.resolveSecretValue(agent.companyId, secretId, "latest", {
            consumerType: "agent",
            consumerId: agent.id,
            actorType: "system",
            actorId: null,
            configPath: `mcpServers.${serverName}.auth.secretId`,
          });
          return parseTokenPayload(raw);
        };
        const needsRefresh = (payload: ReturnType<typeof parseTokenPayload>) =>
          Boolean(
            payload?.refreshToken &&
              payload.expiresAt !== undefined &&
              payload.expiresAt - Date.now() <= TOKEN_REFRESH_LEEWAY_MS,
          );

        // Cheap pre-check outside the lock to avoid serializing the common
        // "token still fresh" path.
        try {
          if (!needsRefresh(await readPayload())) continue;
        } catch {
          continue;
        }

        await withRefreshLock(secretId, async () => {
          try {
            // Re-read under the lock: a concurrent run may have refreshed
            // already, in which case the token is now fresh and we skip.
            const payload = await readPayload();
            if (!payload || !needsRefresh(payload)) return;

            const refreshed = await callTokenEndpoint(
              payload.tokenEndpoint,
              {
                grant_type: "refresh_token",
                refresh_token: payload.refreshToken!,
                client_id: payload.clientId,
                resource: payload.resource,
              },
              payload.clientSecret,
            );
            const nextPayload: McpOauthTokenPayload = {
              ...payload,
              accessToken: refreshed.accessToken,
              // OAuth 2.1 allows refresh-token rotation; keep the old one if the
              // AS didn't send a replacement.
              refreshToken: refreshed.refreshToken ?? payload.refreshToken,
              expiresAt: refreshed.expiresAt,
              scope: refreshed.scope ?? payload.scope,
            };
            try {
              await secrets.rotate(secretId, { value: JSON.stringify(nextPayload) });
            } catch (rotateErr) {
              // The AS already consumed the old refresh token but we failed to
              // persist the new one — the grant may now be unusable. Surface
              // loudly so the token loss isn't silent.
              logger.error(
                {
                  agentId: agent.id,
                  serverName,
                  err: rotateErr instanceof Error ? rotateErr.message : String(rotateErr),
                },
                "refreshed OAuth token but failed to persist it; re-authorization may be required",
              );
              return;
            }
            logger.info(
              { agentId: agent.id, serverName },
              "refreshed OAuth token for MCP server before run",
            );
          } catch (err) {
            logger.warn(
              {
                agentId: agent.id,
                serverName,
                err: err instanceof Error ? err.message : String(err),
              },
              "failed to refresh OAuth token for MCP server; run will use the stored token",
            );
          }
        });
      }
    },
  };
}

/** Exposed for tests. */
export const __testing = {
  pendingChallenges,
  parseTokenPayload,
  wellKnownCandidates,
  isPrivateAddress,
  assertPublicHttpUrl,
};
