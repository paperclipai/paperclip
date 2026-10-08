import { createHash, randomBytes, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, authUsers, companies, companyMemberships, agents, dotAgentBindings, mcpOauthGrants, mcpOauthRequests } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createPublicMcpOAuth, publicMcpConfig, DEVICE_GRANT } from "../services/public-mcp/oauth.js";
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
  async function fixture(authorizationOrigin?: string) {
    const userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Operator", email: userId + "@example.test", createdAt: new Date(), updatedAt: new Date() });
    const [company] = await db.insert(companies).values({ name: "Dot onboarding", issuePrefix: "DO" + randomBytes(3).toString("hex") }).returning();
    await db.insert(companyMemberships).values({ companyId: company!.id, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "Dot", adapterType: "paperclip_runner", status: "active" }).returning();
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
  it("connects without a board session, binds the exact agent, and consumes the capability once", async () => {
    const f = await fixture();
    const personal = createPublicMcpOAuth(db, { ...config, resource: config.origin + "/mcp/paperclip" });
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "none" }; next(); });
    app.use("/api", publicMcpManagementRoutes(personal, f.oauth));
    const path = `/api/mcp/requests/${f.id}/dot-pairing`;
    expect((await request(app).post(path).send({ pairingCode: f.pairing.pairingCode })).status).toBe(403);
    const preview = await request(app).post(path + "/preview").set("Origin", config.origin).send({ pairingCode: f.pairing.pairingCode });
    expect(preview.status).toBe(200);
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
