import { readFile } from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, authUsers, companies, companyMemberships, agents, dotAgentBindings, dotMailboxItems, mcpEventSubscriptions, mcpOauthGrants, mcpOauthRequests, mcpOauthTokens } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createPublicMcpOAuth, publicMcpConfig, hashMcpSecret, DEVICE_GRANT } from "../services/public-mcp/oauth.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { dotRunnerBroker } from "../services/dot-runner-broker.js";
import { publicMcpManagementRoutes, publicMcpIngressRoutes } from "../routes/public-mcp.js";

const config = { origin: "https://paperclip.example", resource: "https://paperclip.example/mcp/runner" };
const callback = "https://chatgpt.com/connector_platform_oauth_redirect";
describe("Dot onboarding with an operator-issued pairing capability", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-dot-onboarding-");
    db = createDb(temp.connectionString);
  }, 120000);
  beforeEach(async () => { await instanceSettingsService(db).updateExperimental({ enablePublicMcp: true, enableOpenAiDot: true, enableNativeRunner: false }); });
  afterAll(async () => { await temp?.cleanup(); });
  async function fixture(authorizationOrigin?: string, lifecycleState = "ready") {
    const userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Operator", email: userId + "@example.test", createdAt: new Date(), updatedAt: new Date() });
    const [company] = await db.insert(companies).values({ name: "Dot onboarding", issuePrefix: "DO" + randomBytes(3).toString("hex") }).returning();
    await db.insert(companyMemberships).values({ companyId: company!.id, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "Dot", adapterType: "paperclip_runner", adapterConfig: { provider: "openai_dot" }, lifecycleState, status: lifecycleState === "ready" ? "active" : "paused" }).returning();
    const oauth = createPublicMcpOAuth(db, { ...config, ...(authorizationOrigin ? { authorizationOrigin } : {}) });
    const client = await oauth.register({ client_name: "Dot", redirect_uris: [callback], grant_types: ["authorization_code", "refresh_token", DEVICE_GRANT] }, randomUUID());
    const verifier = randomBytes(32).toString("base64url");
    const input = { client_id: client.client_id, redirect_uri: callback, response_type: "code", resource: config.resource,
      scope: "paperclip:agent offline_access", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" };
    const begin = async (extra = {}) => (await oauth.authorize({ ...input, ...extra })).split("/").at(-1)!;
    const pairing = await dotRunnerBroker(db).createPairing({ companyId: company!.id, agentId: agent!.id, operatorId: userId });
    const id = await begin();
    return { userId, company: company!, agent: agent!, oauth, client, verifier, input, pairing, id, begin };
  }
  async function connect(f: Awaited<ReturnType<typeof fixture>>) {
    const consent = await f.oauth.consentDotPairing(f.id, f.pairing.pairingCode);
    return f.oauth.token({ grant_type: "authorization_code", client_id: f.client.client_id,
      redirect_uri: callback, resource: config.resource, code: new URL(consent.redirectUrl).searchParams.get("code"), code_verifier: f.verifier });
  }

  it("invalidates setup when a broker pairing is applied or revoked", async () => {
    const f = await fixture(undefined, "preparing");
    const consent = await f.oauth.consent(f.id, { type: "board", source: "session", userId: f.userId },
      { decision: "approve", companyId: f.company.id, allowWrites: false });
    const tokens = await f.oauth.token({ grant_type: "authorization_code", client_id: f.client.client_id,
      redirect_uri: callback, resource: config.resource, code: new URL(consent.redirectUrl).searchParams.get("code"), code_verifier: f.verifier });
    const principal = await f.oauth.authenticate(tokens.access_token);
    const broker = dotRunnerBroker(db);
    await broker.pair(principal, f.pairing.pairingCode);
    const [paired] = await db.select().from(agents).where(eq(agents.id, f.agent.id));
    expect(paired.adapterConfig.dotBindingId).toBe(f.pairing.bindingId);
    expect(paired.lifecycleVersion).toBe(f.agent.lifecycleVersion + 1);
    await expect(broker.pair(principal, f.pairing.pairingCode)).rejects.toThrow("Pairing code expired or was consumed");

    await broker.revoke(f.company.id, f.agent.id, f.userId);
    const [revoked] = await db.select().from(agents).where(eq(agents.id, f.agent.id));
    expect(revoked.adapterConfig).not.toHaveProperty("dotBindingId");
    expect(revoked.lifecycleVersion).toBe(paired.lifecycleVersion + 1);
    await expect(f.oauth.authenticate(tokens.access_token)).rejects.toThrow();
  });
  it.each(["preparing", "verifying"])("allows Dot setup during %s without allowing task access", async (state) => {
    const f = await fixture(undefined, state);
    const tokens = await connect(f);
    const principal = await f.oauth.authenticate(tokens.access_token);
    const broker = dotRunnerBroker(db);
    await db.insert(mcpEventSubscriptions).values({ id: randomUUID(), companyId: f.company.id,
      grantId: principal.grant.id, name: "paperclip.dot.mailbox_updated", bindingId: f.pairing.bindingId,
      arguments: {}, deliveryMaterial: {}, verifiedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) });
    await db.insert(dotMailboxItems).values({ companyId: f.company.id, bindingId: f.pairing.bindingId,
      bindingGeneration: 1, kind: "assignment", sourceEventId: randomUUID(), references: { task: "hidden" } });
    await broker.challenge(f.company.id, f.agent.id);
    const inbox = await broker.mailbox(principal);
    expect(inbox.items.map(item => item.kind)).toEqual(["readiness_challenge"]);
    expect(inbox.nextCursor).toBe(0);
    await expect(broker.confirmChallenge(principal, String(inbox.items[0]!.references.challenge))).resolves.toEqual({ status: "ready" });
    expect(await broker.capabilities(principal)).toMatchObject({ ready: false });
    await expect(broker.tasks(principal)).rejects.toThrow("authority");
    await expect(broker.snapshot(f.company.id, f.agent.id, f.pairing.bindingId)).rejects.toThrow("authority");
    await db.update(agents).set({ lifecycleState: "paused" }).where(eq(agents.id, f.agent.id));
    expect((await broker.mailbox(principal)).items).toEqual([]);
    await expect(broker.confirmChallenge(principal, "already-used")).rejects.toThrow("authority");
  });
  it("refreshes a Dot connection after years of inactivity, still rotates and revokes on replay", async () => {
    const f = await fixture();
    const tokens = await connect(f);
    const [stored] = await db.select().from(mcpOauthTokens).where(eq(mcpOauthTokens.tokenHash, hashMcpSecret(tokens.refresh_token!)));
    expect(stored!.expiresAt).toBeNull();
    const refresh = { grant_type: "refresh_token", client_id: f.client.client_id, resource: config.resource, refresh_token: tokens.refresh_token };
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(Date.now() + 2 * 365 * 24 * 60 * 60_000));
      await expect(f.oauth.authenticate(tokens.access_token)).rejects.toThrow();
      const next = await f.oauth.token(refresh);
      expect(next.refresh_token).not.toBe(tokens.refresh_token);
      expect(next.expires_in).toBe(900);
      expect((await f.oauth.authenticate(next.access_token)).actor).toMatchObject({ type: "agent", agentId: f.agent.id });
      const [rotated] = await db.select().from(mcpOauthTokens).where(eq(mcpOauthTokens.tokenHash, hashMcpSecret(next.refresh_token!)));
      expect(rotated!.expiresAt).toBeNull();
      await expect(f.oauth.token(refresh)).rejects.toThrow();
      await expect(f.oauth.authenticate(next.access_token)).rejects.toThrow();
      expect(await dotRunnerBroker(db).bindingForAgent(f.company.id, f.agent.id)).toBeNull();
    } finally { vi.useRealTimers(); }
  });
  it("upgrades valid Dot refresh tokens without reviving expired, used or revoked credentials", async () => {
    const f = await fixture();
    const tokens = await connect(f);
    const grant = (await f.oauth.authenticate(tokens.access_token)).grant;
    const validExpiry = new Date(Date.now() + 30 * 24 * 60 * 60_000);
    await db.update(mcpOauthTokens).set({ expiresAt: validExpiry }).where(eq(mcpOauthTokens.tokenHash, hashMcpSecret(tokens.refresh_token!)));
    const stale = await fixture();
    const staleTokens = await connect(stale);
    const expired = new Date(0);
    await db.update(mcpOauthTokens).set({ expiresAt: expired }).where(eq(mcpOauthTokens.tokenHash, hashMcpSecret(staleTokens.refresh_token!)));
    const personalId = randomUUID();
    const revokedId = randomUUID();
    const usedHash = randomUUID();
    await db.insert(mcpOauthGrants).values([
      { ...grant, id: personalId, purpose: "personal", agentId: null, resource: config.origin + "/mcp/paperclip" },
      { ...grant, id: revokedId, revokedAt: new Date() },
    ]);
    await db.insert(mcpOauthTokens).values([
      { grantId: personalId, tokenHash: randomUUID(), kind: "refresh", expiresAt: validExpiry },
      { grantId: revokedId, tokenHash: randomUUID(), kind: "refresh", expiresAt: validExpiry },
      { grantId: grant.id, tokenHash: usedHash, kind: "refresh", expiresAt: validExpiry, usedAt: new Date() },
    ]);
    const migration = await readFile(new URL("../../../packages/db/src/migrations/0319_heavy_captain_midlands.sql", import.meta.url), "utf8");
    for (let attempt = 0; attempt < 2; attempt++) {
      for (const statement of migration.split("--> statement-breakpoint")) await db.execute(sql.raw(statement));
    }
    const [personal] = await db.select().from(mcpOauthTokens).where(eq(mcpOauthTokens.grantId, personalId));
    const [revoked] = await db.select().from(mcpOauthTokens).where(eq(mcpOauthTokens.grantId, revokedId));
    const [used] = await db.select().from(mcpOauthTokens).where(eq(mcpOauthTokens.tokenHash, usedHash));
    const [staleToken] = await db.select().from(mcpOauthTokens).where(eq(mcpOauthTokens.tokenHash, hashMcpSecret(staleTokens.refresh_token!)));
    expect(personal!.expiresAt).toEqual(validExpiry);
    expect(revoked!.expiresAt).toEqual(validExpiry);
    expect(used!.expiresAt).toEqual(validExpiry);
    expect(staleToken!.expiresAt).toEqual(expired);
    await expect(stale.oauth.token({ grant_type: "refresh_token", client_id: stale.client.client_id, resource: config.resource, refresh_token: staleTokens.refresh_token })).rejects.toThrow();
    const next = await f.oauth.token({ grant_type: "refresh_token", client_id: f.client.client_id, resource: config.resource, refresh_token: tokens.refresh_token });
    expect((await f.oauth.authenticate(next.access_token)).actor).toMatchObject({ type: "agent", agentId: f.agent.id });
    await f.oauth.revokeToken(next.access_token, f.client.client_id);
    await expect(f.oauth.token({ grant_type: "refresh_token", client_id: f.client.client_id, resource: config.resource, refresh_token: next.refresh_token })).rejects.toThrow();
  });
  it("pins browser ingress without changing the issuer, resource or token endpoint", async () => {
    const browserOrigin = "https://paperclip-browser.example:10000";
    const f = await fixture(browserOrigin);
    const personal = createPublicMcpOAuth(db, { ...config, authorizationOrigin: browserOrigin, resource: config.origin + "/mcp/paperclip" });
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "none" }; next(); });
    app.use(publicMcpIngressRoutes(f.oauth, vi.fn()));
    app.use("/api", publicMcpManagementRoutes(personal, f.oauth));
    const metadata = await request(app).get("/.well-known/oauth-authorization-server/mcp/runner/oauth");
    expect(metadata.body).toMatchObject({ issuer: config.origin + "/mcp/runner/oauth",
      authorization_endpoint: browserOrigin + "/mcp/runner/oauth/authorize", token_endpoint: config.origin + "/mcp/runner/oauth/token" });
    const authorization = await request(app).get("/mcp/runner/oauth/authorize").query(f.input);
    expect(authorization.status).toBe(303);
    expect(new URL(authorization.headers.location).origin).toBe(browserOrigin);
    expect(new URL(authorization.headers.location).pathname).toMatch(/^\/dot-connect\/pcmcp_request_[A-Za-z0-9_-]{43}$/);
    const path = `/api/mcp/requests/${f.id}/dot-pairing`;
    expect((await request(app).post(path).set("Origin", "https://other.example").send({ pairingCode: f.pairing.pairingCode })).status).toBe(403);
    const approval = await request(app).post(path).set("Origin", browserOrigin).send({ pairingCode: f.pairing.pairingCode });
    expect(approval.status).toBe(200);
    expect(new URL(approval.body.redirectUrl).searchParams.get("iss")).toBe(config.origin + "/mcp/runner/oauth");
    const device = await f.oauth.deviceAuthorize({ client_id: f.client.client_id, resource: config.resource, scope: "paperclip:agent" }, randomUUID());
    expect(device.verification_uri).toBe(browserOrigin + "/mcp-device");
  });
  it("validates a separately configured browser origin", () => {
    expect(publicMcpConfig({ PAPERCLIP_PUBLIC_URL: config.origin, PAPERCLIP_MCP_AUTHORIZATION_ORIGIN: "https://browser.example:10000" }))
      .toMatchObject({ origin: config.origin, resource: config.origin + "/mcp/paperclip", authorizationOrigin: "https://browser.example:10000" });
    for (const invalid of ["http://browser.example", "https://secret@browser.example", "https://browser.example/path", "https://browser.example?next=evil", "https://browser.example#fragment"])
      expect(() => publicMcpConfig({ PAPERCLIP_PUBLIC_URL: config.origin, PAPERCLIP_MCP_AUTHORIZATION_ORIGIN: invalid })).toThrow();
  });
  it.each(["mcp", "dot-mcp"])("connects via %s without a board session, binds the exact agent, and consumes the capability once", async prefix => {
    const f = await fixture();
    const personal = createPublicMcpOAuth(db, { ...config, resource: config.origin + "/mcp/paperclip" });
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "none" }; next(); });
    app.use("/api", publicMcpManagementRoutes(personal, f.oauth));
    const path = `/api/${prefix}/requests/${f.id}/dot-pairing`;
    expect((await request(app).get(`/api/${prefix}/requests/${f.id}`)).body.agentConnection).toBe(true);
    expect((await request(app).post(path).send({ pairingCode: f.pairing.pairingCode })).status).toBe(403);
    const preview = await request(app).post(path + "/preview").set("Origin", config.origin).send({ pairingCode: f.pairing.pairingCode });
    expect(preview.status).toBe(200);
    expect(preview.body.accessDuration).toBe("Ongoing until revoked. This connection does not expire from inactivity.");
    expect(preview.body).toMatchObject({ company: { id: f.company.id, name: f.company.name }, agent: { id: f.agent.id, name: f.agent.name } });
    expect(JSON.stringify(preview.body)).not.toContain(f.pairing.pairingCode);
    expect(await db.select().from(mcpOauthGrants).where(eq(mcpOauthGrants.userId, f.userId))).toHaveLength(0);
    const approval = await request(app).post(path).set("Origin", config.origin).send({ pairingCode: f.pairing.pairingCode });
    expect(approval.status).toBe(200);
    const redirect = new URL(approval.body.redirectUrl);
    expect(redirect.origin + redirect.pathname).toBe(callback);
    const exchange = { grant_type: "authorization_code", client_id: f.client.client_id, redirect_uri: callback, resource: config.resource,
      code: redirect.searchParams.get("code"), code_verifier: f.verifier };
    await expect(f.oauth.token({ ...exchange, code_verifier: "x".repeat(43) })).rejects.toThrow();
    const tokens = await f.oauth.token(exchange);
    const principal = await f.oauth.authenticate(tokens.access_token);
    expect(principal.actor).toMatchObject({ type: "agent", agentId: f.agent.id, companyId: f.company.id });
    expect(principal.grant.scopes).toEqual(["paperclip:agent", "offline_access"]);
    await expect(personal.authenticate(tokens.access_token)).rejects.toThrow();
    expect(await dotRunnerBroker(db).mailbox(principal)).toMatchObject({ bindingId: f.pairing.bindingId });
    const [binding] = await db.select().from(dotAgentBindings).where(eq(dotAgentBindings.id, f.pairing.bindingId));
    expect(binding).toMatchObject({ status: "connected", pairingCodeHash: null, pairingExpiresAt: null });
    expect((await db.select().from(agents).where(eq(agents.id, f.agent.id)))[0]!.adapterConfig.dotBindingId).toBe(f.pairing.bindingId);
    await expect(f.oauth.consentDotPairing(f.id, f.pairing.pairingCode)).rejects.toThrow();
    await expect(f.oauth.consentDotPairing(await f.begin(), f.pairing.pairingCode)).rejects.toThrow();
  });
  it("does not expose personal assistant requests through the public Dot pairing lane", async () => {
    const f = await fixture();
    const personal = createPublicMcpOAuth(db, { ...config, resource: config.origin + "/mcp/paperclip" });
    const client = await personal.register({ client_name: "Personal", redirect_uris: [callback], grant_types: ["authorization_code"] }, randomUUID());
    const id = (await personal.authorize({ ...f.input, client_id: client.client_id, resource: config.origin + "/mcp/paperclip", scope: "paperclip:read" })).split("/").at(-1)!;
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "none" }; next(); });
    app.use("/api", publicMcpManagementRoutes(personal, f.oauth));
    expect((await request(app).get(`/api/dot-mcp/requests/${id}`)).status).toBe(404);
    for (const suffix of ["", "/preview"]) {
      expect((await request(app).post(`/api/dot-mcp/requests/${id}/dot-pairing${suffix}`).set("Origin", config.origin).send({ pairingCode: f.pairing.pairingCode })).status).toBe(404);
    }
    expect((await request(app).get(`/api/mcp/requests/${id}`)).status).toBe(200);
  });
  it.each(["expired-code", "expired-request", "revoked", "paused", "viewer", "wrong-company", "dot-disabled", "mcp-disabled"])("rejects %s without creating a grant", async failure => {
    const f = await fixture();
    let id = f.id;
    if (failure === "expired-code") await db.update(dotAgentBindings).set({ pairingExpiresAt: new Date(0) }).where(eq(dotAgentBindings.id, f.pairing.bindingId));
    if (failure === "expired-request") await db.update(mcpOauthRequests).set({ expiresAt: new Date(0) }).where(eq(mcpOauthRequests.id, id));
    if (failure === "revoked") await dotRunnerBroker(db).revoke(f.company.id, f.agent.id, f.userId);
    if (failure === "paused") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agent.id));
    if (failure === "viewer") await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(and(eq(companyMemberships.companyId, f.company.id), eq(companyMemberships.principalId, f.userId)));
    if (failure === "wrong-company") id = await f.begin({ company_id: randomUUID() });
    if (failure === "dot-disabled") await instanceSettingsService(db).updateExperimental({ enableOpenAiDot: false });
    if (failure === "mcp-disabled") await instanceSettingsService(db).updateExperimental({ enablePublicMcp: false });
    await expect(f.oauth.describeDotPairing(id, f.pairing.pairingCode)).rejects.toThrow();
    await expect(f.oauth.consentDotPairing(id, f.pairing.pairingCode)).rejects.toThrow();
    expect(await db.select().from(mcpOauthGrants).where(eq(mcpOauthGrants.userId, f.userId))).toHaveLength(0);
  });
  it("prevents concurrent requests and the personal endpoint from spending the same capability", async () => {
    const f = await fixture();
    const personal = createPublicMcpOAuth(db, { ...config, resource: config.origin + "/mcp/paperclip" });
    await expect(personal.consentDotPairing(f.id, f.pairing.pairingCode)).rejects.toMatchObject({ status: 403 });
    const other = await f.begin();
    const results = await Promise.allSettled([f.oauth.consentDotPairing(f.id, f.pairing.pairingCode), f.oauth.consentDotPairing(other, f.pairing.pairingCode)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(await db.select().from(mcpOauthGrants).where(eq(mcpOauthGrants.userId, f.userId))).toHaveLength(1);
  });
});
