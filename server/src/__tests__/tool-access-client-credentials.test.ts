import { createPublicKey, randomUUID, verify, type KeyObject } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  applyPendingMigrations,
  authUsers,
  companies,
  companySecretBindings,
  companySecrets,
  connectionGrants,
  createDb,
  secretAccessEvents,
  toolAccessAuditEvents,
  toolApplications,
  toolCatalogEntries,
  toolConnections,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { toolAccessService } from "../services/tool-access.js";
import { secretService } from "../services/secrets.js";
import { toolAccessRoutes } from "../routes/tool-access.js";
import { errorHandler } from "../middleware/index.js";
import { createOAuthClientProtocol } from "../services/tool-access/oauth/client.js";
import {
  CLIENT_ASSERTION_LIFETIME_SECONDS,
  generateClientKeyPair,
  signClientAssertion,
} from "../services/tool-access/oauth/client-credentials.js";
import { MCP_OAUTH_CLIENT_CREDENTIALS_EXTENSION_ID, mcpClientCapabilities } from "../services/mcp-http.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const ISSUER = "https://auth.example.test";
const TOKEN_URL = `${ISSUER}/oauth/token`;
const OTHER_ISSUER = "https://other-auth.example.test";
const MCP_URL = "https://mcp.example.test/mcp";
const CLIENT_ID = "paperclip-automation";
const CLIENT_SECRET = "s3cret-value-never-shown";

function decodeJwt(token: string) {
  const [header, claims, signature] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(header!, "base64url").toString()) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(claims!, "base64url").toString()) as Record<string, unknown>,
    signingInput: `${header}.${claims}`,
    signature: Buffer.from(signature!, "base64url"),
  };
}

function verifyJwt(token: string, key: KeyObject): boolean {
  const { header, signingInput, signature } = decodeJwt(token);
  return verify(
    "sha256",
    Buffer.from(signingInput),
    header.alg === "ES256" ? { key, dsaEncoding: "ieee-p1363" } : key,
    signature,
  );
}

function json(payload: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", ...headers } });
}

/**
 * A fake sign-in service and MCP server behind the outbound HTTP transport.
 * The sign-in service verifies real signatures against keys an "admin"
 * registered, exactly as a provider would.
 */
function fakeProvider() {
  const state = {
    advertisedIssuers: [ISSUER],
    registeredKeys: new Map<string, KeyObject>(),
    clientSecret: CLIENT_SECRET,
    tokenRequests: [] as Array<{ url: string; body: URLSearchParams; authorization: string | null }>,
    otherIssuerRequests: 0,
    mcpRequests: [] as Array<{ authorization: string | null; body: Record<string, unknown> }>,
    acceptedTokens: new Set<string>(),
    issued: 0,
    tokenDelayMs: 0,
    rejectAllTokens: false,
    /** Other clients the sign-in service knows (id → secret). */
    extraClients: new Map<string, string>(),
    /** Clients whose tokens the MCP server refuses. */
    mcpDeniedClients: new Set<string>(),
    tokenClients: new Map<string, string>(),
    /** Serve protected-resource metadata only at the address the challenge names. */
    metadataOnlyAtHint: false,
    /** Runs once when the server first receives a signed-in request (to stage races). */
    onAuthorizedMcpRequest: null as null | (() => Promise<void>),
    signingAlgorithms: ["RS256", "ES256"],
    /** Runs once at the start of the next token request (to stage a paused refresh). */
    onTokenRequest: null as null | (() => Promise<void>),
  };
  const metadata = (issuer: string) => ({
    issuer,
    token_endpoint: `${issuer}/oauth/token`,
    grant_types_supported: ["client_credentials"],
    token_endpoint_auth_methods_supported: ["private_key_jwt", "client_secret_basic", "client_secret_post"],
    token_endpoint_auth_signing_alg_values_supported: state.signingAlgorithms,
  });
  const handle = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    if (url.startsWith(OTHER_ISSUER)) {
      state.otherIssuerRequests += 1;
      if (url.includes("/.well-known/")) return json(metadata(OTHER_ISSUER));
      return json({ access_token: "stolen", expires_in: 3600 });
    }
    if (url === `${new URL(MCP_URL).origin}/meta/custom-resource` && state.metadataOnlyAtHint) {
      return json({ resource: MCP_URL, authorization_servers: state.advertisedIssuers });
    }
    if (url === `${new URL(MCP_URL).origin}/.well-known/oauth-protected-resource/mcp`
      || url === `${new URL(MCP_URL).origin}/.well-known/oauth-protected-resource`) {
      if (state.metadataOnlyAtHint) return new Response("not found", { status: 404 });
      return json({ resource: MCP_URL, authorization_servers: state.advertisedIssuers });
    }
    if (url === `${ISSUER}/.well-known/oauth-authorization-server`) return json(metadata(ISSUER));
    if (url.startsWith(ISSUER) && url.includes("/.well-known/")) return new Response("not found", { status: 404 });
    if (url === TOKEN_URL) {
      const body = new URLSearchParams(String(init?.body));
      state.tokenRequests.push({ url, body, authorization: headers.get("authorization") });
      if (state.onTokenRequest) {
        const hook = state.onTokenRequest;
        state.onTokenRequest = null;
        await hook();
      }
      if (state.tokenDelayMs) await new Promise((resolve) => setTimeout(resolve, state.tokenDelayMs));
      if (body.get("grant_type") !== "client_credentials") return json({ error: "unsupported_grant_type" }, 400);
      const assertion = body.get("client_assertion");
      let authenticated = false;
      let clientId = CLIENT_ID;
      if (assertion) {
        const { header, claims } = decodeJwt(assertion);
        const key = state.registeredKeys.get(String(header.kid));
        authenticated = Boolean(key && verifyJwt(assertion, key)
          && claims.iss === CLIENT_ID && claims.sub === CLIENT_ID && claims.aud === TOKEN_URL
          && typeof claims.exp === "number" && claims.exp * 1000 > Date.now());
      } else {
        const basic = headers.get("authorization");
        const expected = `Basic ${Buffer.from(`${CLIENT_ID}:${state.clientSecret}`).toString("base64")}`;
        authenticated = basic === expected;
        for (const [id, secret] of state.extraClients) {
          if (basic === `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`) {
            authenticated = true;
            clientId = id;
          }
        }
      }
      if (!authenticated) return json({ error: "invalid_client" }, 401);
      state.issued += 1;
      const token = `machine-token-${state.issued}`;
      state.acceptedTokens.add(token);
      state.tokenClients.set(token, clientId);
      return json({ access_token: token, token_type: "Bearer", expires_in: 3600, scope: body.get("scope") ?? undefined });
    }
    if (url === MCP_URL) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const authorization = headers.get("authorization");
      state.mcpRequests.push({ authorization, body });
      const bearer = authorization?.replace(/^Bearer /, "") ?? "";
      if (state.rejectAllTokens || !state.acceptedTokens.has(bearer) || state.mcpDeniedClients.has(state.tokenClients.get(bearer) ?? "")) {
        return new Response("", {
          status: 401,
          headers: { "www-authenticate": `Bearer resource_metadata="${new URL(MCP_URL).origin}${state.metadataOnlyAtHint ? "/meta/custom-resource" : "/.well-known/oauth-protected-resource/mcp"}"` },
        });
      }
      if (state.onAuthorizedMcpRequest) {
        const hook = state.onAuthorizedMcpRequest;
        state.onAuthorizedMcpRequest = null;
        await hook();
      }
      if (body.method === "server/discover") {
        return json({ jsonrpc: "2.0", id: body.id, result: { supportedVersions: ["2026-07-28"], capabilities: {} } });
      }
      if (body.method === "tools/list") {
        return json({ jsonrpc: "2.0", id: body.id, result: { tools: [
          { name: "list_reports", description: "List reports", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
        ] } });
      }
      return json({ jsonrpc: "2.0", id: body.id, result: {} });
    }
    throw new Error(`unexpected request ${url}`);
  };
  return { state, handle };
}

describe("client credentials protocol", () => {
  it("creates keys without blocking other work on the server", async () => {
    let otherWorkRan = false;
    const generating = generateClientKeyPair("RS256");
    setImmediate(() => { otherWorkRan = true; });
    await generating;
    expect(otherWorkRan).toBe(true);
  });

  it("signs an RS256 assertion with iss = sub = client ID, the token endpoint as audience, a short expiry and a unique jti", async () => {
    const { privateKeyPem, publicKey } = await generateClientKeyPair("RS256");
    const now = new Date("2026-11-13T12:00:00Z");
    const first = signClientAssertion({ privateKeyPem, algorithm: "RS256", keyId: publicKey.keyId, clientId: CLIENT_ID, audience: TOKEN_URL, now });
    const second = signClientAssertion({ privateKeyPem, algorithm: "RS256", keyId: publicKey.keyId, clientId: CLIENT_ID, audience: TOKEN_URL, now });
    const decoded = decodeJwt(first);
    expect(decoded.header).toEqual({ alg: "RS256", typ: "JWT", kid: publicKey.keyId });
    expect(decoded.claims).toMatchObject({ iss: CLIENT_ID, sub: CLIENT_ID, aud: TOKEN_URL, iat: now.getTime() / 1000 });
    expect(Number(decoded.claims.exp) - Number(decoded.claims.iat)).toBe(CLIENT_ASSERTION_LIFETIME_SECONDS);
    expect(CLIENT_ASSERTION_LIFETIME_SECONDS).toBeLessThanOrEqual(60);
    expect(decoded.claims.jti).not.toEqual(decodeJwt(second).claims.jti);
    expect(verifyJwt(first, createPublicKey(publicKey.publicKeyPem))).toBe(true);
    // The JWK the admin registers verifies the same signature.
    expect(verifyJwt(first, createPublicKey({ key: publicKey.publicJwk, format: "jwk" }))).toBe(true);
    expect(publicKey.publicJwk).toMatchObject({ kid: publicKey.keyId, alg: "RS256", use: "sig", kty: "RSA" });
    expect(JSON.stringify(publicKey)).not.toContain("PRIVATE KEY");
    expect(publicKey.publicJwk).not.toHaveProperty("d");
  });

  it("signs ES256 assertions in JOSE (raw r||s) form", async () => {
    const { privateKeyPem, publicKey } = await generateClientKeyPair("ES256");
    const token = signClientAssertion({ privateKeyPem, algorithm: "ES256", keyId: publicKey.keyId, clientId: CLIENT_ID, audience: TOKEN_URL });
    expect(decodeJwt(token).signature).toHaveLength(64);
    expect(verifyJwt(token, createPublicKey(publicKey.publicKeyPem))).toBe(true);
  });

  it("sends only the signed assertion as client authentication", async () => {
    const sent: Array<{ body: URLSearchParams; headers: Headers }> = [];
    const { exchangeOAuthToken } = createOAuthClientProtocol({
      assertOAuthEndpointUrl: (_kind, value) => String(value),
      fetchRemoteHttpUrl: async (_url, init) => {
        sent.push({ body: new URLSearchParams(String(init?.body)), headers: new Headers(init?.headers) });
        return json({ access_token: "t", expires_in: 60 });
      },
    });
    await exchangeOAuthToken({
      tokenUrl: TOKEN_URL, clientId: CLIENT_ID, grantType: "client_credentials", scopes: ["reports.read"],
      clientAssertion: "a.b.c", resource: MCP_URL,
    });
    const { body, headers } = sent[0]!;
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("client_assertion_type")).toBe("urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
    expect(body.get("client_assertion")).toBe("a.b.c");
    expect(body.get("scope")).toBe("reports.read");
    expect(body.get("resource")).toBe(MCP_URL);
    expect(body.has("client_id")).toBe(false);
    expect(body.has("client_secret")).toBe(false);
    expect(headers.get("authorization")).toBeNull();
  });

  it("declares the extension only when a connection uses machine sign-in", () => {
    expect(JSON.stringify(mcpClientCapabilities("2026-07-28"))).not.toContain(MCP_OAUTH_CLIENT_CREDENTIALS_EXTENSION_ID);
    expect(mcpClientCapabilities("2026-07-28", { declareClientCredentials: true })).toMatchObject({
      extensions: { [MCP_OAUTH_CLIENT_CREDENTIALS_EXTENSION_ID]: {} },
    });
  });
});

const externalDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_TOOL_ACCESS_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("machine sign-in connections", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const transport = {
    remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 as const }],
    remoteHttpRequest: async (url: string, init: RequestInit) => fetch(url, init),
  };
  const service = () => toolAccessService(db, transport);
  const actor = { actorType: "user" as const, actorId: "board-user" };

  beforeAll(async () => {
    if (externalDatabaseUrl) {
      await applyPendingMigrations(externalDatabaseUrl);
      db = createDb(externalDatabaseUrl, { maxConnections: 6 });
      return;
    }
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-client-credentials-");
    db = createDb(tempDb.connectionString, { maxConnections: 6 });
  }, 120_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(activityLog);
    await db.delete(toolAccessAuditEvents);
    await db.delete(toolCatalogEntries);
    await db.delete(connectionGrants);
    await db.delete(toolConnections);
    await db.delete(companySecrets);
    await db.delete(toolApplications);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  async function createCompany() {
    const [company] = await db.insert(companies).values({
      name: `Machine sign-in ${randomUUID()}`,
      issuePrefix: `MS${randomUUID().slice(0, 6).toUpperCase()}`,
    }).returning();
    return company!;
  }

  function useProvider() {
    const provider = fakeProvider();
    vi.spyOn(globalThis, "fetch").mockImplementation(provider.handle);
    return provider;
  }

  function registerKey(provider: ReturnType<typeof fakeProvider>, key: { keyId: string; pem: string }) {
    provider.state.registeredKeys.set(key.keyId, createPublicKey(key.pem));
  }

  async function organizationGrant(connectionId: string) {
    const [grant] = await db.select().from(connectionGrants)
      .where(and(eq(connectionGrants.connectionId, connectionId), eq(connectionGrants.kind, "organization")));
    return grant!;
  }

  async function setupKeyConnection(companyId: string, provider: ReturnType<typeof fakeProvider>) {
    const svc = service();
    const created = await svc.createMachineSignIn(companyId, { link: MCP_URL, method: "paperclip_key", scopes: "reports.read" }, actor);
    registerKey(provider, created.machineSignIn.publicKey!);
    const result = await svc.testMachineSignIn(companyId, created.connectionId, { clientId: CLIENT_ID }, actor);
    return { svc, created, result };
  }

  it("sets up a Paperclip key connection: finds the sign-in service, shows the public key, signs in and lists tools", async () => {
    const company = await createCompany();
    const provider = useProvider();
    const svc = service();
    const created = await svc.createMachineSignIn(company.id, { link: MCP_URL, method: "paperclip_key", scopes: "reports.read" }, actor);
    expect(created.machineSignIn).toMatchObject({ method: "paperclip_key", issuer: ISSUER, tokenUrl: TOKEN_URL, clientId: null, scopes: ["reports.read"] });
    expect(created.machineSignIn.publicKey?.pem).toContain("BEGIN PUBLIC KEY");
    expect(created.connection.status).toBe("draft");
    // The private key is in the vault, nowhere else.
    const serialized = JSON.stringify(created);
    expect(serialized).not.toContain("PRIVATE KEY");
    const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, created.connectionId));
    expect(JSON.stringify(row!.config)).not.toContain("PRIVATE KEY");
    expect(row!.credentialSecretRefs.map((ref) => ref.configPath)).toEqual(["oauth.client_private_key"]);

    // Testing before the key is registered fails clearly and keeps the draft and its key.
    await expect(svc.testMachineSignIn(company.id, created.connectionId, { clientId: CLIENT_ID }, actor))
      .rejects.toMatchObject({ status: 422, details: expect.objectContaining({ code: "client_credentials_rejected" }) });
    expect((await svc.getMachineSignIn(company.id, created.connectionId)).publicKey?.keyId).toBe(created.machineSignIn.publicKey!.keyId);

    registerKey(provider, created.machineSignIn.publicKey!);
    const result = await svc.testMachineSignIn(company.id, created.connectionId, { clientId: CLIENT_ID }, actor);
    expect(result.connection.status).toBe("active");
    expect(result.catalog.map((entry) => entry.name)).toContain("list_reports");

    const accepted = provider.state.tokenRequests.at(-1)!;
    expect(accepted.body.get("scope")).toBe("reports.read");
    expect(accepted.body.get("resource")).toBe(MCP_URL);
    const { header, claims } = decodeJwt(accepted.body.get("client_assertion")!);
    expect(header.kid).toBe(created.machineSignIn.publicKey!.keyId);
    expect(claims).toMatchObject({ iss: CLIENT_ID, sub: CLIENT_ID, aud: TOKEN_URL });
    const authorized = provider.state.mcpRequests.filter((call) => call.authorization === "Bearer machine-token-1");
    expect(authorized.length).toBeGreaterThan(0);
    const listCall = provider.state.mcpRequests.find((call) => call.body.method === "tools/list" && call.authorization);
    expect(JSON.stringify(listCall?.body)).toContain(MCP_OAUTH_CLIENT_CREDENTIALS_EXTENSION_ID);
    const grant = await organizationGrant(created.connectionId);
    expect(grant.status).toBe("active");
    expect(grant.credentialSecretRefs.map((ref) => ref.configPath)).toContain("oauth.access_token");
  });

  it("uses a client secret with client_secret_basic and never returns the secret", async () => {
    const company = await createCompany();
    const provider = useProvider();
    const svc = service();
    const created = await svc.createMachineSignIn(company.id, {
      link: MCP_URL, method: "client_secret", authorizationServer: ISSUER, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
    }, actor);
    expect(created.machineSignIn).toMatchObject({ method: "client_secret", hasClientSecret: true, publicKey: null });
    const result = await svc.testMachineSignIn(company.id, created.connectionId, {}, actor);
    expect(result.connection.status).toBe("active");
    const tokenRequest = provider.state.tokenRequests.at(-1)!;
    expect(tokenRequest.authorization).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`);
    expect(tokenRequest.body.has("client_secret")).toBe(false);
    for (const value of [created, result, await svc.getMachineSignIn(company.id, created.connectionId)]) {
      expect(JSON.stringify(value)).not.toContain(CLIENT_SECRET);
    }
    const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, created.connectionId));
    expect(JSON.stringify(row)).not.toContain(CLIENT_SECRET);
  });

  it("follows the server's challenge to metadata published outside the well-known addresses", async () => {
    const company = await createCompany();
    const provider = useProvider();
    provider.state.metadataOnlyAtHint = true;
    const created = await service().createMachineSignIn(company.id, { link: MCP_URL, method: "paperclip_key" }, actor);
    expect(created.machineSignIn).toMatchObject({ issuer: ISSUER, tokenUrl: TOKEN_URL });
  });

  it("accepts a token URL directly when the provider publishes no sign-in metadata", async () => {
    const company = await createCompany();
    useProvider();
    const created = await service().createMachineSignIn(company.id, {
      link: MCP_URL, method: "client_secret", authorizationServer: TOKEN_URL, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
    }, actor);
    expect(created.machineSignIn).toMatchObject({ issuer: null, tokenUrl: TOKEN_URL });
  });

  it("refuses to follow the server to a different sign-in service and never sends credentials there", async () => {
    const company = await createCompany();
    const provider = useProvider();
    const svc = service();
    const created = await svc.createMachineSignIn(company.id, { link: MCP_URL, method: "paperclip_key" }, actor);
    registerKey(provider, created.machineSignIn.publicKey!);
    provider.state.advertisedIssuers = [OTHER_ISSUER];
    const tokenRequestsBefore = provider.state.tokenRequests.length;
    await expect(svc.testMachineSignIn(company.id, created.connectionId, { clientId: CLIENT_ID }, actor))
      .rejects.toMatchObject({ status: 422, details: expect.objectContaining({ code: "client_credentials_issuer_changed" }) });
    expect(provider.state.tokenRequests.length).toBe(tokenRequestsBefore);
    expect(provider.state.otherIssuerRequests).toBe(0);
    expect((await svc.getMachineSignIn(company.id, created.connectionId)).tokenUrl).toBe(TOKEN_URL);
  });

  it("keeps the pinned token endpoint when an active server's challenge points elsewhere", async () => {
    const company = await createCompany();
    const provider = useProvider();
    const { svc, created } = await setupKeyConnection(company.id, provider);
    provider.state.advertisedIssuers = [OTHER_ISSUER];
    provider.state.rejectAllTokens = true;
    await expect(svc.checkHealth(created.connectionId, actor)).rejects.toMatchObject({
      message: expect.stringContaining("didn't accept this connection's machine sign-in"),
    });
    const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, created.connectionId));
    expect((row!.config.oauth as Record<string, unknown>).tokenUrl).toBe(TOKEN_URL);
    expect((row!.config.oauth as Record<string, unknown>).issuer).toBe(ISSUER);
    expect(provider.state.otherIssuerRequests).toBe(0);
  });

  it("reuses a cached token and shares one token request across concurrent callers", async () => {
    const company = await createCompany();
    const provider = useProvider();
    const { created } = await setupKeyConnection(company.id, provider);
    const grant = await organizationGrant(created.connectionId);
    const issuedAfterSetup = provider.state.issued;

    // A live token is reused: no token request at all.
    const first = service();
    await first.refreshOAuthGrantCredentials({ companyId: company.id, connectionId: created.connectionId, grantId: grant.id, actor });
    expect(provider.state.issued).toBe(issuedAfterSetup);

    // Shortly before expiry, many agents on two server processes ask at once.
    await db.update(connectionGrants).set({
      providerTenant: { ...(grant.providerTenant ?? {}), oauth: { ...((grant.providerTenant ?? {}).oauth as object ?? {}), accessTokenExpiresAt: new Date(Date.now() + 10_000).toISOString() } },
    }).where(eq(connectionGrants.id, grant.id));
    provider.state.tokenDelayMs = 150;
    const second = service();
    const input = { companyId: company.id, connectionId: created.connectionId, grantId: grant.id, actor };
    await Promise.all([
      first.refreshOAuthGrantCredentials(input), first.refreshOAuthGrantCredentials(input), first.refreshOAuthGrantCredentials(input),
      second.refreshOAuthGrantCredentials(input), second.refreshOAuthGrantCredentials(input),
    ]);
    expect(provider.state.issued).toBe(issuedAfterSetup + 1);
    const refreshed = await organizationGrant(created.connectionId);
    const expiresAt = Date.parse(String((refreshed.providerTenant?.oauth as Record<string, unknown>).accessTokenExpiresAt));
    expect(expiresAt).toBeGreaterThan(Date.now() + 3_000_000);
  });

  it("requests a new token when the server rejects the current one", async () => {
    const company = await createCompany();
    const provider = useProvider();
    const { svc, created } = await setupKeyConnection(company.id, provider);
    const issuedAfterSetup = provider.state.issued;
    provider.state.acceptedTokens.clear();
    const health = await svc.checkHealth(created.connectionId, actor);
    expect(health.connection.healthStatus).toBe("ok");
    expect(provider.state.issued).toBe(issuedAfterSetup + 1);
    expect(provider.state.mcpRequests.at(-1)?.authorization).toBe(`Bearer machine-token-${issuedAfterSetup + 1}`);
  });

  it("rotates the key without downtime: the old key works until the new one is registered and confirmed", async () => {
    const company = await createCompany();
    const provider = useProvider();
    const { svc, created } = await setupKeyConnection(company.id, provider);
    const oldKeyId = created.machineSignIn.publicKey!.keyId;
    const started = await svc.rotateMachineSignIn(company.id, created.connectionId, { method: "paperclip_key" }, actor);
    expect(started.completed).toBe(false);
    const pending = started.machineSignIn.pendingPublicKey!;
    expect(pending.keyId).not.toBe(oldKeyId);
    expect(started.machineSignIn.publicKey?.keyId).toBe(oldKeyId);

    // Tokens keep coming from the current key while the new one is pending.
    const grant = await organizationGrant(created.connectionId);
    await svc.refreshOAuthGrantCredentials({ companyId: company.id, connectionId: created.connectionId, grantId: grant.id, forceRefresh: true, actor });
    expect(decodeJwt(provider.state.tokenRequests.at(-1)!.body.get("client_assertion")!).header.kid).toBe(oldKeyId);

    // Completing before the provider knows the new key fails and changes nothing.
    await expect(svc.completeMachineSignInRotation(company.id, created.connectionId, actor))
      .rejects.toMatchObject({ details: expect.objectContaining({ code: "client_credentials_rejected" }) });
    expect((await svc.getMachineSignIn(company.id, created.connectionId)).publicKey?.keyId).toBe(oldKeyId);

    registerKey(provider, pending);
    const completed = await svc.completeMachineSignInRotation(company.id, created.connectionId, actor);
    expect(completed.machineSignIn.publicKey?.keyId).toBe(pending.keyId);
    expect(completed.machineSignIn.pendingPublicKey).toBeNull();
    provider.state.registeredKeys.delete(oldKeyId);
    await svc.refreshOAuthGrantCredentials({ companyId: company.id, connectionId: created.connectionId, grantId: grant.id, forceRefresh: true, actor });
    expect(decodeJwt(provider.state.tokenRequests.at(-1)!.body.get("client_assertion")!).header.kid).toBe(pending.keyId);
    const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, created.connectionId));
    expect(row!.credentialSecretRefs.map((ref) => ref.configPath)).not.toContain("oauth.client_private_key_next");
  });

  it("signs with a key ID that matches the key a refresh actually reads", async () => {
    const company = await createCompany();
    const provider = useProvider();
    const { svc, created } = await setupKeyConnection(company.id, provider);
    // A rotation lands between a refresh loading the settings and reading the
    // vault: the vault holds the new key while config still names the old one.
    const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, created.connectionId));
    const keyRef = row!.credentialSecretRefs.find((ref) => ref.configPath === "oauth.client_private_key")!;
    const next = await generateClientKeyPair("RS256");
    registerKey(provider, { keyId: next.publicKey.keyId, pem: next.publicKey.publicKeyPem });
    await secretService(db).rotate(keyRef.secretId, { value: next.privateKeyPem });
    const grant = await organizationGrant(created.connectionId);
    const before = provider.state.issued;
    await svc.refreshOAuthGrantCredentials({ companyId: company.id, connectionId: created.connectionId, grantId: grant.id, forceRefresh: true, actor });
    expect(provider.state.issued).toBe(before + 1);
    expect(decodeJwt(provider.state.tokenRequests.at(-1)!.body.get("client_assertion")!).header.kid).toBe(next.publicKey.keyId);
  });

  it("never promotes a staged key that changed after it was registered", async () => {
    const company = await createCompany();
    const provider = useProvider();
    const { svc, created } = await setupKeyConnection(company.id, provider);
    const started = await svc.rotateMachineSignIn(company.id, created.connectionId, { method: "paperclip_key" }, actor);
    registerKey(provider, started.machineSignIn.pendingPublicKey!);
    // Another rotation overwrites the staged private key in the vault.
    const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, created.connectionId));
    const staged = row!.credentialSecretRefs.find((ref) => ref.configPath === "oauth.client_private_key_next")!;
    const other = await generateClientKeyPair("RS256");
    registerKey(provider, { keyId: other.publicKey.keyId, pem: other.publicKey.publicKeyPem });
    await secretService(db).rotate(staged.secretId, { value: other.privateKeyPem });
    await expect(svc.completeMachineSignInRotation(company.id, created.connectionId, actor))
      .rejects.toMatchObject({ status: 409, details: expect.objectContaining({ code: "client_credentials_rotation_changed" }) });
    const status = await svc.getMachineSignIn(company.id, created.connectionId);
    expect(status.publicKey?.keyId).toBe(created.machineSignIn.publicKey!.keyId);
    // The current key still signs in.
    const grant = await organizationGrant(created.connectionId);
    await svc.refreshOAuthGrantCredentials({ companyId: company.id, connectionId: created.connectionId, grantId: grant.id, forceRefresh: true, actor });
    expect(decodeJwt(provider.state.tokenRequests.at(-1)!.body.get("client_assertion")!).header.kid).toBe(created.machineSignIn.publicKey!.keyId);
  });

  it("keeps working credentials when a retest's client can't use the server", async () => {
    const company = await createCompany();
    const provider = useProvider();
    const svc = service();
    const created = await svc.createMachineSignIn(company.id, {
      link: MCP_URL, method: "client_secret", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
    }, actor);
    await svc.testMachineSignIn(company.id, created.connectionId, {}, actor);
    provider.state.extraClients.set("other-client", "other-secret");
    provider.state.mcpDeniedClients.add("other-client");
    await expect(svc.testMachineSignIn(company.id, created.connectionId, { clientId: "other-client", clientSecret: "other-secret" }, actor))
      .rejects.toMatchObject({ details: expect.objectContaining({ code: "client_credentials_rejected" }) });
    const status = await svc.getMachineSignIn(company.id, created.connectionId);
    expect(status.clientId).toBe(CLIENT_ID);
    // The working connection still serves tools with the original client.
    const health = await svc.checkHealth(created.connectionId, actor);
    expect(health.connection.healthStatus).toBe("ok");
    expect(provider.state.tokenClients.get(provider.state.mcpRequests.at(-1)!.authorization!.replace("Bearer ", ""))).toBe(CLIENT_ID);

    // A retest that passes gives the organization grant the new token's expiry.
    const grant = await organizationGrant(created.connectionId);
    await db.update(connectionGrants).set({
      providerTenant: { ...(grant.providerTenant ?? {}), oauth: { ...((grant.providerTenant ?? {}).oauth as object ?? {}), accessTokenExpiresAt: "2000-01-01T00:00:00.000Z" } },
    }).where(eq(connectionGrants.id, grant.id));
    await svc.testMachineSignIn(company.id, created.connectionId, {}, actor);
    const retested = await organizationGrant(created.connectionId);
    expect(Date.parse(String((retested.providerTenant?.oauth as Record<string, unknown>).accessTokenExpiresAt))).toBeGreaterThan(Date.now() + 3_000_000);
  });

  it("never reactivates a removed connection", async () => {
    const company = await createCompany();
    const provider = useProvider();
    const { svc, created } = await setupKeyConnection(company.id, provider);
    await svc.archiveConnection(created.connectionId, company.id, actor);
    await expect(svc.testMachineSignIn(company.id, created.connectionId, { clientSecret: CLIENT_SECRET }, actor))
      .rejects.toMatchObject({ details: expect.objectContaining({ code: "client_credentials_connection_removed" }) });
    const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, created.connectionId));
    expect(row!.status).toBe("archived");
  });

  it("does not undo a rotation that lands while a test is running", async () => {
    const company = await createCompany();
    const provider = useProvider();
    const { svc, created } = await setupKeyConnection(company.id, provider);
    provider.state.clientSecret = "switched-secret";
    // While the test talks to the server, an admin switches to a client secret.
    provider.state.onAuthorizedMcpRequest = async () => {
      await svc.rotateMachineSignIn(company.id, created.connectionId, { method: "client_secret", clientSecret: "switched-secret" }, actor);
    };
    await expect(svc.testMachineSignIn(company.id, created.connectionId, {}, actor))
      .rejects.toMatchObject({ status: 409, details: expect.objectContaining({ code: "client_credentials_changed" }) });
    const status = await svc.getMachineSignIn(company.id, created.connectionId);
    expect(status.method).toBe("client_secret");
    const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, created.connectionId));
    expect(row!.credentialSecretRefs.map((ref) => ref.configPath)).not.toContain("oauth.client_private_key");
    // The next token request uses the secret, not the deleted key.
    const grant = await organizationGrant(created.connectionId);
    await svc.refreshOAuthGrantCredentials({ companyId: company.id, connectionId: created.connectionId, grantId: grant.id, forceRefresh: true, actor });
    expect(provider.state.tokenRequests.at(-1)!.authorization).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:switched-secret`).toString("base64")}`);
  });

  it("never leaves a refused test's secret behind with another client ID", async () => {
    const company = await createCompany();
    const provider = useProvider();
    const svc = service();
    const created = await svc.createMachineSignIn(company.id, {
      link: MCP_URL, method: "client_secret", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
    }, actor);
    await svc.testMachineSignIn(company.id, created.connectionId, {}, actor);
    provider.state.extraClients.set("other-client", "other-secret");
    // While one admin tests another client, a second admin starts a key rotation.
    provider.state.onAuthorizedMcpRequest = async () => {
      await svc.rotateMachineSignIn(company.id, created.connectionId, { method: "paperclip_key" }, actor);
    };
    await expect(svc.testMachineSignIn(company.id, created.connectionId, { clientId: "other-client", clientSecret: "other-secret" }, actor))
      .rejects.toMatchObject({ status: 409, details: expect.objectContaining({ code: "client_credentials_changed" }) });
    expect((await svc.getMachineSignIn(company.id, created.connectionId)).clientId).toBe(CLIENT_ID);
    // A normal call (no forced refresh) still runs as the original client: the
    // refused test did not swap in its own token.
    await svc.checkHealth(created.connectionId, actor);
    const used = provider.state.mcpRequests.at(-1)!.authorization!.replace("Bearer ", "");
    expect(provider.state.tokenClients.get(used)).toBe(CLIENT_ID);
    // The refused test wrote nothing: the saved ID and secret still belong together.
    const grant = await organizationGrant(created.connectionId);
    await svc.refreshOAuthGrantCredentials({ companyId: company.id, connectionId: created.connectionId, grantId: grant.id, forceRefresh: true, actor });
    expect(provider.state.tokenRequests.at(-1)!.authorization).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`);
  });

  it("refuses an older retest after another retest replaced both the client ID and secret", async () => {
    const company = await createCompany();
    const provider = useProvider();
    const svc = service();
    const created = await svc.createMachineSignIn(company.id, {
      link: MCP_URL, method: "client_secret", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
    }, actor);
    await svc.testMachineSignIn(company.id, created.connectionId, {}, actor);
    provider.state.extraClients.set("other-client", "other-secret");
    // While one admin re-tests the original client, another replaces both the ID and secret.
    provider.state.onAuthorizedMcpRequest = async () => {
      await svc.testMachineSignIn(company.id, created.connectionId, { clientId: "other-client", clientSecret: "other-secret" }, actor);
    };
    await expect(svc.testMachineSignIn(company.id, created.connectionId, { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }, actor))
      .rejects.toMatchObject({ status: 409, details: expect.objectContaining({ code: "client_credentials_changed" }) });
    expect((await svc.getMachineSignIn(company.id, created.connectionId)).clientId).toBe("other-client");
    const grant = await organizationGrant(created.connectionId);
    await svc.refreshOAuthGrantCredentials({ companyId: company.id, connectionId: created.connectionId, grantId: grant.id, forceRefresh: true, actor });
    expect(provider.state.tokenRequests.at(-1)!.authorization).toBe(`Basic ${Buffer.from("other-client:other-secret").toString("base64")}`);
  });

  it("reloads accepted key types for a connection saved before they were recorded", async () => {
    const company = await createCompany();
    const provider = useProvider();
    provider.state.signingAlgorithms = ["ES256"];
    const svc = service();
    const created = await svc.createMachineSignIn(company.id, {
      link: MCP_URL, method: "client_secret", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
    }, actor);
    await svc.testMachineSignIn(company.id, created.connectionId, {}, actor);
    const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, created.connectionId));
    const { tokenEndpointAuthSigningAlgValuesSupported: _dropped, ...olderOauth } = row!.config.oauth as Record<string, unknown>;
    const olderConfig = { ...row!.config, oauth: olderOauth };
    await db.update(toolConnections).set({ config: olderConfig, transportConfig: olderConfig }).where(eq(toolConnections.id, row!.id));
    const started = await svc.rotateMachineSignIn(company.id, created.connectionId, { method: "paperclip_key" }, actor);
    expect(started.machineSignIn.pendingPublicKey?.algorithm).toBe("ES256");
  });

  it("lets a retest that replaces the secret and normal token refreshes finish together", async () => {
    const company = await createCompany();
    const provider = useProvider();
    const svc = service();
    const created = await svc.createMachineSignIn(company.id, {
      link: MCP_URL, method: "client_secret", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
    }, actor);
    await svc.testMachineSignIn(company.id, created.connectionId, {}, actor);
    const grant = await organizationGrant(created.connectionId);
    const refresh = () => service().refreshOAuthGrantCredentials({ companyId: company.id, connectionId: created.connectionId, grantId: grant.id, forceRefresh: true, actor });
    const started = Date.now();
    await Promise.all([
      svc.testMachineSignIn(company.id, created.connectionId, { clientSecret: CLIENT_SECRET }, actor),
      refresh(), refresh(), refresh(),
    ]);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 60_000);

  it("recovers from a refresh abandoned by a stopped server", async () => {
    const company = await createCompany();
    const provider = useProvider();
    const { svc, created } = await setupKeyConnection(company.id, provider);
    const grant = await organizationGrant(created.connectionId);
    const abandoned = async () => {
      const current = await organizationGrant(created.connectionId);
      await db.update(connectionGrants).set({
        providerTenant: { ...(current.providerTenant ?? {}), oauth: {
          ...((current.providerTenant ?? {}).oauth as object ?? {}),
          accessTokenExpiresAt: "2000-01-01T00:00:00.000Z",
          refreshLease: { id: "stopped-server", expiresAt: "2000-01-01T00:00:00.000Z" },
        } },
      }).where(eq(connectionGrants.id, grant.id));
    };
    // The next request takes over the abandoned lease and gets a new token.
    await abandoned();
    const before = provider.state.issued;
    await svc.refreshOAuthGrantCredentials({ companyId: company.id, connectionId: created.connectionId, grantId: grant.id, actor });
    expect(provider.state.issued).toBe(before + 1);
    // A successful retest also clears an abandoned lease.
    await abandoned();
    await svc.testMachineSignIn(company.id, created.connectionId, {}, actor);
    expect(((await organizationGrant(created.connectionId)).providerTenant?.oauth as Record<string, unknown>).refreshLease).toBeUndefined();
  });

  it("never saves the token of a refresh whose lease was taken over", async () => {
    const company = await createCompany();
    const provider = useProvider();
    const { created } = await setupKeyConnection(company.id, provider);
    const grant = await organizationGrant(created.connectionId);
    const input = { companyId: company.id, connectionId: created.connectionId, grantId: grant.id, forceRefresh: true, actor };
    // Refresh A pauses past its lease; refresh B on another server takes over and finishes.
    provider.state.onTokenRequest = async () => {
      const current = await organizationGrant(created.connectionId);
      const oauth = (current.providerTenant ?? {}).oauth as Record<string, unknown>;
      await db.update(connectionGrants).set({
        providerTenant: { ...(current.providerTenant ?? {}), oauth: { ...oauth, refreshLease: { ...(oauth.refreshLease as object), expiresAt: "2000-01-01T00:00:00.000Z" } } },
      }).where(eq(connectionGrants.id, grant.id));
      await service().refreshOAuthGrantCredentials(input);
    };
    const issuedBefore = provider.state.issued;
    await expect(service().refreshOAuthGrantCredentials(input))
      .rejects.toMatchObject({ details: expect.objectContaining({ code: "oauth_refresh_superseded" }) });
    const takeoverToken = `machine-token-${issuedBefore + 1}`;
    // Normal calls use the takeover's token, not the one the paused refresh received later.
    await service().checkHealth(created.connectionId, actor);
    expect(provider.state.mcpRequests.at(-1)!.authorization).toBe(`Bearer ${takeoverToken}`);
  });

  it("creates the kind of key the sign-in service accepts when switching from a secret", async () => {
    const company = await createCompany();
    const provider = useProvider();
    provider.state.signingAlgorithms = ["ES256"];
    const svc = service();
    const created = await svc.createMachineSignIn(company.id, {
      link: MCP_URL, method: "client_secret", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
    }, actor);
    await svc.testMachineSignIn(company.id, created.connectionId, {}, actor);
    const started = await svc.rotateMachineSignIn(company.id, created.connectionId, { method: "paperclip_key" }, actor);
    expect(started.machineSignIn.pendingPublicKey?.algorithm).toBe("ES256");
  });

  it("tries a new client secret before replacing the old one", async () => {
    const company = await createCompany();
    const provider = useProvider();
    const svc = service();
    const created = await svc.createMachineSignIn(company.id, {
      link: MCP_URL, method: "client_secret", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
    }, actor);
    await svc.testMachineSignIn(company.id, created.connectionId, {}, actor);
    await expect(svc.rotateMachineSignIn(company.id, created.connectionId, { method: "client_secret", clientSecret: "wrong-new-secret" }, actor))
      .rejects.toMatchObject({ details: expect.objectContaining({ code: "client_credentials_rejected" }) });
    const grant = await organizationGrant(created.connectionId);
    // The old secret still works.
    await svc.refreshOAuthGrantCredentials({ companyId: company.id, connectionId: created.connectionId, grantId: grant.id, forceRefresh: true, actor });
    provider.state.clientSecret = "rotated-secret";
    const rotated = await svc.rotateMachineSignIn(company.id, created.connectionId, { method: "client_secret", clientSecret: "rotated-secret" }, actor);
    expect(rotated.completed).toBe(true);
    await svc.refreshOAuthGrantCredentials({ companyId: company.id, connectionId: created.connectionId, grantId: grant.id, forceRefresh: true, actor });
    expect(provider.state.tokenRequests.at(-1)!.authorization).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:rotated-secret`).toString("base64")}`);
  });

  it("refuses machine sign-in on a personal connection", async () => {
    const company = await createCompany();
    useProvider();
    const svc = service();
    const created = await svc.createMachineSignIn(company.id, { link: MCP_URL, method: "client_secret", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }, actor);
    await db.update(toolConnections).set({ credentialPolicy: "per_user" }).where(eq(toolConnections.id, created.connectionId));
    await expect(svc.testMachineSignIn(company.id, created.connectionId, {}, actor))
      .rejects.toMatchObject({ status: 422, details: expect.objectContaining({ code: "client_credentials_personal_refused" }) });
  });

  it("logs setup, verification, rotation and removal without any secret material", async () => {
    const company = await createCompany();
    const provider = useProvider();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "board-user", userName: "Board User", userEmail: null, isInstanceAdmin: true, source: "local_implicit" };
      next();
    });
    app.use("/api", toolAccessRoutes(db, transport));
    app.use(errorHandler);

    const created = await request(app).post(`/api/companies/${company.id}/tools/machine-sign-in`)
      .send({ link: MCP_URL, method: "paperclip_key", clientId: CLIENT_ID });
    expect(created.status).toBe(201);
    registerKey(provider, created.body.machineSignIn.publicKey);
    const connectionId = created.body.connectionId as string;
    expect((await request(app).post(`/api/tool-connections/${connectionId}/machine-sign-in/test`).send({})).status).toBe(200);
    expect((await request(app).post(`/api/tool-connections/${connectionId}/machine-sign-in/rotate`).send({ method: "client_secret", clientSecret: CLIENT_SECRET })).status).toBe(200);
    expect((await request(app).get(`/api/tool-connections/${connectionId}/machine-sign-in`)).body).toMatchObject({ method: "client_secret", hasClientSecret: true });
    expect((await request(app).delete(`/api/tool-connections/${connectionId}`)).status).toBe(200);

    const rows = await db.select().from(activityLog).where(eq(activityLog.entityId, connectionId));
    expect(rows.map((row) => row.action)).toEqual(expect.arrayContaining([
      "tool_connection.machine_sign_in_created",
      "tool_connection.machine_sign_in_verified",
      "tool_connection.machine_sign_in_rotated",
      "tool_connection.archived",
    ]));
    expect(rows.find((row) => row.action === "tool_connection.archived")?.details).toMatchObject({ machineSignIn: true });
    const logged = JSON.stringify(rows);
    expect(logged).not.toContain(CLIENT_SECRET);
    expect(logged).not.toContain("PRIVATE KEY");
    expect(logged).not.toContain("machine-token-");
    // Removal destroys the vault entries the connection owned.
    const remaining = await db.select({ id: companySecrets.id, status: companySecrets.status }).from(companySecrets)
      .where(eq(companySecrets.companyId, company.id));
    expect(remaining.filter((secret) => secret.status === "active")).toEqual([]);
  });

  it("refuses a validation error in plain words", async () => {
    const company = await createCompany();
    useProvider();
    await expect(service().createMachineSignIn(company.id, {
      link: "https://mcp.example.test/mcp?api_key=abc", method: "client_secret",
    }, actor)).rejects.toMatchObject({ status: 400, message: expect.stringContaining("Remove the key from the server address") });
  });
});
