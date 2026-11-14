import { assertSupportedConnection } from "../connections/setup-policy.js";
import { vercelCredentialFor, vercelConnectResourcesFor } from "../vercel-credentials.js";
import { connectionSetupUrl, connectionReconnectUrl } from "../identifiers.js";
import type { ActorInfo } from "../types.js";
import { createOAuthDiscovery } from "../oauth/discovery.js";
import { oauthConfig } from "../oauth/metadata.js";
import { projectedConnectionHeaders } from "../connection-methods.js";
import { nativeProviderCatalogFor } from "../../native-provider-catalogs.js";
import { restConnectorFor } from "../../connectors/rest-registry.js";
import { GOOGLE_WORKSPACE_SERVICES, googleWorkspaceServiceGranted, googleWorkspaceToolName, googleWorkspaceGrantedScopes, isGoogleWorkspaceToolGranted, type GoogleWorkspaceService } from "@paperclipai/shared";
import { isInsufficientConnectionScope, INSUFFICIENT_CONNECTION_SCOPE_MESSAGE } from "../../connection-permission-errors.js";
import { mcpDiscoveryHttpFailure, withMcpConnectionFailure } from "../../mcp-connection-failure.js";
import { BROWSER_USE_TOOLS, MCP_SKILLS_EXTENSION_ID } from "@paperclipai/shared";
import { browserUseClient, isBrowserUseConnection } from "../../browser-use-client.js";
import { COGNEE_STDIO_TEMPLATE, cogneeCloudUrl } from "../../cognee-connection.js";
import { isMemoryConnectorId } from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { connectionGrants, toolConnections } from "@paperclipai/db";
import { GOOGLE_WORKSPACE_CONNECTOR_PROFILES, getConnectableAppDefinition } from "@paperclipai/shared";
import { badRequest, HttpError, unprocessable } from "../../../errors.js";
import { isSlackMcpAccessDisabledResponse } from "../../slack-mcp-error.js";
import {
  forgetMcpHttpSessions,
  forgetMcpProtocolVersion,
  getMcpHttpSession,
  initializeMcpHttpSession,
  isModernMcpProtocolVersion,
  knownMcpProtocolVersion,
  knownMcpServerCapabilities,
  mcpServerDeclaresExtension,
  rememberMcpServerCapabilities,
  MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION,
  mcpCacheHint,
  mcpCredentialFingerprint,
  mcpEraKey,
  McpHttpInitializationError,
  mcpHttpRequestInit,
  McpResultCache,
  mcpProtocolVersionOf,
  mcpToolHeaderParameters,
  negotiateMcpProtocolVersion,
  readMcpHttpResponse,
  readMcpModernError,
  rememberMcpProtocolVersion,
  selectMcpProtocolVersion,
} from "../../mcp-http.js";
import { logger } from "../../../middleware/logger.js";
import { saveMcpNegotiation } from "../mcp-protocol-config.js";
import { secretService } from "../../secrets.js";
import { agentmailApi } from "../../agentmail-api.js";
import { createRailwayClient, discoverRailwayWorkspace, isRailwayConnection, normalizeRailwayToolName, RAILWAY_TOOLS, RAILWAY_TOOL_PREFIX, RailwayError } from "../../railway.js";
import { isPaperclipCloudConnectorStrategy } from "../../paperclip-cloud-connector.js";
import { vercelTokenRequest, type VercelConnectClient } from "../../vercel-connect.js";

import type { ToolAccessAudit } from "../audit.js";
import type { ConnectionCredentialAccess } from "../credential-access.js";
import type { VercelCredentialService } from "../vercel-credentials.js";
import type { OAuthCredentialStore } from "../oauth/credential-store.js";
import type { ConnectionSetupPolicy } from "../connections/setup-policy.js";
import type { ToolRemoteHttp } from "../remote-http.js";
import { normalizeToolDescriptor, type McpToolDescriptor } from "./descriptors.js";
import { googleWorkspaceServicesUnavailable, unsupportedToolConnectionTransport } from "./failures.js";

const URL_CREDENTIAL_PARAMETER = /token|secret|passw|api[-_]?key|^key$|auth|signature|^sig$|session|credential/i;

/** Whether a sent URL carries a credential: user info, or a query parameter named like one. Plain settings such as `?region=us` do not. */
export function urlCarriesCredential(url: URL): boolean {
  if (url.username || url.password) return true;
  return [...url.searchParams.keys()].some((key) => URL_CREDENTIAL_PARAMETER.test(key));
}
function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  return {};
}

export function isAgentMailConnection(connection: typeof toolConnections.$inferSelect) {
  return connection.transport === "rest_api" && connection.config.provider === "agentmail";
}

type DiscoveryDependencies = {
  now: () => Date;
  audit: ToolAccessAudit;
  secrets: ReturnType<typeof secretService>;
  credentials: ConnectionCredentialAccess;
  vercel: VercelCredentialService;
  vercelConnect: VercelConnectClient | null;
  setupPolicy: ConnectionSetupPolicy;
  requestRemoteHttpEndpoint: ToolRemoteHttp["requestRemoteHttpEndpoint"];
  resolveOAuthGrantSecret: OAuthCredentialStore["resolveOAuthGrantSecret"];
  discoverOAuthEndpoints: ReturnType<typeof createOAuthDiscovery>["discoverOAuthEndpoints"];
  localTools(connection: typeof toolConnections.$inferSelect): Promise<McpToolDescriptor[]>;
};

/** Fresh `tools/list` results, honoring the server's `ttlMs` and `cacheScope`. */
const remoteToolListCache = new McpResultCache<McpToolDescriptor[]>(500);

/** Fresh `skills/list` results (raw entries), honoring the server's `ttlMs` and `cacheScope`. */
const remoteSkillListCache = new McpResultCache<unknown[]>(500);

export function forgetRemoteToolListCache(connectionId: string) {
  remoteToolListCache.deletePrefix(`${connectionId}:`);
  remoteSkillListCache.deletePrefix(`${connectionId}:`);
}

const MAX_SKILL_LIST_PAGES = 50;
const MAX_LISTED_SKILLS = 5_000;

export function createToolCatalogDiscovery(db: Db, { now, audit, secrets, credentials, vercel, vercelConnect, setupPolicy, requestRemoteHttpEndpoint, resolveOAuthGrantSecret, discoverOAuthEndpoints, localTools }: DiscoveryDependencies) {
  const { vaultGrantForConnection, resolveCredentialHeaders, resolvedRemoteEndpoint } = credentials;
  const { resolveVercelCredentialHeaders, vercelGrantForConnection } = vercel;
  const { assertConnectorConnectionSetupEnabled } = setupPolicy;
  async function remoteTools(
    connection: typeof toolConnections.$inferSelect,
    credentialHeaders?: Record<string, string>,
    actor?: ActorInfo,
    workspaceEndpoint?: string,
    unavailableServices: string[] = [],
    /** `live` skips a fresh cached list: health checks must reach the server. */
    listOptions: { live?: boolean } = {},
  ): Promise<McpToolDescriptor[]> {
    assertSupportedConnection(connection);
    await assertConnectorConnectionSetupEnabled(connection);
    let headers = credentialHeaders ?? {
      ...projectedConnectionHeaders(connection),
      ...(await resolveCredentialHeaders(connection, actor)),
    };
    if (connection.config.sourceTemplateKey === "google-workspace" && !workspaceEndpoint) {
      const grant = await vaultGrantForConnection(connection, actor);
      const scopes = googleWorkspaceGrantedScopes(grant);
      const services = (Object.keys(GOOGLE_WORKSPACE_SERVICES) as GoogleWorkspaceService[])
        .filter((service) => googleWorkspaceServiceGranted(service, scopes));
      // One credential authority, no child connections or implied service grants.
      const catalogs = await Promise.allSettled(services.map(async (service) => {
        const profile = GOOGLE_WORKSPACE_CONNECTOR_PROFILES[GOOGLE_WORKSPACE_SERVICES[service]];
        const tools = await remoteTools(connection, headers, actor, profile.serverUrl, [], listOptions);
        return tools.map((tool) => ({ ...tool, name: googleWorkspaceToolName(service, tool.name) }))
          .filter((tool) => isGoogleWorkspaceToolGranted(tool.name, scopes));
      }));
      for (const [index, catalog] of catalogs.entries()) {
        if (catalog.status === "fulfilled") continue;
        const service = services[index]!;
        unavailableServices.push(service);
        await audit({ companyId: connection.companyId, connectionId: connection.id,
          action: "tool_connection.catalog_refresh", outcome: "failure", actor,
          reasonCode: "google_workspace_service_unavailable", details: { service } });
      }
      const currentGrant = await vaultGrantForConnection(connection, actor);
      if (!currentGrant) throw unprocessable("OAuth authorization must be reconnected", { code: "oauth_reauthorization_required" });
      if (catalogs.length > 0 && catalogs.every((catalog) => catalog.status === "rejected")) {
        throw googleWorkspaceServicesUnavailable(unavailableServices,
          catalogs.map((catalog) => catalog.status === "rejected" ? catalog.reason : undefined));
      }
      // A service's authentication retry may have refreshed into a narrower
      // grant. Never publish actions using the pre-refresh permission snapshot.
      const currentScopes = googleWorkspaceGrantedScopes(currentGrant);
      return catalogs.flatMap((catalog) => catalog.status === "fulfilled" ? catalog.value : [])
        .filter((tool) => isGoogleWorkspaceToolGranted(tool.name, currentScopes));
    }
    const endpoint = workspaceEndpoint ?? await resolvedRemoteEndpoint(connection, actor);
    // Pinned to the address the guard approved: `config.url` is operator-supplied,
    // so a second DNS resolution here would reopen the rebinding window that
    // PAP-17098 closed for the OAuth endpoints.
    let listRequestId = "paperclip-catalog-refresh";
    let sessionHeaders = headers;
    const sendRemote = (init: RequestInit) => withMcpConnectionFailure(() => requestRemoteHttpEndpoint(new URL(endpoint), init));
    const sendToolsList = (requestHeaders: Record<string, string>, cursor?: string) => {
      sessionHeaders = requestHeaders;
      return sendRemote(mcpHttpRequestInit(requestHeaders, { id: listRequestId, method: "tools/list", params: cursor ? { cursor } : {} }));
    };
    const connectionConfig = asRecord(connection.config);
    const sourceTemplateKey = typeof connectionConfig?.sourceTemplateKey === "string"
      ? connectionConfig.sourceTemplateKey
      : null;
    const connectionMethodKey = typeof connectionConfig?.connectionMethodKey === "string"
      ? connectionConfig.connectionMethodKey
      : null;
    const curatedMethodRequiresMcpSession = Boolean(
      sourceTemplateKey && connectionMethodKey &&
      getConnectableAppDefinition(sourceTemplateKey)?.methods.some((method) =>
        method.key === connectionMethodKey && method.defaults?.mcpSessionRequired === true
      ),
    );
    // The protocol era is saved on the connection, so a restart does not
    // re-probe every server. It is checked again when a request using it fails.
    const eraKey = mcpEraKey(connection.id, endpoint);
    const savedProtocolVersion = typeof connectionConfig.mcpProtocolVersion === "string" ? connectionConfig.mcpProtocolVersion : null;
    if (!knownMcpProtocolVersion(eraKey)) {
      if (savedProtocolVersion) rememberMcpProtocolVersion(eraKey, savedProtocolVersion);
      // Saved as needing a session: a handshake server, re-probed only if it refuses.
      else if (connectionConfig?.mcpSessionRequired === true || curatedMethodRequiresMcpSession) rememberMcpProtocolVersion(eraKey, MCP_PROTOCOL_VERSION);
    }
    const privateCacheKey = `${eraKey}:${mcpCredentialFingerprint(headers)}`;
    const publicCacheKey = `${eraKey}:public`;
    if (!listOptions.live && isModernMcpProtocolVersion(knownMcpProtocolVersion(eraKey)) && !isRailwayConnection(connection)) {
      const cached = remoteToolListCache.get(privateCacheKey) ?? remoteToolListCache.get(publicCacheKey);
      if (cached) return structuredClone(cached);
    }
    const sessionScope = `${connection.id}:catalog:${actor?.actorType}:${actor?.actorId}:${endpoint}`;
    let protocolVersion = MCP_PROTOCOL_VERSION;
    let usedInitializedSession = connectionConfig?.mcpSessionRequired === true || curatedMethodRequiresMcpSession;
    // Resolves to the challenge itself when the server rejects the credential.
    const negotiate = async (): Promise<Response | null> => {
      try {
        protocolVersion = await negotiateMcpProtocolVersion({ send: sendRemote, headers, requestId: listRequestId, eraKey });
        return null;
      } catch (error) {
        if (!(error instanceof McpHttpInitializationError) || !error.response) throw error;
        return error.response;
      }
    };
    const listFirstPage = async (versionChanges = 0): Promise<Response> => {
      if (isModernMcpProtocolVersion(protocolVersion)) {
        const modernResponse = await sendToolsList({ ...headers, "MCP-Protocol-Version": protocolVersion });
        const modernError = await readMcpModernError(modernResponse);
        const supported = modernError?.code === MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION
          ? selectMcpProtocolVersion(modernError.supported) : null;
        if (!supported || supported === protocolVersion || versionChanges > 1) return modernResponse;
        await modernResponse.body?.cancel().catch(() => undefined);
        protocolVersion = supported;
        rememberMcpProtocolVersion(eraKey, supported);
        return listFirstPage(versionChanges + 1);
      }
      if (usedInitializedSession) {
        try {
          sessionHeaders = await getMcpHttpSession({ send: sendRemote, headers, scope: sessionScope, requestId: listRequestId, eraKey });
          return await sendToolsList(sessionHeaders);
        } catch (error) {
          if (!(error instanceof McpHttpInitializationError) || !error.response) throw error;
          return error.response;
        }
      }
      let legacyResponse = await sendToolsList(headers);
      // `tools/list` is read-only, so a 400 can safely be retried after the MCP
      // initialize handshake. Stateful servers such as Supabase require the
      // returned Mcp-Session-Id on every non-initialization request.
      if (legacyResponse.status === 400) {
        try {
          const initialized = await initializeMcpHttpSession({
            send: sendRemote,
            headers,
            requestId: "paperclip-catalog-refresh",
            eraKey,
          });
          const retried = await sendToolsList(initialized);
          await legacyResponse.body?.cancel().catch(() => undefined);
          legacyResponse = retried;
          usedInitializedSession = legacyResponse.ok;
        } catch {
          // Preserve the original HTTP failure below when this was not an MCP
          // session requirement after all.
        }
      }
      return legacyResponse;
    };
    let response = await negotiate() ?? await listFirstPage();
    if (savedProtocolVersion && response.status === 400) {
      // The server no longer accepts the saved version (for example it moved to
      // stateless MCP). Listing is read-only, so probe once more and retry.
      await response.body?.cancel().catch(() => undefined);
      forgetMcpProtocolVersion(eraKey);
      forgetMcpHttpSessions(connection.id);
      response = await negotiate() ?? await listFirstPage();
    }
    if (response.status === 404 && new Headers(sessionHeaders).has("mcp-session-id")) {
      // MCP uses 404 for an expired server session. Discovery is read-only, so
      // discard the stale session and retry it once with a new handshake.
      forgetMcpHttpSessions(connection.id);
      await response.body?.cancel().catch(() => undefined);
      sessionHeaders = await getMcpHttpSession({ send: sendRemote, headers, scope: sessionScope, requestId: listRequestId, eraKey });
      response = await sendToolsList(sessionHeaders);
      if (response.status === 404) forgetMcpHttpSessions(connection.id);
    }
    // After a credential refresh, list in the shape this server needs. A server
    // whose probe was itself refused for the old credential is probed now.
    const relistAfterCredentialRefresh = async () => {
      if (!isModernMcpProtocolVersion(protocolVersion) && knownMcpProtocolVersion(eraKey)) return sendToolsList(headers);
      return await negotiate() ?? await listFirstPage();
    };
    // Save what the last request actually used. A session request can come
    // back modern after a refused handshake, and a credential refresh can
    // negotiate after the first listing.
    const usedProtocolVersion = () => {
      const sent = mcpProtocolVersionOf(sessionHeaders);
      if (isModernMcpProtocolVersion(sent)) return sent;
      return isModernMcpProtocolVersion(protocolVersion) ? MCP_PROTOCOL_VERSION : protocolVersion;
    };
    const saveNegotiation = async () => {
      const used = usedProtocolVersion();
      const current = asRecord(connection.config);
      const sessionRequiredChanged = !isModernMcpProtocolVersion(used) && usedInitializedSession && current.mcpSessionRequired !== true;
      const versionChanged = response.ok && current.mcpProtocolVersion !== used;
      if (response.ok) rememberMcpProtocolVersion(eraKey, used);
      if (!sessionRequiredChanged && !versionChanged) return;
      const saved = await saveMcpNegotiation(db, connection, {
        ...(sessionRequiredChanged ? { mcpSessionRequired: true as const } : {}),
        ...(versionChanged ? { mcpProtocolVersion: used } : {}),
      });
      if (saved) {
        connection.config = saved.config;
        connection.transportConfig = saved.transportConfig;
      }
    };
    await saveNegotiation();
    if (isInsufficientConnectionScope(response)) {
      await response.body?.cancel().catch(() => undefined);
      throw unprocessable(INSUFFICIENT_CONNECTION_SCOPE_MESSAGE, { code: "oauth_insufficient_scope", connectionId: connection.id });
    }
    if (
      response.status === 401 &&
      connection.credentialSource === "vercel_connect"
    ) {
      const grant = await vercelGrantForConnection(connection, actor);
      const credential = vercelCredentialFor(connection);
      const request = vercelTokenRequest({
        credential,
        grant,
        connectionId: connection.id,
        companyId: connection.companyId,
        resources: vercelConnectResourcesFor(connection),
      });
      vercelConnect?.evict(request);
      headers = {
        ...projectedConnectionHeaders(connection),
        ...(await resolveVercelCredentialHeaders(connection, grant, {
          forceRefresh: true,
        })),
      };
      response = await relistAfterCredentialRefresh();
    }
    if (
      response.status === 401 &&
      connection.authKind === "oauth" &&
      connection.credentialSource === "paperclip_vault"
    ) {
      headers = {
        ...projectedConnectionHeaders(connection),
        ...(await resolveCredentialHeaders(connection, actor, {
          forceRefresh: true,
        })),
      };
      response = await relistAfterCredentialRefresh();
      if (
        response.status === 401 &&
        isPaperclipCloudConnectorStrategy(oauthConfig(connection).strategy)
      ) {
        const grant = await vaultGrantForConnection(connection, actor);
        if (grant) {
          await db
            .update(connectionGrants)
            .set({ status: "needs_reauthorization", updatedAt: now() })
            .where(
              and(
                eq(connectionGrants.id, grant.id),
                eq(connectionGrants.companyId, connection.companyId),
              ),
            );
        }
      }
    }
    if (response.ok) await saveNegotiation();
    if (!response.ok) {
      if ((response.status === 401 || response.status === 403)
        && connection.authKind === "api_key" && isMemoryConnectorId(connection.config.sourceTemplateKey)) {
        throw unprocessable("The provider rejected this API key. Check the key and its account access, then try again.", { code: "memory_api_key_rejected" });
      }
      if (await isSlackMcpAccessDisabledResponse(endpoint, response)) {
        throw unprocessable(
          "Slack MCP access is disabled for this app. Ask the Slack app owner to enable MCP access, then refresh this connection.",
          { code: "slack_mcp_access_disabled", setupUrl: connectionSetupUrl(connection) },
        );
      }
      const authenticate = response.headers.get("www-authenticate") ?? "";
      // A bare 401 to a request that carried no credential is the server's
      // answer to "does it need a key?". Treat it like a challenge whose sign-in
      // Paperclip cannot discover, so the person is asked for a key instead of
      // seeing a raw HTTP status. A request that carried a credential (stored
      // secret, header, or a token or user info in the URL) keeps the raw
      // rejection: that credential needs replacing, not a new key.
      const sentUrl = new URL(endpoint);
      const bareCredentialChallenge =
        !authenticate.trim() &&
        connection.authKind === "none" &&
        connection.credentialSecretRefs.length === 0 &&
        Object.keys(headers).length === 0 &&
        !urlCarriesCredential(sentUrl);
      if (
        response.status === 401 &&
        (/bearer|oauth|authorization/i.test(authenticate) ||
          bareCredentialChallenge)
      ) {
        const endpoints = await discoverOAuthEndpoints(
          connection,
          authenticate,
        );
        if (endpoints) {
          const nextConfig = {
            ...connection.config,
            oauth: {
              ...oauthConfig(connection),
              provider: endpoints.provider,
              authorizationUrl: endpoints.authorizationUrl,
              tokenUrl: endpoints.tokenUrl,
              registrationUrl: endpoints.registrationUrl ?? null,
              metadataUrl: endpoints.metadataUrl ?? null,
              scopes: endpoints.scopes,
              codeChallengeMethodsSupported:
                endpoints.codeChallengeMethodsSupported ?? [],
              tokenEndpointAuthMethodsSupported:
                endpoints.tokenEndpointAuthMethodsSupported ?? [],
              grantType: endpoints.grantType ?? "authorization_code",
              issuer: endpoints.issuer ?? null,
              resource: endpoints.resource ?? null,
              clientIdMetadataDocumentSupported:
                endpoints.clientIdMetadataDocumentSupported === true,
              issParameterSupported: endpoints.issParameterSupported === true,
              discoveredAt: new Date().toISOString(),
            },
          };
          await db
            .update(toolConnections)
            .set({
              // Record the discovered auth kind now, so a URL-only connection that
              // is waiting on sign-in reads as OAuth everywhere rather than
              // falling back to `authKind: none` semantics.
              authKind: "oauth",
              config: nextConfig,
              transportConfig: nextConfig,
              updatedAt: new Date(),
            })
            .where(eq(toolConnections.id, connection.id));
        }
        throw unprocessable("This app needs you to sign in.", {
          code: "oauth_challenge",
          status: response.status,
          setupUrl: connectionSetupUrl(connection),
          reconnectUrl: connectionReconnectUrl(connection),
          oauthSupported: Boolean(endpoints),
        });
      }
      throw mcpDiscoveryHttpFailure(response, `Remote app returned HTTP ${response.status}`);
    }
    const descriptors: McpToolDescriptor[] = [];
    const seenCursors = new Set<string>();
    // Each page carries its own freshness hint; the list is fresh while all are.
    let cacheHint: { ttlMs: number; scope: "public" | "private" } | null = null;
    for (let page = 0; ; page += 1) {
      const payload = await withMcpConnectionFailure(() => readMcpHttpResponse(response, listRequestId));
      const record = asRecord(payload);
      if (record.error) throw new HttpError(502, "Remote MCP tool discovery failed", { code: "mcp_catalog_error" });
      const result = asRecord(record.result);
      if (!Array.isArray(result.tools)) throw new HttpError(502, "Remote MCP returned an invalid tool catalog", { code: "mcp_catalog_invalid" });
      const pageHint = mcpCacheHint(result);
      cacheHint = page === 0 ? pageHint : pageHint && cacheHint
        ? { ttlMs: Math.min(pageHint.ttlMs, cacheHint.ttlMs), scope: cacheHint.scope === "private" || pageHint.scope === "private" ? "private" : "public" }
        : null;
      descriptors.push(...result.tools.map((tool) => normalizeToolDescriptor(tool)).filter((tool): tool is McpToolDescriptor => {
        if (!tool) return false;
        // Header-mirrored parameters must be well formed; a bad tool is dropped
        // so it cannot block the rest of the catalog.
        const headerParameters = mcpToolHeaderParameters(tool.inputSchema);
        if (!headerParameters.ok) {
          logger.warn({ connectionId: connection.id, tool: tool.name, reason: headerParameters.reason }, "Skipped an MCP tool with invalid x-mcp-header annotations");
          return false;
        }
        return true;
      }));
      const cursor = typeof result.nextCursor === "string" ? result.nextCursor : null;
      if (!cursor) break;
      if (seenCursors.has(cursor) || page >= 99 || descriptors.length > 20_000) throw new HttpError(502, "Remote MCP tool catalog pagination did not finish", { code: "mcp_catalog_pagination" });
      seenCursors.add(cursor);
      listRequestId = `paperclip-catalog-refresh-${page + 1}`;
      response = await sendToolsList(sessionHeaders, cursor);
      if (!response.ok) throw mcpDiscoveryHttpFailure(response, "Remote MCP catalog page could not be read");
    }
    if (!isRailwayConnection(connection)) {
      if (isModernMcpProtocolVersion(mcpProtocolVersionOf(sessionHeaders)) && cacheHint) {
        // Keyed by the credential that made the successful listing, which a
        // token refresh above may have replaced.
        remoteToolListCache.set(cacheHint.scope === "public" ? publicCacheKey : `${eraKey}:${mcpCredentialFingerprint(headers)}`, structuredClone(descriptors), cacheHint.ttlMs);
      }
      return descriptors;
    }
    if (descriptors.some((tool) => normalizeRailwayToolName(tool.name).startsWith(RAILWAY_TOOL_PREFIX))) {
      throw unprocessable("Railway advertised a reserved Paperclip action name. Refresh is blocked pending review.", { code: "railway_tool_name_collision" });
    }
    let apiStatus = "available";
    let apiMessage = "Direct Railway service, log, and deployment tools are available.";
    try {
      const railwayOptions = {
        authorization: headers.Authorization ?? "",
        request: (url: string, init: RequestInit) => requestRemoteHttpEndpoint(new URL(url), init),
        signal: AbortSignal.timeout(15_000),
      };
      const workspaceId = await discoverRailwayWorkspace(railwayOptions);
      await createRailwayClient(railwayOptions).probe(workspaceId);
    } catch (error) {
      apiStatus = "unavailable";
      apiMessage = error instanceof RailwayError ? error.message : "Railway API access could not be verified. Refresh actions or reconnect Railway.";
    }
    // API interoperability is verified with the actual credential; the presence
    // of an OAuth token alone never enables the additional capability surface.
    const nextConfig = { ...connection.config, railwayApiStatus: apiStatus, railwayApiMessage: apiMessage };
    await db.update(toolConnections).set({ config: nextConfig, transportConfig: nextConfig, updatedAt: now() }).where(and(eq(toolConnections.id, connection.id), eq(toolConnections.companyId, connection.companyId)));
    connection.config = nextConfig;
    connection.transportConfig = nextConfig;
    return apiStatus === "available" ? [...descriptors, ...RAILWAY_TOOLS] : descriptors;
  }

  async function validateCogneeConnection(connection: typeof toolConnections.$inferSelect, actor?: ActorInfo, probe = true) {
    if (connection.config.templateId !== "paperclip.cognee-cloud") return;
    const grant = await vaultGrantForConnection(connection, actor);
    const refs = grant?.credentialSecretRefs ?? connection.credentialSecretRefs;
    const values: Record<string, string> = {};
    for (const key of COGNEE_STDIO_TEMPLATE.envKeys) {
      const ref = refs.find((candidate) => candidate.configPath === `env.${key}`);
      if (!ref) throw unprocessable("Reconnect Cognee to restore its Cloud credentials", { code: "missing_secret" });
      values[key] = grant
        ? (await resolveOAuthGrantSecret(connection, grant, ref, actor, undefined)).value
        : await secrets.resolveSecretValue(connection.companyId, ref.secretId, ref.versionSelector ?? "latest", {
            consumerType: "tool_connection", consumerId: connection.id, configPath: ref.configPath,
            actorType: "system", actorId: null,
          });
    }
    let base: URL;
    try { base = cogneeCloudUrl(values.COGNEE_BASE_URL!); }
    catch { throw badRequest("Copy the tenant API Base URL from Cognee’s API Keys page."); }
    // Scheduled health checks validate configuration and vault access. A transient
    // Cloud probe must not withdraw an already assigned local tool catalog.
    if (!probe) return;
    const response = await requestRemoteHttpEndpoint(new URL("/api/v1/datasets/", base), {
      method: "GET", headers: { "X-Api-Key": values.COGNEE_API_KEY! }, signal: AbortSignal.timeout(15_000),
    });
    await response.body?.cancel();
    if (!response.ok) throw unprocessable("Cognee Cloud could not verify access. Check the tenant URL, API key, and workspace subscription.", { code: "cognee_access_unverified" });
  }

  async function validateAgentMailConnection(
    connection: typeof toolConnections.$inferSelect,
  ) {
    const configPath = connection.config.emailCredential
      ? "credentials.controlKey"
      : "credentials.apiKey";
    const ref = connection.credentialSecretRefs.find(
      (candidate) => candidate.configPath === configPath,
    );
    if (!ref) {
      throw unprocessable("Reconnect AgentMail to restore its API key", {
        code: "missing_secret",
      });
    }
    const key = await secrets.resolveSecretValue(
      connection.companyId,
      ref.secretId,
      ref.versionSelector ?? "latest",
      {
        consumerType: "tool_connection",
        consumerId: connection.id,
        configPath,
        actorType: "system",
        actorId: null,
      },
    );
    await agentmailApi(key).whoami();
  }

  async function discoverTools(
    connection: typeof toolConnections.$inferSelect,
    credentialHeaders?: Record<string, string>,
    actor?: ActorInfo,
    unavailableServices: string[] = [],
    listOptions: { live?: boolean } = {},
  ): Promise<McpToolDescriptor[]> {
    assertSupportedConnection(connection);
    await assertConnectorConnectionSetupEnabled(connection);
    if (connection.connectionPurpose === "ai") throw unprocessable("AI connections provide runtime authentication, not tool actions");
    const restConnector = restConnectorFor(connection);
    if (restConnector) {
      const headers = credentialHeaders ?? await resolveCredentialHeaders(connection, actor);
      await restConnector.client(connection, headers, (url, init) => requestRemoteHttpEndpoint(new URL(url), init)).probe();
      return restConnector.tools;
    }
    const nativeProvider = nativeProviderCatalogFor(connection);
    if (nativeProvider) {
      const headers = credentialHeaders ?? await resolveCredentialHeaders(connection, actor);
      await nativeProvider.probe(connection, headers, (url, init) => requestRemoteHttpEndpoint(new URL(url), init));
      return nativeProvider.tools;
    }
    if (isBrowserUseConnection(connection)) {
      const headers = credentialHeaders ?? await resolveCredentialHeaders(connection, actor);
      await browserUseClient(headers, (url, init) => requestRemoteHttpEndpoint(new URL(url), init), connection.id).probe();
      return BROWSER_USE_TOOLS;
    }
    if (isAgentMailConnection(connection)) {
      await validateAgentMailConnection(connection);
      return [];
    }
    if (connection.transport === "mcp_remote")
      return remoteTools(connection, credentialHeaders, actor, undefined, unavailableServices, listOptions);
    if (connection.transport !== "local_stdio") {
      throw unsupportedToolConnectionTransport();
    }
    await resolveCredentialHeaders(connection);
    await validateCogneeConnection(connection, actor);
    return localTools(connection);
  }
  /**
   * The skills a stateless MCP server publishes (`skills/list`), or null when
   * the server does not declare the skills extension. Only called from a
   * catalog refresh, never while an agent run is starting. A fresh listing
   * (`ttlMs`) is reused, and `fresh: false` tells the caller nothing changed.
   */
  async function discoverSkills(
    connection: typeof toolConnections.$inferSelect,
    actor?: ActorInfo,
  ): Promise<{ entries: unknown[]; fresh: boolean } | null> {
    if (connection.transport !== "mcp_remote" || isRailwayConnection(connection)
      || connection.config.sourceTemplateKey === "google-workspace") return null;
    const endpoint = await resolvedRemoteEndpoint(connection, actor);
    const eraKey = mcpEraKey(connection.id, endpoint);
    const saved = asRecord(connection.config).mcpProtocolVersion;
    if (!knownMcpProtocolVersion(eraKey) && typeof saved === "string") rememberMcpProtocolVersion(eraKey, saved);
    const protocolVersion = knownMcpProtocolVersion(eraKey);
    // The extension is defined for stateless MCP (2026-07-28 and later).
    if (!isModernMcpProtocolVersion(protocolVersion)) return null;
    const headers = { ...projectedConnectionHeaders(connection), ...(await resolveCredentialHeaders(connection, actor)) };
    const requestHeaders = { ...headers, "MCP-Protocol-Version": protocolVersion };
    const request = async (method: string, params: Record<string, unknown>, id: string, maxBytes?: number) => {
      const response = await withMcpConnectionFailure(() => requestRemoteHttpEndpoint(new URL(endpoint), mcpHttpRequestInit(requestHeaders, { id, method, params })));
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      const payload = asRecord(await withMcpConnectionFailure(() => readMcpHttpResponse(response, id, maxBytes ? { maxBytes } : {})));
      return payload.error === undefined ? asRecord(payload.result) : null;
    };
    let capabilities = knownMcpServerCapabilities(eraKey);
    if (!capabilities) {
      const discovered = await request("server/discover", {}, "paperclip-skills-discover", 256 * 1024);
      if (!discovered) return null;
      capabilities = asRecord(discovered.capabilities);
      rememberMcpServerCapabilities(eraKey, capabilities);
    }
    // Clients issue skills/list only after observing the server's declaration.
    if (!mcpServerDeclaresExtension(capabilities, MCP_SKILLS_EXTENSION_ID)) return null;
    const privateKey = `${eraKey}:${mcpCredentialFingerprint(headers)}`;
    const publicKey = `${eraKey}:public`;
    const cached = remoteSkillListCache.get(privateKey) ?? remoteSkillListCache.get(publicKey);
    if (cached) return { entries: structuredClone(cached), fresh: false };
    const entries: unknown[] = [];
    const seenCursors = new Set<string>();
    let cacheHint: { ttlMs: number; scope: "public" | "private" } | null = null;
    let cursor: string | null = null;
    for (let page = 0; page < MAX_SKILL_LIST_PAGES; page += 1) {
      const result = await request("skills/list", cursor ? { cursor } : {}, `paperclip-skills-list-${page}`, 8 * 1024 * 1024);
      if (!result || !Array.isArray(result.skills)) {
        throw new HttpError(502, "This app's skill list could not be read", { code: "mcp_skills_list_invalid" });
      }
      entries.push(...result.skills);
      const pageHint = mcpCacheHint(result);
      cacheHint = page === 0 ? pageHint : pageHint && cacheHint
        ? { ttlMs: Math.min(pageHint.ttlMs, cacheHint.ttlMs), scope: cacheHint.scope === "private" || pageHint.scope === "private" ? "private" : "public" }
        : null;
      cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : null;
      if (!cursor || seenCursors.has(cursor) || entries.length >= MAX_LISTED_SKILLS) break;
      seenCursors.add(cursor);
    }
    if (cacheHint) remoteSkillListCache.set(cacheHint.scope === "public" ? publicKey : privateKey, structuredClone(entries), cacheHint.ttlMs);
    return { entries, fresh: true };
  }
  return { remoteTools, validateCogneeConnection, validateAgentMailConnection, discoverTools, discoverSkills };
}
export type ToolCatalogDiscovery = ReturnType<typeof createToolCatalogDiscovery>;
