import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, companyMemberships, createDb, connectionGrants, toolCatalogEntries, toolConnections, toolOauthStates } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { toolAccessService } from "../services/tool-access.js";
import { toolAccessRoutes } from "../routes/tool-access.js";
import { errorHandler } from "../middleware/index.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("tool OAuth over local HTTP", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let keyDir: string;

  beforeAll(async () => {
    keyDir = await mkdtemp(join(tmpdir(), "tool-oauth-protocol-"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", join(keyDir, "key"));
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", "http://127.0.0.1:3100");
    vi.stubEnv("PAPERCLIP_TOOL_OAUTH_CLIENT_ID", "");
    vi.stubEnv("PAPERCLIP_TOOL_OAUTH_CLIENT_SECRET", "");
    fixture = await startEmbeddedPostgresTestDatabase("tool-oauth-protocol-");
    db = createDb(fixture.connectionString);
  });

  afterAll(async () => {
    await fixture?.cleanup();
    vi.unstubAllEnvs();
    if (keyDir) await rm(keyDir, { recursive: true, force: true });
  });

  it.each(["none", "client_secret_basic"] as const)("registers, exchanges, and activates a %s client through the routes", async (authMethod) => {
    const userId = `oauth-user-${randomUUID()}`;
    const [company] = await db.insert(companies).values({
      name: "OAuth protocol fixture", issuePrefix: `O${randomUUID().slice(0, 5)}`,
    }).returning();
    await db.insert(companyMemberships).values({
      companyId: company.id, principalType: "user", principalId: userId,
      status: "active", membershipRole: "admin",
    });
    const calls: Array<{ path: string; authorization?: string; body: string }> = [];
    let origin: string;
    let currentAccessToken = "fixture-access";
    let currentRefreshToken = "fixture-refresh";
    const provider = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const path = new URL(req.url!, origin).pathname;
      calls.push({ path, authorization: req.headers.authorization, body });
      const json = (value: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (path.startsWith("/.well-known/oauth-protected-resource")) {
        return json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
      }
      if (path === "/.well-known/oauth-authorization-server") {
        return json({
          issuer: origin, authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`,
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: [authMethod],
          scopes_supported: ["tools.read", "offline_access"],
          grant_types_supported: ["authorization_code", "refresh_token"],
        });
      }
      if (path === "/register") {
        return json({ ...JSON.parse(body), client_id: "fixture-client",
          ...(authMethod === "client_secret_basic" ? { client_secret: "fixture-secret" } : {}),
        });
      }
      if (path === "/token") {
        const refreshing = new URLSearchParams(body).get("grant_type") === "refresh_token";
        if (refreshing) {
          if (new URLSearchParams(body).get("refresh_token") !== currentRefreshToken) {
            return json({ error: "invalid_grant" }, 400);
          }
          currentAccessToken = "fixture-access-rotated";
          currentRefreshToken = "fixture-refresh-rotated";
        }
        return json({ access_token: currentAccessToken, refresh_token: currentRefreshToken,
          expires_in: 3600, token_type: "Bearer", scope: "tools.read offline_access" });
      }
      if (path === "/mcp") {
        if (req.headers.authorization !== `Bearer ${currentAccessToken}`) {
          res.setHeader("www-authenticate", `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);
          return json({}, 401);
        }
        const rpc = JSON.parse(body);
        if (rpc.method === "notifications/initialized") {
          res.writeHead(202).end();
          return;
        }
        return json({ jsonrpc: "2.0", id: rpc.id, result: rpc.method === "initialize"
          ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
          : { tools: [{ name: "read_fixture", description: "Read fixture state", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }] },
        });
      }
      json({}, 404);
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
    try {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.actor = { type: "board", userId, source: "local_implicit", isInstanceAdmin: true };
        next();
      });
      app.use("/api", toolAccessRoutes(db, { deploymentMode: "local_trusted", deploymentExposure: "private", paperclipCloudConnector: null }));
      app.use(errorHandler);

      const connected = await request(app).post(`/api/companies/${company.id}/tools/apps/connect`)
        .send({ link: `${origin}/mcp`, name: "Local OAuth" }).expect(201);
      const authorization = new URL(connected.body.auth.startUrl);
      expect(authorization.origin).toBe(origin);
      expect(authorization.searchParams.get("client_id")).toBe("fixture-client");
      expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorization.searchParams.get("resource")).toBe(`${origin}/mcp`);
      const state = authorization.searchParams.get("state")!;
      const [pending] = await db.select().from(toolOauthStates).where(eq(toolOauthStates.state, state));
      expect(pending.companyId).toBe(company.id);

      const completed = await request(app).get("/api/tools/oauth/callback")
        .query({ state, code: "fixture-code", iss: origin }).expect(200);
      expect(completed.body.catalog).toEqual([expect.objectContaining({ toolName: "read_fixture", riskLevel: "read" })]);
      await request(app).post(`/api/companies/${company.id}/tools/apps/${connected.body.connectionId}/finish`)
        .send({ enabledCatalogEntryIds: completed.body.catalog.map((entry: { id: string }) => entry.id), askFirstCatalogEntryIds: [], access: "all_agents" }).expect(200);

      const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, connected.body.connectionId));
      expect(connection).toMatchObject({ companyId: company.id, status: "active", enabled: true, ownership: "dcr" });
      expect(connection.config.oauth).toMatchObject({ clientId: "fixture-client", clientTokenEndpointAuthMethod: authMethod, clientIssuer: origin });
      expect(JSON.stringify(connection.config)).not.toMatch(/fixture-(access|refresh|secret)/);
      expect(connection.credentialSecretRefs.map((ref) => ref.configPath)).toEqual(expect.arrayContaining(["oauth.access_token", "oauth.refresh_token"]));
      expect(await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, connection.id)))
        .toEqual([expect.objectContaining({ toolName: "read_fixture", status: "active", reviewedByUserId: userId })]);
      const tokenCall = calls.find((call) => call.path === "/token")!;
      const tokenBody = new URLSearchParams(tokenCall.body);
      expect(tokenBody.get("code")).toBe("fixture-code");
      expect(tokenBody.get("code_verifier")).toBe(pending.codeVerifier);
      expect(tokenBody.get("resource")).toBe(`${origin}/mcp`);
      expect(tokenCall.authorization).toBe(authMethod === "client_secret_basic"
        ? `Basic ${Buffer.from("fixture-client:fixture-secret").toString("base64")}` : undefined);
      expect(tokenBody.has("client_secret")).toBe(false);
      expect(calls.some((call) => call.path === "/mcp" && call.authorization === "Bearer fixture-access")).toBe(true);
      expect(calls.filter((call) => call.path === "/register")).toHaveLength(1);

      const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, connection.id));
      const consentedAt = grant.providerTenant?.oauth?.consentedAt;
      expect(consentedAt).toEqual(expect.any(String));
      expect(Number.isFinite(Date.parse(consentedAt!))).toBe(true);
      await db.update(connectionGrants).set({ providerTenant: {
        ...grant.providerTenant,
        oauth: { ...grant.providerTenant?.oauth, accessTokenExpiresAt: new Date(0).toISOString() },
      } }).where(eq(connectionGrants.id, grant.id));
      const options = { deploymentMode: "local_trusted" as const, deploymentExposure: "private" as const, paperclipCloudConnector: null };
      const first = toolAccessService(db, options);
      const second = toolAccessService(db, options);
      const refreshInput = { companyId: company.id, connectionId: connection.id, grantId: grant.id, actor: { actorType: "user" as const, actorId: userId } };
      const refreshed = await Promise.all([
        first.refreshOAuthGrantCredentials(refreshInput),
        second.refreshOAuthGrantCredentials(refreshInput),
      ]);
      expect(refreshed.map(row => row.id)).toEqual([grant.id, grant.id]);
      const exchanges = calls.filter(call => call.path === "/token");
      expect(exchanges).toHaveLength(2);
      const refreshBody = new URLSearchParams(exchanges[1].body);
      expect(refreshBody.get("grant_type")).toBe("refresh_token");
      expect(refreshBody.get("refresh_token")).toBe("fixture-refresh");
      expect(refreshBody.get("resource")).toBe(`${origin}/mcp`);
      expect(exchanges[1].authorization).toBe(tokenCall.authorization);
      const [persistedGrant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id));
      expect(persistedGrant.providerTenant?.oauth).not.toHaveProperty("refreshLease");
      expect(persistedGrant.providerTenant?.oauth?.consentedAt).toBe(consentedAt);
      expect(Date.parse(persistedGrant.providerTenant!.oauth!.accessTokenExpiresAt!)).toBeGreaterThan(Date.now());
      expect(JSON.stringify(persistedGrant)).not.toMatch(/fixture-(access|refresh|secret)/);
      await first.checkHealth(connection.id, { actorType: "user", actorId: userId });
      expect(calls.some(call => call.path === "/mcp" && call.authorization === "Bearer fixture-access-rotated")).toBe(true);
      await db.update(connectionGrants).set({ providerTenant: {
        ...persistedGrant.providerTenant,
        oauth: { ...persistedGrant.providerTenant?.oauth, accessTokenExpiresAt: new Date(0).toISOString() },
      } }).where(eq(connectionGrants.id, grant.id));
      await second.refreshOAuthGrantCredentials(refreshInput);
      const allExchanges = calls.filter(call => call.path === "/token");
      expect(allExchanges).toHaveLength(3);
      expect(new URLSearchParams(allExchanges[2].body).get("refresh_token")).toBe("fixture-refresh-rotated");
      expect(calls.filter(call => call.path === "/register")).toHaveLength(1);
    } finally {
      provider.closeAllConnections();
      await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
    }
  });
});
