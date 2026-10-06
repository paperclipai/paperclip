import { createHmac, createHash, randomBytes, randomUUID } from "node:crypto";
import express, { type Request } from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, mcpEventAdmissions, mcpEventDeliveries, mcpEventSubscriptions, createDb, authUsers, companies, companyLogos, assets, companyMemberships, mcpOauthTokens, mcpOauthRequests, mcpOauthGrants, mcpOauthClients, mcpOauthDeviceRequests, mcpOauthMetadataAdmissions, mcpMutationReceipts, agents, issues, issueComments, instanceUserRoles } from "@paperclipai/db";
import { instanceSettingsService } from "../services/instance-settings.js";
import { createPublicMcpOAuth, publicMcpConfig, hashMcpSecret, DEVICE_GRANT } from "../services/public-mcp/oauth.js";
import { McpApiError, createMcpApiDispatch, createPublicMcpExecutor, publicMcpCapabilities } from "../services/public-mcp/capabilities.js";
import { publicMcpIngressRoutes, publicMcpManagementRoutes } from "../routes/public-mcp.js";
import { authorizationService } from "../services/authorization.js";
import { issueRoutes } from "../routes/issues.js";
import { activityRoutes } from "../routes/activity.js";
import { documentService } from "../services/documents.js";
import { createStorageService } from "../storage/service.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import * as assignmentWakeups from "../services/issue-assignment-wakeup.js";
import { assertCompanyAccess } from "../routes/authz.js";
import { actorMiddleware } from "../middleware/auth.js";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

import { createPublicMcpEvents, publicMcpEventDefinitions } from "../services/public-mcp/events.js";
import { eventFetch, signingKey, type EventFetch } from "../services/public-mcp/event-webhooks.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Public MCP database checks unavailable: ${support.reason}`);
const config = { origin: "https://paperclip.example", resource: "https://paperclip.example/mcp/paperclip" };
const redirectUri = "https://client.example/callback";
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");

describe("public MCP configuration", () => {
  it("uses the configured origin independently of the retired environment gate", () => {
    expect(publicMcpConfig({})).toBeNull();
    expect(() => publicMcpConfig({ PAPERCLIP_PUBLIC_URL: "http://example.com" })).toThrow();
    expect(publicMcpConfig({ PAPERCLIP_PUBLIC_URL: "http://localhost:3100" })?.resource).toBe("http://localhost:3100/mcp/paperclip");
    expect(publicMcpConfig({}, "https://paperclip.example")?.origin).toBe("https://paperclip.example");
    expect(publicMcpConfig({ PAPERCLIP_PUBLIC_MCP_ENABLED: "true" })).toBeNull();
    expect(publicMcpCapabilities.map((c) => c.name)).not.toEqual(expect.arrayContaining(["run_tool", "call_api"]));
  });
});

describe.skipIf(!support.supported)("public MCP OAuth and tool boundary", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let oauth: ReturnType<typeof createPublicMcpOAuth>;
  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", randomBytes(32).toString("base64"));
    temp = await startEmbeddedPostgresTestDatabase("paperclip-public-mcp-");
    db = createDb(temp.connectionString);
    oauth = createPublicMcpOAuth(db, config);
    expect(await oauth.isEnabled()).toBe(false);
    await instanceSettingsService(db).updateExperimental({ enablePublicMcp: true });
  }, 90000);
  afterAll(async () => { await temp?.cleanup(); vi.unstubAllEnvs(); });

  async function fixture(role = "member", write = true) {
    const userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Human", email: userId + "@example.com", createdAt: new Date(), updatedAt: new Date() });
    const [company] = await db.insert(companies).values({ name: "Team", issuePrefix: "M" + randomBytes(4).toString("hex") }).returning();
    const [membership] = await db.insert(companyMemberships).values({ companyId: company!.id, principalType: "user", principalId: userId, membershipRole: role, status: "active" }).returning();
    const actor: Request["actor"] = { type: "board", source: "session", userId };
    const client = await oauth.register({ client_name: "Test client", redirect_uris: [redirectUri] }, randomUUID());
    const url = await oauth.authorize({ client_id: client.client_id, redirect_uri: redirectUri, resource: config.resource, scope: "paperclip:read paperclip:write offline_access", state: "state", response_type: "code", code_challenge: challenge, code_challenge_method: "S256" });
    const id = url.split("/").at(-1)!;
    const consent = await oauth.consent(id, actor, { decision: "approve", companyId: company!.id, allowWrites: write });
    const code = new URL(consent.redirectUrl).searchParams.get("code")!;
    const exchange = { grant_type: "authorization_code", client_id: client.client_id, redirect_uri: redirectUri, resource: config.resource, code, code_verifier: verifier };
    const tokens = await oauth.token(exchange);
    return { actor, company: company!, membership: membership!, client, tokens, exchange };
  }

  async function deviceFixture() {
    const f = await fixture();
    const client = await oauth.register({ client_name: "Device client", redirect_uris: [], grant_types: [DEVICE_GRANT, "refresh_token"], response_types: [] }, randomUUID());
    const codes = await oauth.deviceAuthorize({ client_id: client.client_id, resource: config.resource, scope: "paperclip:read paperclip:write offline_access", company_id: f.company.id }, randomUUID());
    const exchange = { grant_type: DEVICE_GRANT, client_id: client.client_id, resource: config.resource, device_code: codes.device_code };
    return { ...f, deviceClient: client, codes, deviceExchange: exchange };
  }

  it("keeps device codes private and atomically binds approval to the human and company", async () => {
    const f = await deviceFixture();
    const replica = createPublicMcpOAuth(db, config);
    const unauthenticated = await replica.describeDevice(f.codes.user_code, { type: "none" });
    expect(unauthenticated.companies).toEqual([]);
    expect(unauthenticated.requiresSignIn).toBe(true);
    const stored = await db.select().from(mcpOauthDeviceRequests).where(eq(mcpOauthDeviceRequests.clientId, f.deviceClient.client_id));
    expect(JSON.stringify(stored)).not.toContain(f.codes.device_code);
    expect(JSON.stringify(stored)).not.toContain(f.codes.user_code);
    await expect(replica.consentDevice(f.codes.user_code, f.actor, { decision: "approve", companyId: randomUUID(), allowWrites: true })).rejects.toMatchObject({ status: 403 });
    await replica.consentDevice(f.codes.user_code, f.actor, { decision: "approve", companyId: f.company.id, allowWrites: true });
    await expect(replica.token({ ...f.deviceExchange, resource: "https://other.example/mcp" })).rejects.toThrow();
    const results = await Promise.allSettled([oauth.token(f.deviceExchange), replica.token(f.deviceExchange)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const result = results.find(r => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof oauth.token>>>;
    const principal = await oauth.authenticate(result.value.access_token);
    expect(principal.actor.userId).toBe(f.actor.userId);
    expect(principal.grant.companyId).toBe(f.company.id);
    await replica.revokeConnection(principal.grant.id, f.actor.userId!);
    await expect(oauth.authenticate(result.value.access_token)).rejects.toThrow();
    await expect(oauth.token({ grant_type: "refresh_token", client_id: f.deviceClient.client_id, resource: config.resource, refresh_token: result.value.refresh_token })).rejects.toThrow();
  });

  it("persists polling backoff across replicas and handles denied and expired device requests", async () => {
    const f = await deviceFixture();
    await expect(oauth.token(f.deviceExchange)).rejects.toMatchObject({ code: "authorization_pending" });
    const replica = createPublicMcpOAuth(db, config);
    await expect(replica.token(f.deviceExchange)).rejects.toMatchObject({ code: "slow_down" });
    const [stored] = await db.select().from(mcpOauthDeviceRequests).where(eq(mcpOauthDeviceRequests.clientId, f.deviceClient.client_id));
    expect(stored!.intervalSeconds).toBe(10);
    await replica.consentDevice(f.codes.user_code, f.actor, { decision: "deny", allowWrites: false });
    await expect(oauth.token(f.deviceExchange)).rejects.toMatchObject({ code: "access_denied" });
    await db.update(mcpOauthDeviceRequests).set({ expiresAt: new Date(0) }).where(eq(mcpOauthDeviceRequests.id, stored!.id));
    await expect(oauth.token(f.deviceExchange)).rejects.toMatchObject({ code: "expired_token" });
  });

  it("accepts verified CIMD public clients without dynamic registration", async () => {
    const f = await fixture();
    const clientId = "https://client.example/public-mcp.json";
    const cimd = createPublicMcpOAuth(db, config, { metadataFetch: async () => new Response(JSON.stringify({ client_id: clientId, client_name: "CIMD client", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:jwt-bearer"] }), { headers: { "content-type": "application/json" } }) });
    const id = (await cimd.authorize({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", resource: config.resource, code_challenge: challenge, code_challenge_method: "S256" })).split("/").at(-1)!;
    expect((await cimd.describeRequest(id, f.actor, null)).clientOrigin).toBe("https://client.example");
    const consent = await cimd.consent(id, f.actor, { decision: "approve", companyId: f.company.id, allowWrites: false });
    expect(new URL(consent.redirectUrl).searchParams.get("iss")).toBe(config.origin);
    const tokens = await cimd.token({ grant_type: "authorization_code", client_id: clientId, redirect_uri: redirectUri, resource: config.resource, code: new URL(consent.redirectUrl).searchParams.get("code"), code_verifier: verifier });
    expect((await cimd.authenticate(tokens.access_token)).grant.companyId).toBe(f.company.id);
    const [registered] = await db.select().from(mcpOauthClients).where(eq(mcpOauthClients.id, clientId));
    expect(registered!.grantTypes).toEqual(["authorization_code", "refresh_token"]);
    await expect(cimd.token({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", client_id: clientId, resource: config.resource })).rejects.toMatchObject({ code: "unsupported_grant_type" });
  });

  it("admits CIMD clients atomically under durable source quotas and cleans stale registrations", async () => {
    const source = "cimd-quota-source";
    const prefix = `https://quota-${randomUUID()}.example/`;
    const cimd = createPublicMcpOAuth(db, config, { metadataFetch: async url => new Response(JSON.stringify({ client_id: url.toString(), client_name: "Quota client", redirect_uris: [redirectUri] }), { headers: { "content-type": "application/json" } }) });
    const input = { client_id: prefix + "rejected.json", redirect_uri: redirectUri, response_type: "code", resource: "https://wrong.example/mcp", code_challenge: challenge, code_challenge_method: "S256" };
    await expect(cimd.authorize(input, source)).rejects.toThrow();
    expect(await db.select().from(mcpOauthClients).where(eq(mcpOauthClients.id, input.client_id))).toHaveLength(0);
    const old = prefix + "old.json";
    await db.insert(mcpOauthClients).values({ id: old, name: "Expired", redirectUris: [redirectUri], createdAt: new Date(Date.now() - 70 * 60_000) });
    const ids = Array.from({ length: 7 }, (_, i) => prefix + i + ".json");
    try {
      for (const client_id of ids.slice(0, 6)) await cimd.authorize({ ...input, client_id, resource: config.resource }, source);
      await expect(cimd.authorize({ ...input, client_id: ids[6], resource: config.resource }, source)).rejects.toMatchObject({ status: 429 });
      expect(await db.select().from(mcpOauthClients).where(eq(mcpOauthClients.id, ids[6]!))).toHaveLength(0);
      expect(await db.select().from(mcpOauthClients).where(eq(mcpOauthClients.id, old))).toHaveLength(0);
    } finally {
      for (const id of ids) {
        await db.delete(mcpOauthRequests).where(eq(mcpOauthRequests.clientId, id));
        await db.delete(mcpOauthClients).where(eq(mcpOauthClients.id, id));
      }
    }
  });

  describe("CIMD network admission", () => {
    beforeEach(async () => { await db.delete(mcpOauthMetadataAdmissions); });
    afterEach(async () => { await db.delete(mcpOauthMetadataAdmissions); });
    const input = (index: number) => ({ client_id: `https://admission.example/${index}.json`, redirect_uri: redirectUri,
      response_type: "code", resource: config.resource, code_challenge: challenge, code_challenge_method: "S256" });
    const metadata = (url: URL) => new Response(JSON.stringify({ client_id: url.toString(), client_name: "Admission test",
      redirect_uris: [redirectUri], grant_types: ["authorization_code", DEVICE_GRANT] }), { headers: { "content-type": "application/json" } });

    it("rejects wrong resources, scopes and disabled connections before fetching", async () => {
      const fetcher = vi.fn(async (url: URL) => metadata(url));
      const client = createPublicMcpOAuth(db, config, { metadataFetch: fetcher });
      for (const override of [{ resource: "https://wrong.example/mcp" }, { scope: "paperclip:read invalid" }]) {
        await expect(client.authorize({ ...input(0), ...override })).rejects.toThrow();
        await expect(client.deviceAuthorize({ ...input(0), ...override })).rejects.toThrow();
      }
      await instanceSettingsService(db).updateExperimental({ enablePublicMcp: false });
      try {
        await expect(client.authorize(input(0))).rejects.toMatchObject({ status: 503 });
        await expect(client.deviceAuthorize(input(0))).rejects.toMatchObject({ status: 503 });
      } finally { await instanceSettingsService(db).updateExperimental({ enablePublicMcp: true }); }
      expect(fetcher).not.toHaveBeenCalled();
      expect(await db.select().from(mcpOauthMetadataAdmissions)).toHaveLength(0);
    });

    it.each(["fetch failure", "invalid metadata", "redirect mismatch"])("retains admission after %s across replicas and both grants", async mode => {
      const fetcher = vi.fn(async (url: URL) => {
        if (mode === "fetch failure") throw new Error("Remote unavailable");
        if (mode === "invalid metadata") return new Response("{}", { headers: { "content-type": "application/json" } });
        // Browser rejects the callback; device rejects the unsupported grant.
        return new Response(JSON.stringify({ client_id: url.toString(), client_name: "Mismatch", redirect_uris: ["https://other.example/callback"], grant_types: ["authorization_code"] }), { headers: { "content-type": "application/json" } });
      });
      const clients = [createPublicMcpOAuth(db, config, { metadataFetch: fetcher }), createPublicMcpOAuth(db, config, { metadataFetch: fetcher })];
      const outcomes = await Promise.allSettled(Array.from({ length: 12 }, (_, i) =>
        i % 2 ? clients[1]!.deviceAuthorize(input(i), "same-source") : clients[0]!.authorize(input(i), "same-source")));
      expect(fetcher).toHaveBeenCalledTimes(6);
      expect(outcomes.every(result => result.status === "rejected")).toBe(true);
      expect(outcomes.filter(result => result.status === "rejected" && result.reason.status === 429)).toHaveLength(6);
      const receipts = await db.select().from(mcpOauthMetadataAdmissions);
      expect(receipts).toHaveLength(6);
      expect(receipts.every(row => row.sourceHash === hashMcpSecret(config.resource + ":same-source"))).toBe(true);
      expect(JSON.stringify(receipts)).not.toContain("same-source");
      // Expired receipts are pruned on the next attempt, including after restart.
      await db.update(mcpOauthMetadataAdmissions).set({ expiresAt: new Date(0) });
      const restarted = createPublicMcpOAuth(db, config, { metadataFetch: fetcher });
      await expect(restarted.authorize(input(99), "same-source")).rejects.not.toMatchObject({ status: 429 });
      expect(fetcher).toHaveBeenCalledTimes(7);
      expect(await db.select().from(mcpOauthMetadataAdmissions)).toHaveLength(1);
    });

    it("caps unique-source failures globally without blocking registered clients", async () => {
      const fetcher = vi.fn(async () => { throw new Error("Remote unavailable"); });
      const clients = [createPublicMcpOAuth(db, config, { metadataFetch: fetcher }), createPublicMcpOAuth(db, config, { metadataFetch: fetcher })];
      const outcomes = await Promise.allSettled(Array.from({ length: 65 }, (_, i) =>
        i % 2 ? clients[1]!.deviceAuthorize(input(i), `source-${i}`) : clients[0]!.authorize(input(i), `source-${i}`)));
      expect(fetcher).toHaveBeenCalledTimes(60);
      expect(outcomes.filter(result => result.status === "rejected" && result.reason.status === 429)).toHaveLength(5);
      expect(await db.select().from(mcpOauthMetadataAdmissions)).toHaveLength(60);
      const registered = await oauth.register({ client_name: "Local client", redirect_uris: [redirectUri] }, randomUUID());
      await expect(clients[0]!.authorize({ ...input(99), client_id: registered.client_id })).resolves.toContain("/mcp-connect/");
      expect(fetcher).toHaveBeenCalledTimes(60);
    });

    it("commits admission before slow network work without holding the shared lock", async () => {
      let release!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      const fetcher = vi.fn(async () => { await pending; throw new Error("Remote timeout"); });
      const clients = [createPublicMcpOAuth(db, config, { metadataFetch: fetcher }), createPublicMcpOAuth(db, config, { metadataFetch: fetcher })];
      const requests = Array.from({ length: 6 }, (_, i) => clients[i % 2]!.authorize(input(i), "slow-source"));
      const outcomes = Promise.allSettled(requests);
      try {
        await expect.poll(() => fetcher.mock.calls.length).toBe(6);
        await expect(clients[1]!.deviceAuthorize(input(7), "slow-source")).rejects.toMatchObject({ status: 429 });
        expect(await db.select().from(mcpOauthMetadataAdmissions)).toHaveLength(6);
      } finally { release(); await outcomes; }
    });
  });

  it("requires exact redirect, resource, S256 PKCE and real browser consent", async () => {
    await expect(oauth.register({ client_name: "bad", redirect_uris: ["https://u:p@example.com"] })).rejects.toThrow();
    const client = await oauth.register({ client_name: "Client", redirect_uris: [redirectUri] });
    const input = { client_id: client.client_id, redirect_uri: redirectUri, response_type: "code", resource: config.resource, code_challenge: challenge, code_challenge_method: "S256" };
    await expect(oauth.authorize({ ...input, redirect_uri: "https://evil.example" })).rejects.toThrow();
    await expect(oauth.authorize({ ...input, resource: "https://other.example/mcp/paperclip" })).rejects.toThrow();
    await expect(oauth.authorize({ ...input, code_challenge_method: "plain" })).rejects.toThrow();
    const id = (await oauth.authorize(input)).split("/").at(-1)!;
    await expect(oauth.consent(id, { type: "board", source: "local_implicit", userId: "board" }, { decision: "approve", companyId: randomUUID(), allowWrites: true })).rejects.toThrow();
    const f = await fixture();
    const pendingId = (await oauth.authorize(input)).split("/").at(-1)!;
    const pendingConsent = await oauth.consent(pendingId, f.actor, { decision: "approve", companyId: f.company.id, allowWrites: false });
    const pendingCode = new URL(pendingConsent.redirectUrl).searchParams.get("code")!;
    const pendingExchange = { grant_type: "authorization_code", client_id: client.client_id, resource: config.resource, redirect_uri: redirectUri, code: pendingCode, code_verifier: verifier };
    await expect(oauth.token({ ...pendingExchange, code_verifier: randomBytes(32).toString("base64url") })).rejects.toThrow();
    await expect(oauth.token(pendingExchange)).resolves.toHaveProperty("access_token");
    expect(new URL((await oauth.authorize(input)))).toHaveProperty("origin", config.origin);
    await expect(oauth.token(f.exchange)).rejects.toThrow();
    await expect(oauth.token({ ...f.exchange, code_verifier: randomBytes(32).toString("base64url") })).rejects.toThrow();
    const principal = await oauth.authenticate(f.tokens.access_token);
    expect(principal.actor).toMatchObject({ type: "board", source: "mcp_oauth", userId: f.actor.userId, companyIds: [f.company.id], isInstanceAdmin: false });
    const stored = await db.select().from(mcpOauthTokens).where(eq(mcpOauthTokens.grantId, principal.grant.id));
    expect(stored.map((t) => t.tokenHash)).toContain(hashMcpSecret(f.tokens.access_token));
    expect(JSON.stringify(stored)).not.toContain(f.tokens.access_token);
  });

  it("accepts CIMD native ephemeral ports but binds redemption to the authorized callback", async () => {
    const f = await fixture();
    const clientId = "https://native.example/client.json";
    const callback = "http://127.0.0.1:55023/callback";
    const cimd = createPublicMcpOAuth(db, config, { metadataFetch: async () => new Response(JSON.stringify({
      client_id: clientId, client_name: "Native client", application_type: "native", redirect_uris: ["http://127.0.0.1/callback"],
    }), { headers: { "content-type": "application/json" } }) });
    const request = { client_id: clientId, redirect_uri: callback, response_type: "code", resource: config.resource, code_challenge: challenge, code_challenge_method: "S256" };
    await expect(cimd.authorize({ ...request, redirect_uri: "http://127.0.0.1:55023/other" })).rejects.toThrow();
    const id = (await cimd.authorize(request)).split("/").at(-1)!;
    const consent = await cimd.consent(id, f.actor, { decision: "approve", companyId: f.company.id, allowWrites: false });
    expect(new URL(consent.redirectUrl).origin).toBe("http://127.0.0.1:55023");
    const exchange = { grant_type: "authorization_code", client_id: clientId, redirect_uri: callback, resource: config.resource, code: new URL(consent.redirectUrl).searchParams.get("code"), code_verifier: verifier };
    await expect(cimd.token({ ...exchange, redirect_uri: "http://127.0.0.1:55024/callback" })).rejects.toThrow();
    expect((await cimd.authenticate((await cimd.token(exchange)).access_token)).grant.companyId).toBe(f.company.id);
  });

  it("pins consent to the requested organization without exposing other memberships", async () => {
    const f = await fixture();
    const [other] = await db.insert(companies).values({ name: "Other organization", issuePrefix: "M" + randomBytes(4).toString("hex") }).returning();
    await db.insert(companyMemberships).values({ companyId: other!.id, principalType: "user", principalId: f.actor.userId!, membershipRole: "member", status: "active" });
    const input = { client_id: f.client.client_id, redirect_uri: redirectUri, resource: config.resource, response_type: "code",
      code_challenge: challenge, code_challenge_method: "S256", scope: "paperclip:read paperclip:write", company_id: f.company.id };
    const id = (await oauth.authorize(input)).split("/").at(-1)!;
    // The binding survives a new service instance, and the description reveals only this membership.
    const resumed = createPublicMcpOAuth(db, config);
    const [logo] = await db.insert(assets).values({ companyId: f.company.id, provider: "local_disk", objectKey: randomUUID(), contentType: "image/png", byteSize: 1, sha256: "fixture" }).returning();
    await db.insert(companyLogos).values({ companyId: f.company.id, assetId: logo!.id });
    expect(await resumed.describeRequest(id, f.actor, null)).toMatchObject({ requestedCompanyId: f.company.id, companies: [{ id: f.company.id, logoUrl: `/api/assets/${logo!.id}/content` }] });
    expect((await resumed.describeRequest(id, f.actor, null)).companies).toHaveLength(1);
    expect((await resumed.describeRequest(id, { type: "none" }, null)).companies).toEqual([]);
    await expect(resumed.consent(id, f.actor, { decision: "approve", companyId: other!.id, allowWrites: true })).rejects.toMatchObject({ status: 403 });
    // A concurrent conversation has an independent binding; rejection did not consume either request.
    const otherId = (await oauth.authorize({ ...input, company_id: other!.id })).split("/").at(-1)!;
    expect((await resumed.describeRequest(otherId, f.actor, null)).companies).toEqual([{ id: other!.id, name: other!.name, logoUrl: null, canWrite: true }]);
    const consent = await resumed.consent(id, f.actor, { decision: "approve", companyId: f.company.id, allowWrites: true });
    const tokens = await resumed.token({ ...f.exchange, code: new URL(consent.redirectUrl).searchParams.get("code")! });
    expect((await resumed.authenticate(tokens.access_token)).grant.companyId).toBe(f.company.id);
    await expect(resumed.consent(otherId, f.actor, { decision: "approve", companyId: f.company.id, allowWrites: false })).rejects.toMatchObject({ status: 403 });
    await resumed.consent(otherId, f.actor, { decision: "deny", allowWrites: false });
    // Direct connections retain explicit choice across the user's companies.
    const directId = (await oauth.authorize({ ...input, company_id: undefined })).split("/").at(-1)!;
    const direct = await resumed.describeRequest(directId, f.actor, null);
    expect(direct.requestedCompanyId).toBeNull();
    expect(direct.companies.map(c => c.id).sort()).toEqual([f.company.id, other!.id].sort());
    await resumed.consent(directId, f.actor, { decision: "approve", companyId: other!.id, allowWrites: false });
    await expect(oauth.authorize({ ...input, company_id: "invalid" })).rejects.toThrow();
  });

  it("does not fall back to another organization when the requested one is unavailable", async () => {
    const f = await fixture();
    const begin = async (companyId: string) => (await oauth.authorize({ client_id: f.client.client_id, redirect_uri: redirectUri, resource: config.resource,
      response_type: "code", code_challenge: challenge, code_challenge_method: "S256", company_id: companyId })).split("/").at(-1)!;
    const missing = await begin(randomUUID());
    expect((await oauth.describeRequest(missing, f.actor, null)).companies).toEqual([]);
    await expect(oauth.consent(missing, f.actor, { decision: "approve", companyId: f.company.id, allowWrites: false })).rejects.toMatchObject({ status: 403 });
    await oauth.consent(missing, f.actor, { decision: "deny", allowWrites: false });
    for (const unavailable of ["membership", "archived"] as const) {
      const id = await begin(f.company.id);
      if (unavailable === "membership") await db.update(companyMemberships).set({ status: "inactive" }).where(eq(companyMemberships.id, f.membership.id));
      else await db.update(companies).set({ status: "archived" }).where(eq(companies.id, f.company.id));
      expect((await oauth.describeRequest(id, f.actor, null)).companies).toEqual([]);
      await expect(oauth.consent(id, f.actor, { decision: "approve", companyId: f.company.id, allowWrites: false })).rejects.toMatchObject({ status: 403 });
      await oauth.consent(id, f.actor, { decision: "deny", allowWrites: false });
      await db.update(companyMemberships).set({ status: "active" }).where(eq(companyMemberships.id, f.membership.id));
    }
  });

  it("reads the experimental switch live and keeps connection revocation available while disabled", async () => {
    const f = await fixture();
    const revocable = await fixture();
    const settings = instanceSettingsService(db);
    const dispatch = vi.fn();
    const execute = createPublicMcpExecutor(db, oauth, dispatch);
    const app = express(); app.use(express.json());
    app.use(publicMcpIngressRoutes(oauth, execute));
    app.use((req, _res, next) => { req.actor = f.actor; next(); });
    app.use("/api", publicMcpManagementRoutes(oauth));
    try {
      await settings.updateExperimental({ enablePublicMcp: false });
      expect(await createPublicMcpOAuth(db, config).isEnabled()).toBe(false);
      for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp/paperclip"]) {
        expect((await request(app).get(path)).status).toBe(503);
      }
      expect((await request(app).post("/mcp/paperclip").set("Authorization", `Bearer ${f.tokens.access_token}`).send({})).status).toBe(503);
      await expect(oauth.register({ client_name: "disabled", redirect_uris: [redirectUri] })).rejects.toMatchObject({ status: 503 });
      await expect(oauth.token({ grant_type: "refresh_token", client_id: f.client.client_id, resource: config.resource, refresh_token: f.tokens.refresh_token })).rejects.toMatchObject({ status: 503 });
      await expect(execute(f.tokens.access_token, "paperclip_list_agents", { companyId: f.company.id })).rejects.toMatchObject({ status: 503 });
      expect(dispatch).not.toHaveBeenCalled();
      const setup = await request(app).get("/api/mcp/setup").set("X-Forwarded-Host", "attacker.example");
      expect(setup.status).toBe(200);
      expect(setup.headers["cache-control"]).toBe("no-store");
      expect(setup.body).toMatchObject({ enabled: false, serverUrl: config.resource });
      expect((await request(app).get("/api/mcp/connections")).status).toBe(200);
      expect((await request(app).post("/mcp/oauth/revoke").send({ token: revocable.tokens.access_token, client_id: revocable.client.client_id })).status).toBe(200);
    } finally { await settings.updateExperimental({ enablePublicMcp: true }); }
    expect((await request(app).get("/api/mcp/setup")).body).toMatchObject({ enabled: true, serverUrl: config.resource });
    expect((await request(app).get("/.well-known/oauth-authorization-server")).status).toBe(200);
    await expect(oauth.authenticate(f.tokens.access_token)).resolves.toMatchObject({ grant: { userId: f.actor.userId } });
    await expect(oauth.authenticate(revocable.tokens.access_token)).rejects.toThrow();
  });

  it("limits assistant setup metadata to signed-in humans", async () => {
    const app = express();
    let actor: Request["actor"] = { type: "none" };
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", publicMcpManagementRoutes(oauth));
    for (const candidate of [
      { type: "none" },
      { type: "agent", agentId: randomUUID(), companyId: randomUUID() },
      { type: "board", source: "local_implicit", userId: "board" },
      { type: "board", source: "mcp_oauth", userId: randomUUID() },
    ] as Request["actor"][]) {
      actor = candidate;
      expect((await request(app).get("/api/mcp/setup")).status).toBe(401);
    }
    for (const source of ["session", "cloud_tenant"] as const) {
      actor = { type: "board", source, userId: randomUUID() };
      expect((await request(app).get("/api/mcp/setup")).body).toMatchObject({ enabled: true, serverUrl: config.resource });
    }
  });

  it("rotates refresh tokens and persists revocation on replay", async () => {
    const f = await fixture();
    const refresh = { grant_type: "refresh_token", client_id: f.client.client_id, resource: config.resource, refresh_token: f.tokens.refresh_token };
    await expect(oauth.token({ ...refresh, resource: "https://other.example" })).rejects.toThrow();
    const next = await oauth.token(refresh);
    expect(next.refresh_token).not.toBe(f.tokens.refresh_token);
    await expect(oauth.token(refresh)).rejects.toThrow();
    await expect(oauth.authenticate(next.access_token)).rejects.toThrow();
  });

  it("rejects token expiry, revocation and membership loss on the next call", async () => {
    const f = await fixture();
    await db.update(mcpOauthTokens).set({ expiresAt: new Date(0) }).where(eq(mcpOauthTokens.tokenHash, hashMcpSecret(f.tokens.access_token)));
    await expect(oauth.authenticate(f.tokens.access_token)).rejects.toThrow();
    const g = await fixture();
    await db.update(companyMemberships).set({ status: "inactive" }).where(eq(companyMemberships.id, g.membership.id));
    await expect(oauth.authenticate(g.tokens.access_token)).rejects.toThrow();
    const h = await fixture();
    await oauth.revokeToken(h.tokens.access_token, h.client.client_id);
    await expect(oauth.authenticate(h.tokens.access_token)).rejects.toThrow();
  });

  it("rejects cross-company calls, missing write scope and changed viewer roles before dispatch", async () => {
    const f = await fixture("member", false);
    const dispatch = vi.fn();
    const execute = createPublicMcpExecutor(db, oauth, dispatch);
    await expect(execute(f.tokens.access_token, "paperclip_list_agents", { companyId: randomUUID() })).rejects.toThrow();
    const args = { companyId: f.company.id, requestId: randomUUID(), taskId: randomUUID(), body: "feedback" };
    await expect(execute(f.tokens.access_token, "paperclip_add_comment", args)).rejects.toThrow();
    const g = await fixture();
    await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(eq(companyMemberships.id, g.membership.id));
    await expect(execute(g.tokens.access_token, "paperclip_add_comment", { ...args, companyId: g.company.id })).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not accept MCP bearer tokens as ordinary board or agent API credentials", async () => {
    const f = await fixture();
    const app = express();
    app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
    app.get("/api/actor", (req, res) => res.json(req.actor));
    const response = await request(app).get("/api/actor").set("Authorization", `Bearer ${f.tokens.access_token}`);
    expect(response.status).toBe(401);
    expect(response.body).not.toHaveProperty("type", "board");
    expect(response.body).not.toHaveProperty("type", "agent");
  });

  it("isolates concurrent calls and preserves normal HTTP actor permissions", async () => {
    const f = await fixture(); const g = await fixture();
    const api = express.Router(); api.use(boardMutationGuard());
    api.post("/companies/:companyId/issues", (req, res) => { assertCompanyAccess(req, String(req.params.companyId)); res.json({ userId: req.actor.userId, companyId: req.params.companyId, body: req.body }); });
    const dispatch = createMcpApiDispatch(api);
    const fp = await oauth.authenticate(f.tokens.access_token); const gp = await oauth.authenticate(g.tokens.access_token);
    const [one, two] = await Promise.all([dispatch(fp, "POST", `/companies/${f.company.id}/issues`, { title: "one" }), dispatch(gp, "POST", `/companies/${g.company.id}/issues`, { title: "two" })]);
    expect(one).toMatchObject({ userId: f.actor.userId, body: { title: "one" } });
    expect(two).toMatchObject({ userId: g.actor.userId, body: { title: "two" } });
    const unicodeDescription = "字".repeat(50000);
    expect(await dispatch(fp, "POST", `/companies/${f.company.id}/issues`, { description: unicodeDescription })).toHaveProperty("body.description", unicodeDescription);
    await expect(dispatch(fp, "POST", `/companies/${g.company.id}/issues`, {})).rejects.toThrow("403");
  });

  it("replays completed writes, rejects argument changes and contains concurrent/unknown outcomes", async () => {
    const f = await fixture();
    const dispatch = vi.fn().mockResolvedValue({ id: randomUUID(), title: "durable" });
    const execute = createPublicMcpExecutor(db, oauth, dispatch);
    const args = { companyId: f.company.id, requestId: randomUUID(), title: "durable", description: "A report", assigneeAgentId: randomUUID() };
    const first = await execute(f.tokens.access_token, "paperclip_create_task", args);
    expect(await execute(f.tokens.access_token, "paperclip_create_task", args)).toEqual(first);
    const reconnectedClient = await oauth.register({ client_name: "Reconnected assistant", redirect_uris: [redirectUri] });
    const reconnectId = (await oauth.authorize({ client_id: reconnectedClient.client_id, redirect_uri: redirectUri, resource: config.resource, scope: "paperclip:read paperclip:write", response_type: "code", code_challenge: challenge, code_challenge_method: "S256" })).split("/").at(-1)!;
    const reconnectConsent = await oauth.consent(reconnectId, f.actor, { decision: "approve", companyId: f.company.id, allowWrites: true });
    const reconnected = await oauth.token({ grant_type: "authorization_code", client_id: reconnectedClient.client_id, resource: config.resource, redirect_uri: redirectUri, code: new URL(reconnectConsent.redirectUrl).searchParams.get("code"), code_verifier: verifier });
    expect(await execute(reconnected.access_token, "paperclip_create_task", args)).toEqual(first);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[3]).toMatchObject({ status: "todo", title: "durable" });
    await expect(execute(f.tokens.access_token, "paperclip_create_task", { ...args, title: "changed" })).rejects.toThrow("different arguments");
    dispatch.mockRejectedValueOnce(new Error("lost response"));
    const uncertain = { ...args, requestId: randomUUID() };
    expect(await execute(f.tokens.access_token, "paperclip_create_task", uncertain)).toHaveProperty("outcome", "unknown");
    expect(await execute(f.tokens.access_token, "paperclip_create_task", uncertain)).toHaveProperty("outcome", "unknown");
    expect(dispatch).toHaveBeenCalledTimes(2);
    const concurrent = { ...args, requestId: randomUUID() };
    await Promise.all([execute(f.tokens.access_token, "paperclip_create_task", concurrent), execute(f.tokens.access_token, "paperclip_create_task", concurrent)]);
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(await db.select().from(mcpMutationReceipts).where(eq(mcpMutationReceipts.requestId, concurrent.requestId))).toHaveLength(1);
  });

  it("does not re-elevate an instance administrator beyond company-role permissions", async () => {
    const f = await fixture("viewer", false);
    await db.insert(instanceUserRoles).values({ userId: f.actor.userId!, role: "instance_admin" });
    const principal = await oauth.authenticate(f.tokens.access_token);
    const decision = await authorizationService(db).decide({ actor: principal.actor, action: "tasks:assign", resource: { type: "company", companyId: f.company.id } });
    expect(decision.allowed).toBe(false);
  });

  it("uses real task/document routes, creates one durable task, and attributes feedback to the person", async () => {
    const f = await fixture();
    // Capture the existing scheduling boundary without launching a paid/local agent.
    const wake = vi.spyOn(assignmentWakeups, "queueIssueAssignmentWakeup").mockResolvedValue(null);
    try {
      const [agent] = await db.insert(agents).values({ companyId: f.company.id, name: "Researcher", role: "researcher", adapterType: "process", status: "idle" }).returning();
      const api = express.Router(); api.use(boardMutationGuard());
      api.use(issueRoutes(db, createStorageService(createLocalDiskStorageProvider("/tmp/paperclip-public-mcp-unused-storage"))));
      api.use(activityRoutes(db));
      const execute = createPublicMcpExecutor(db, oauth, createMcpApiDispatch(api));
      const args = { companyId: f.company.id, requestId: randomUUID(), title: "Write a durable report", description: "Research the supplied material", assigneeAgentId: agent!.id };
      const result = await execute(f.tokens.access_token, "paperclip_create_task", args);
      expect(result).toHaveProperty("task");
      const task = result.task as { id: string; status: string };
      expect(task.status).toBe("todo");
      expect(await execute(f.tokens.access_token, "paperclip_create_task", args)).toEqual(result);
      expect(await db.select().from(issues).where(eq(issues.companyId, f.company.id))).toHaveLength(1);
      expect(wake).toHaveBeenCalledTimes(1);
      expect(wake.mock.calls[0]?.[0]).toMatchObject({ requestedByActorType: "user", requestedByActorId: f.actor.userId });
      // Avoid starting execution when adding feedback; the existing route accepts a completed task without reopening it.
      await db.update(issues).set({ status: "done", assigneeAgentId: null }).where(eq(issues.id, task.id));
      const commentArgs = { companyId: f.company.id, taskId: task.id, requestId: randomUUID(), body: "Please include the source citations." };
      const feedback = await execute(f.tokens.access_token, "paperclip_add_comment", commentArgs);
      expect(feedback).toHaveProperty("comment.authorUserId", f.actor.userId);
      expect(await execute(f.tokens.access_token, "paperclip_add_comment", commentArgs)).toEqual(feedback);
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, task.id))).toHaveLength(1);
      await documentService(db).upsertIssueDocument({ issueId: task.id, key: "report", title: "Research report", format: "markdown", body: "A concrete durable result.", createdByUserId: f.actor.userId });
      // A fresh executor represents another assistant conversation; no mutable company/session state is shared.
      const later = createPublicMcpExecutor(db, oauth, createMcpApiDispatch(api));
      expect(await later(f.tokens.access_token, "paperclip_read_document", { companyId: f.company.id, taskId: task.id, key: "report" })).toHaveProperty("document.body", "A concrete durable result.");
      const g = await fixture();
      await expect(later(g.tokens.access_token, "paperclip_read_document", { companyId: g.company.id, taskId: task.id, key: "report" })).rejects.toThrow();
      const unavailable = { ...args, requestId: randomUUID(), assigneeAgentId: randomUUID() };
      const rejected = await execute(f.tokens.access_token, "paperclip_create_task", unavailable);
      expect(rejected).toHaveProperty("outcome", "rejected");
      expect(await execute(f.tokens.access_token, "paperclip_create_task", unavailable)).toEqual(rejected);
      expect(wake).toHaveBeenCalledTimes(1);
      // Human assignment to a paused agent is deliberate and allowed by existing routes.
      // Creating its queued task must neither unpause the agent nor claim execution started.
      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agent!.id));
      const paused = await execute(f.tokens.access_token, "paperclip_create_task", { ...args, requestId: randomUUID(), title: "Wait for the paused researcher" });
      expect(paused).toHaveProperty("task.status", "todo");
      expect(paused.scheduling).toContain("does not guarantee execution has started");
      expect((await db.select().from(agents).where(eq(agents.id, agent!.id)))[0]?.status).toBe("paused");
    } finally { wake.mockRestore(); }
  });

  it("exposes discovery and individually named protocol tools, with CSRF-protected management", async () => {
    const f = await fixture();
    const dispatch = vi.fn().mockResolvedValue([{ id: randomUUID(), name: "Engineer", adapterConfig: { secret: "hidden" } }]);
    const app = express(); app.use(express.json());
    app.use(publicMcpIngressRoutes(oauth, createPublicMcpExecutor(db, oauth, dispatch)));
    app.use((req, _res, next) => { req.actor = f.actor; next(); }); app.use("/api", publicMcpManagementRoutes(oauth));
    const discovery = await request(app).get("/.well-known/oauth-authorization-server");
    expect(discovery.body.code_challenge_methods_supported).toEqual(["S256"]);
    expect((await request(app).post("/mcp/paperclip").send({})).status).toBe(401);
    const rpc = (method: string, params?: unknown) => request(app).post("/mcp/paperclip").timeout({ response: 5000, deadline: 7000 }).set("Authorization", `Bearer ${f.tokens.access_token}`).set("Accept", "application/json, text/event-stream").send({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) });
    expect((await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } })).body.result.serverInfo.name).toBe("paperclip");
    const catalog = await rpc("tools/list");
    expect(catalog.body.result.tools).toHaveLength(10);
    expect(catalog.body.result.tools.find((t: { name: string }) => t.name === "paperclip_create_task").annotations.readOnlyHint).toBe(false);
    const result = await rpc("tools/call", { name: "paperclip_list_agents", arguments: { companyId: f.company.id } });
    expect(JSON.stringify(result.body)).not.toContain("hidden");
    expect(result.body.result.structuredContent.agents[0].name).toBe("Engineer");
    dispatch.mockRejectedValueOnce(new Error("Internal database details: tenant-secret"));
    const failed = await rpc("tools/call", { name: "paperclip_list_agents", arguments: { companyId: f.company.id } });
    expect(failed.body.result.isError).toBe(true);
    expect(JSON.stringify(failed.body)).not.toContain("tenant-secret");
    expect(failed.body.result.content[0].text).toContain("could not confirm");
    const pending = await oauth.authorize({ client_id: f.client.client_id, redirect_uri: redirectUri, resource: config.resource, response_type: "code", code_challenge: challenge, code_challenge_method: "S256" });
    vi.stubEnv("PAPERCLIP_CLOUD_API_ORIGIN", "https://cloud.example.test");
    try {
      const described = await request(app).get(`/api/mcp/requests/${pending.split("/").at(-1)}`);
      expect(described.body.setupUrl).toBe("https://cloud.example.test/orgs/new");
    } finally { vi.unstubAllEnvs(); }
    const connection = (await oauth.authenticate(f.tokens.access_token)).grant;
    expect((await request(app).delete(`/api/mcp/connections/${connection.id}`)).status).toBe(403);
    expect((await request(app).delete(`/api/mcp/connections/${connection.id}`).set("Origin", config.origin)).status).toBe(204);
    expect((await db.select().from(mcpOauthGrants).where(eq(mcpOauthGrants.id, connection.id)))[0]?.revokedAt).not.toBeNull();
  });
  it("shares registration quotas across replicas and preserves consented clients during retention", async () => {
    const f = await fixture();
    const stale = "stale-" + randomUUID();
    const old = new Date(Date.now() - 2 * 86_400_000);
    await db.insert(mcpOauthClients).values({ id: stale, name: "Never connected", redirectUris: [redirectUri], createdAt: old });
    await db.update(mcpOauthClients).set({ createdAt: old });
    const replica = createPublicMcpOAuth(db, config);
    const registrations = await Promise.allSettled(Array.from({ length: 70 }, (_, index) => (index % 2 ? oauth : replica).register({ client_name: "Quota fixture", redirect_uris: [redirectUri] }, `quota-source-${index}`)));
    const accepted = registrations.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof oauth.register>>> => r.status === "fulfilled");
    try {
      expect(accepted).toHaveLength(60);
      for (const rejected of registrations.filter(r => r.status === "rejected")) expect((rejected as PromiseRejectedResult).reason).toMatchObject({ status: 429 });
      expect(await db.select().from(mcpOauthClients).where(eq(mcpOauthClients.id, stale))).toHaveLength(0);
      expect(await oauth.authenticate(f.tokens.access_token)).toMatchObject({ grant: { clientId: f.client.client_id } });
    } finally {
      for (const row of accepted) await db.delete(mcpOauthClients).where(eq(mcpOauthClients.id, row.value.client_id));
    }
  });

  it("limits one registration source without denying another source", async () => {
    const source = randomUUID();
    const sourceHash = hashMcpSecret(config.resource + ":" + source);
    const replica = createPublicMcpOAuth(db, config);
    try {
      const batch = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => (i % 2 ? oauth : replica).register({ client_name: "Source quota", redirect_uris: [redirectUri] }, source)));
      expect(batch.filter(r => r.status === "fulfilled")).toHaveLength(6);
      await expect(replica.register({ client_name: "Other source", redirect_uris: [redirectUri] }, randomUUID())).resolves.toHaveProperty("client_id");
      for (let batch = 0; batch < 4; batch++) {
        await db.update(mcpOauthClients).set({ createdAt: new Date(Date.now() - 2 * 60_000) }).where(eq(mcpOauthClients.registrationSourceHash, sourceHash));
        for (let i = 0; i < 6; i++) await replica.register({ client_name: "Source quota", redirect_uris: [redirectUri] }, source);
      }
      await db.update(mcpOauthClients).set({ createdAt: new Date(Date.now() - 2 * 60_000) }).where(eq(mcpOauthClients.registrationSourceHash, sourceHash));
      await expect(oauth.register({ client_name: "Source quota", redirect_uris: [redirectUri] }, source)).rejects.toMatchObject({ status: 429 });
    } finally { await db.delete(mcpOauthClients).where(eq(mcpOauthClients.registrationSourceHash, sourceHash)); }
  });

  it("bounds authorization starts across replicas and reclaims expired requests without another registration", async () => {
    const client = await oauth.register({ client_name: "Request quota", redirect_uris: [redirectUri] }, randomUUID());
    const input = { client_id: client.client_id, redirect_uri: redirectUri, response_type: "code", resource: config.resource, code_challenge: challenge, code_challenge_method: "S256" };
    const replica = createPublicMcpOAuth(db, config);
    const starts = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => (i % 2 ? oauth : replica).authorize(input)));
    expect(starts.filter(r => r.status === "fulfilled")).toHaveLength(10);
    expect(starts.filter(r => r.status === "rejected").map(r => r.reason.status)).toEqual([429, 429]);
    await db.update(mcpOauthRequests).set({ expiresAt: new Date(0) }).where(eq(mcpOauthRequests.clientId, client.client_id));
    await expect(replica.authorize(input)).resolves.toContain("/mcp-connect/");
    expect(await db.select().from(mcpOauthRequests).where(eq(mcpOauthRequests.clientId, client.client_id))).toHaveLength(1);
  });

  it("does not charge completed connections against a shared client's pending consent quota", async () => {
    const f = await fixture();
    const input = { client_id: f.client.client_id, redirect_uri: redirectUri, response_type: "code", resource: config.resource, code_challenge: challenge, code_challenge_method: "S256" };
    for (let i = 0; i < 12; i++) {
      const id = (await oauth.authorize(input)).split("/").at(-1)!;
      const consent = await oauth.consent(id, f.actor, { decision: "approve", companyId: f.company.id, allowWrites: false });
      const code = new URL(consent.redirectUrl).searchParams.get("code")!;
      await expect(oauth.token({ grant_type: "authorization_code", client_id: f.client.client_id, redirect_uri: redirectUri, resource: config.resource, code, code_verifier: verifier })).resolves.toHaveProperty("access_token");
    }
    await expect(oauth.authorize(input)).resolves.toContain("/mcp-connect/");
  });
  async function eventFixture(cloudOrigin?: string) {
    const f = await fixture("member", false);
    const principal = await oauth.authenticate(f.tokens.access_token);
    const [task] = await db.insert(issues).values({ companyId: f.company.id, title: "Event fixture", status: "todo" }).returning();
    let clock = Date.now();
    const secret = "whsec_" + randomBytes(32).toString("base64");
    const received: Array<{ headers: Headers; body: any }> = [];
    let status = 204;
    let cloudAllowed = true;
    let goodChallenge = true;
    let duringVerification: (() => Promise<void>) | undefined;
    const fetcher: EventFetch = async (url, init) => {
      if (cloudOrigin && url === cloudOrigin + "/mcp/paperclip") return cloudAllowed
        ? Response.json({ result: { structuredContent: { user: { id: f.actor.userId }, companyId: f.company.id, connectionId: principal.grant.id } } })
        : new Response(null, { status: 403 });
      const headers = new Headers(init.headers);
      const body = JSON.parse(String(init.body));
      received.push({ headers, body });
      const expected = "v1," + createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${headers.get("webhook-id")}.${headers.get("webhook-timestamp")}.${String(init.body)}`).digest("base64");
      // A rotation test may use another secret; initial deliveries must be independently verifiable.
      if (!String(headers.get("webhook-signature")).includes(expected) && body.type !== "verification") throw new Error("Invalid signature");
      if (body.type === "verification") { await duringVerification?.(); duringVerification = undefined; return Response.json({ challenge: goodChallenge ? body.challenge : "wrong" }); }
      return new Response(null, { status });
    };
    const dispatch = async (p: typeof principal, _method: string, path: string) => {
      const [row] = await db.select().from(issues).where(eq(issues.id, path.split("/").at(-1)!));
      if (!row || row.companyId !== p.grant.companyId) throw new McpApiError(404);
      return row;
    };
    const options = { fetch: fetcher, now: () => clock, ...(cloudOrigin ? { cloudOrigin } : {}) };
    const service = createPublicMcpEvents(db, oauth, dispatch, options);
    const input = { name: "paperclip.task.status_changed", arguments: { companyId: f.company.id, taskId: task!.id, statuses: ["done"] }, delivery: { mode: "webhook", url: "https://receiver.example/events/" + randomUUID(), secret } };
    const activity = async (action = "issue.updated", details: Record<string, unknown> = { status: "done" }) => {
      clock += 100;
      const [row] = await db.insert(activityLog).values({ companyId: f.company.id, actorType: "user", actorId: f.actor.userId!, action, entityType: "issue", entityId: task!.id, details, createdAt: new Date(clock) }).returning();
      return row!;
    };
    return { ...f, principal, task: task!, service, input, received, secret, activity, dispatch, options,
      advance(ms: number) { clock += ms; }, setStatus(value: number) { status = value; }, denyCloud() { cloudAllowed = false; }, duringVerification(fn: () => Promise<void>) { duringVerification = fn; }, badChallenge() { goodChallenge = false; }, now: () => clock };
  }

  it("discovers MCP 2.0 events, validates metadata/headers, and preserves legacy tools", async () => {
    const f = await eventFixture();
    const app = express(); app.use(express.json());
    app.use(publicMcpIngressRoutes(oauth, createPublicMcpExecutor(db, oauth, f.dispatch), f.service));
    const params = { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } };
    const rpc = (method: string, extra = {}, headers: Record<string, string> = {}) => request(app).post("/mcp/paperclip")
      .set({ Authorization: `Bearer ${f.tokens.access_token}`, "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method, ...headers })
      .send({ jsonrpc: "2.0", id: 1, method, params: { ...params, ...extra } });
    expect((await rpc("server/discover")).body.result).toMatchObject({ resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {}, events: {} } });
    expect((await rpc("events/list")).body.result.events.map((e: { name: string }) => e.name)).toEqual(publicMcpEventDefinitions.map(e => e.name));
    expect((await rpc("tools/list")).body.result.tools).toHaveLength(10);
    expect((await rpc("tools/call", { name: "paperclip_connection", arguments: {} }, { "Mcp-Name": "=?base64?cGFwZXJjbGlwX2Nvbm5lY3Rpb24=?=" })).body.result.structuredContent.companyId).toBe(f.company.id);
    expect((await rpc("events/list", {}, { "Mcp-Method": "tools/list" })).body.error.code).toBe(-32020);
    expect((await rpc("events/list", { _meta: {} })).body.error.code).toBe(-32602);
    expect((await rpc("events/list", { cursor: "unknown" })).body.error.code).toBe(-32602);
    const subscribed = await rpc("events/subscribe", f.input);
    expect(subscribed.status).toBe(200); expect(subscribed.body.result.id).toMatch(/^sub_/);
    expect((await rpc("events/unsubscribe", { ...f.input, delivery: { mode: "webhook", url: f.input.delivery.url } })).body.result.resultType).toBe("complete");
  });

  it("persists verified subscriptions, deduplicates refresh and delivers signed filtered events after restart", async () => {
    const f = await eventFixture();
    const first = await f.service.subscribe(f.principal, f.input);
    const reordered = { ...f.input, arguments: { statuses: ["done"], taskId: f.task.id, companyId: f.company.id } };
    const concurrent = await Promise.all([f.service.subscribe(f.principal, reordered), f.service.subscribe(f.principal, f.input)]);
    expect(concurrent.map(s => s.id)).toEqual([first.id, first.id]);
    expect(f.received).toHaveLength(1);
    const [stored] = await db.select().from(mcpEventSubscriptions).where(eq(mcpEventSubscriptions.id, first.id));
    expect(JSON.stringify(stored)).not.toContain(f.secret);
    expect(JSON.stringify(stored)).not.toContain(f.input.delivery.url);
    await f.activity("issue.updated", { status: "in_progress" });
    const matched = await f.activity();
    const replica = createPublicMcpEvents(db, oauth, f.dispatch, f.options);
    await Promise.all([f.service.tick(), replica.tick()]);
    expect(f.received.filter(r => r.body.eventId)).toHaveLength(1);
    expect(f.received.at(-1)!.body).toMatchObject({ eventId: "evt_" + matched.id, name: f.input.name, cursor: null, data: { companyId: f.company.id, taskId: f.task.id, status: "done" } });
    expect(f.received.at(-1)!.headers.get("X-MCP-Subscription-Id")).toBe(first.id);
    await replica.tick(); expect(f.received.filter(r => r.body.eventId)).toHaveLength(1);
    await f.service.unsubscribe(f.principal, f.input);
  });

  it("keeps the longest promised lifetime when cached refreshes overlap across replicas", async () => {
    const f = await eventFixture();
    const first = await f.service.subscribe(f.principal, { ...f.input, ttlMs: 30_000 });
    const replica = createPublicMcpEvents(db, oauth, f.dispatch, f.options);
    const refreshed = await Promise.all([
      f.service.subscribe(f.principal, { ...f.input, ttlMs: 3600_000 }),
      replica.subscribe(f.principal, { ...f.input, ttlMs: 30_000 }),
    ]);
    const [stored] = await db.select().from(mcpEventSubscriptions).where(eq(mcpEventSubscriptions.id, first.id));
    expect(stored!.expiresAt.getTime()).toBe(f.now() + 3600_000);
    expect(refreshed.every(r => Date.parse(r.refreshBefore) <= stored!.expiresAt.getTime())).toBe(true);
    const shorter = await replica.subscribe(f.principal, { ...f.input, ttlMs: 30_000 });
    expect(Date.parse(shorter.refreshBefore)).toBe(stored!.expiresAt.getTime());
    expect(f.received).toHaveLength(1);
    await f.service.unsubscribe(f.principal, f.input);
  });

  it("retries a lost delivery with a stable ID and fresh signature, rotates keys and stops on unsubscribe", async () => {
    const f = await eventFixture();
    await f.service.subscribe(f.principal, f.input);
    await f.activity(); f.setStatus(503); await f.service.tick();
    const failed = f.received.at(-1)!;
    const replacement = "whsec_" + randomBytes(32).toString("base64");
    await f.service.subscribe(f.principal, { ...f.input, delivery: { ...f.input.delivery, secret: replacement } });
    f.advance(10_000); f.setStatus(204); await f.service.tick();
    const retried = f.received.at(-1)!;
    expect(retried.body).toEqual(failed.body);
    expect(retried.headers.get("webhook-timestamp")).not.toBe(failed.headers.get("webhook-timestamp"));
    expect(retried.headers.get("webhook-signature")!.split(" ")).toHaveLength(2);
    await f.service.unsubscribe(f.principal, f.input); await f.service.unsubscribe(f.principal, f.input);
    await f.activity(); const before = f.received.length; await f.service.tick(); expect(f.received).toHaveLength(before);
  });

  it.each([410, 413, 400])("does not retry terminal callback HTTP %s", async status => {
    const f = await eventFixture(); await f.service.subscribe(f.principal, f.input); await f.activity(); f.setStatus(status);
    await f.service.tick(); const before = f.received.length; f.advance(60_000); await f.service.tick();
    expect(f.received).toHaveLength(before); await f.service.unsubscribe(f.principal, f.input);
  });

  it("enforces expiry, fresh consent revocation, membership loss, task isolation and failed verification", async () => {
    const f = await eventFixture();
    await expect(f.service.subscribe(f.principal, { ...f.input, arguments: { ...f.input.arguments, companyId: randomUUID() } })).rejects.toThrow();
    const foreign = await fixture();
    const [foreignTask] = await db.insert(issues).values({ companyId: foreign.company.id, title: "Private" }).returning();
    await expect(f.service.subscribe(f.principal, { ...f.input, arguments: { ...f.input.arguments, taskId: foreignTask!.id } })).rejects.toThrow();
    expect(f.received).toHaveLength(0);
    f.badChallenge(); await expect(f.service.subscribe(f.principal, f.input)).rejects.toMatchObject({ code: -32015, reason: "challenge_failed" });
    expect(await db.select().from(mcpEventSubscriptions).where(eq(mcpEventSubscriptions.grantId, f.principal.grant.id))).toHaveLength(0);
    for (const reason of ["expiry", "revocation", "membership"] as const) {
      const g = await eventFixture(); await g.service.subscribe(g.principal, { ...g.input, ttlMs: 30000 }); await g.activity();
      if (reason === "expiry") g.advance(31000);
      if (reason === "revocation") await oauth.revokeConnection(g.principal.grant.id, g.principal.grant.userId);
      if (reason === "membership") await db.update(companyMemberships).set({ status: "inactive" }).where(eq(companyMemberships.id, g.membership.id));
      await g.service.tick(); expect(g.received.filter(r => r.body.eventId)).toHaveLength(0);
      await g.service.unsubscribe(g.principal, g.input);
    }
  });

  it("retains changes at the subscription start while callback ownership is being verified", async () => {
    const f = await eventFixture();
    f.duringVerification(async () => { f.advance(-100); await f.activity(); });
    await f.service.subscribe(f.principal, f.input);
    await f.service.tick();
    expect(f.received.filter(r => r.body.eventId)).toHaveLength(1);
    await f.service.unsubscribe(f.principal, f.input);
  });

  it("pauses queued event delivery and new subscriptions while the experimental switch is off", async () => {
    const f = await eventFixture();
    const settings = instanceSettingsService(db);
    await f.service.subscribe(f.principal, f.input);
    await f.activity(); f.setStatus(503); await f.service.tick();
    const count = f.received.length;
    try {
      await settings.updateExperimental({ enablePublicMcp: false });
      f.advance(10_000); f.setStatus(204);
      await f.service.tick();
      expect(f.received).toHaveLength(count);
      await expect(f.service.subscribe(f.principal, f.input)).rejects.toMatchObject({ status: 503 });
      await expect(oauth.authorizeGrant(f.principal.grant.id)).rejects.toMatchObject({ status: 503 });
    } finally { await settings.updateExperimental({ enablePublicMcp: true }); }
    await f.service.tick();
    expect(f.received).toHaveLength(count + 1);
    await f.service.unsubscribe(f.principal, f.input);
  });

  it("preserves the final delivery attempt when access is disabled after the tick begins", async () => {
    const f = await eventFixture();
    const settings = instanceSettingsService(db);
    const subscription = await f.service.subscribe(f.principal, f.input);
    await f.activity(); f.setStatus(503); await f.service.tick();
    await db.update(mcpEventDeliveries).set({ attempts: 5 }).where(eq(mcpEventDeliveries.subscriptionId, subscription.id));
    f.advance(10_000); f.setStatus(204);
    const count = f.received.length;
    const authorize = oauth.authorizeGrant.bind(oauth);
    const gate = vi.spyOn(oauth, "authorizeGrant").mockImplementationOnce(async id => {
      await settings.updateExperimental({ enablePublicMcp: false });
      return authorize(id);
    });
    try {
      await f.service.tick();
      expect(f.received).toHaveLength(count);
      const [paused] = await db.select().from(mcpEventDeliveries).where(eq(mcpEventDeliveries.subscriptionId, subscription.id));
      expect(paused).toMatchObject({ attempts: 5, finishedAt: null, outcome: "paused" });
    } finally {
      gate.mockRestore();
      await settings.updateExperimental({ enablePublicMcp: true });
    }
    await f.service.tick();
    expect(f.received).toHaveLength(count + 1);
    const [delivered] = await db.select().from(mcpEventDeliveries).where(eq(mcpEventDeliveries.subscriptionId, subscription.id));
    expect(delivered).toMatchObject({ attempts: 6, outcome: "delivered" });
    expect(delivered!.finishedAt).not.toBeNull();
    await f.service.unsubscribe(f.principal, f.input);
  });

  it("reclaims stopped and expired monitors before admitting another subscription", async () => {
    const f = await eventFixture();
    const makeInput = (index: number) => ({ ...f.input, delivery: { ...f.input.delivery, url: f.input.delivery.url + "/" + index } });
    for (let i = 0; i < 20; i++) await f.service.subscribe(f.principal, makeInput(i));
    const verified = f.received.length;
    await expect(f.service.subscribe(f.principal, makeInput(20))).rejects.toMatchObject({ code: -32602 });
    expect(f.received).toHaveLength(verified);
    await db.update(mcpEventSubscriptions).set({ stoppedAt: new Date(f.now()) }).where(eq(mcpEventSubscriptions.grantId, f.principal.grant.id));
    await expect(f.service.subscribe(f.principal, makeInput(20))).resolves.toHaveProperty("id");
    expect(await db.select().from(mcpEventSubscriptions).where(eq(mcpEventSubscriptions.grantId, f.principal.grant.id))).toHaveLength(1);
    await db.update(mcpEventSubscriptions).set({ expiresAt: new Date(f.now() - 1) }).where(eq(mcpEventSubscriptions.grantId, f.principal.grant.id));
    await expect(f.service.subscribe(f.principal, makeInput(21))).resolves.toHaveProperty("id");
    expect(await db.select().from(mcpEventSubscriptions).where(eq(mcpEventSubscriptions.grantId, f.principal.grant.id))).toHaveLength(1);
    await f.service.unsubscribe(f.principal, makeInput(21));
  });

  it("bounds failed callback attempts across service replicas before doing network work", async () => {
    const f = await eventFixture(); f.badChallenge();
    const replica = createPublicMcpEvents(db, oauth, f.dispatch, f.options);
    const input = (index: number) => ({ ...f.input, delivery: { ...f.input.delivery, url: f.input.delivery.url + "/" + index } });
    for (let i = 0; i < 30; i++) await expect((i % 2 ? replica : f.service).subscribe(f.principal, input(i))).rejects.toMatchObject({ reason: "challenge_failed" });
    expect(f.received).toHaveLength(30);
    await expect(replica.subscribe(f.principal, input(30))).rejects.toThrow("capacity reached");
    expect(f.received).toHaveLength(30);
    expect(await db.select().from(mcpEventAdmissions).where(eq(mcpEventAdmissions.grantId, f.principal.grant.id))).toHaveLength(30);
    f.advance(60_001);
    await expect(replica.subscribe(f.principal, input(31))).rejects.toMatchObject({ reason: "challenge_failed" });
    expect(f.received).toHaveLength(31);
    expect(await db.select().from(mcpEventAdmissions).where(eq(mcpEventAdmissions.grantId, f.principal.grant.id))).toHaveLength(1);
  });

  it("reserves bounded verification capacity without holding transactions and respects unsubscribe", async () => {
    const f = await eventFixture();
    const replica = createPublicMcpEvents(db, oauth, f.dispatch, f.options);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.duringVerification(() => gate);
    const input = (index: number) => ({ ...f.input, delivery: { ...f.input.delivery, url: f.input.delivery.url + "/" + index } });
    const pending = Promise.allSettled([f.service.subscribe(f.principal, input(0)), replica.subscribe(f.principal, input(1))]);
    try {
      await vi.waitFor(() => expect(f.received).toHaveLength(2));
      const held = await db.select().from(mcpEventAdmissions).where(eq(mcpEventAdmissions.grantId, f.principal.grant.id));
      expect(held).toHaveLength(2);
      await db.transaction(async tx => {
        const [locks] = await tx.execute(sql`select pg_try_advisory_xact_lock(736721043) as global_free, pg_try_advisory_xact_lock(hashtextextended(${held[0]!.subscriptionId}, 0)) as subscription_free`);
        expect(locks).toMatchObject({ global_free: true, subscription_free: true });
      });
      await expect(replica.subscribe(f.principal, input(2))).rejects.toThrow("capacity reached");
      expect(f.received).toHaveLength(2);
      await f.service.unsubscribe(f.principal, input(0));
    } finally { release(); }
    const results = await pending;
    expect(results.map(result => result.status)).toEqual(["rejected", "fulfilled"]);
    expect(await db.select().from(mcpEventSubscriptions).where(eq(mcpEventSubscriptions.grantId, f.principal.grant.id))).toHaveLength(1);
    await replica.unsubscribe(f.principal, input(1));
  });

  it.each(["lease", "revocation"])("rejects stale %s authority after callback verification", async reason => {
    const f = await eventFixture();
    f.duringVerification(async () => {
      if (reason === "lease") f.advance(60_001);
      else await oauth.revokeConnection(f.principal.grant.id, f.principal.grant.userId);
    });
    await expect(f.service.subscribe(f.principal, f.input)).rejects.toThrow();
    expect(await db.select().from(mcpEventSubscriptions).where(eq(mcpEventSubscriptions.grantId, f.principal.grant.id))).toHaveLength(0);
  });

  it("filters unchanged statuses and includes native checkout and release transitions", async () => {
    const f = await eventFixture();
    const input = { ...f.input, arguments: { companyId: f.company.id, taskId: f.task.id } };
    await f.service.subscribe(f.principal, input);
    await f.activity("issue.updated", { status: "done", changes: { title: { from: "a", to: "b" } } });
    await f.activity("issue.checked_out", { status: "in_progress", _previous: { status: "in_progress" } });
    await f.activity("issue.checked_out", { status: "in_progress", _previous: { status: "todo" } });
    await f.activity("issue.released", { status: "todo", _previous: { status: "in_progress" } });
    await f.service.tick();
    const delivered = f.received.filter(r => r.body.eventId).map(r => r.body.data.status);
    // Independent webhook deliveries do not promise arrival order.
    expect(delivered).toHaveLength(2);
    expect(delivered).toEqual(expect.arrayContaining(["in_progress", "todo"]));
    await f.service.unsubscribe(f.principal, input);
  });

  it("bounds lifetimes and retries without claiming unsupported replay", async () => {
    const f = await eventFixture();
    const short = await f.service.subscribe(f.principal, { ...f.input, ttlMs: 1 });
    expect(Date.parse(short.refreshBefore)).toBe(f.now() + 30_000);
    const unlimited = await f.service.subscribe(f.principal, { ...f.input, ttlMs: null });
    expect(Date.parse(unlimited.refreshBefore)).toBe(f.now() + 24 * 3600_000);
    expect(unlimited.cursor).toBeNull();
    await expect(f.service.subscribe(f.principal, { ...f.input, cursor: "pretend-replay" })).rejects.toThrow();
    await f.activity(); f.setStatus(503);
    for (let attempt = 0; attempt < 8; attempt++) { await f.service.tick(); f.advance(3600_000); }
    expect(f.received.filter(r => r.body.eventId)).toHaveLength(6);
    expect(new Set(f.received.filter(r => r.body.eventId).map(r => r.body.eventId)).size).toBe(1);
    await f.service.unsubscribe(f.principal, f.input);
  });

  it("does not skip an older activity that commits after a newer event was delivered", async () => {
    const f = await eventFixture(); await f.service.subscribe(f.principal, f.input);
    let release!: () => void;
    let inserted!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { inserted = resolve; });
    const lateId = randomUUID();
    const transaction = db.transaction(async tx => {
      await tx.insert(activityLog).values({ id: lateId, companyId: f.company.id, actorType: "user", actorId: f.actor.userId!, action: "issue.updated", entityType: "issue", entityId: f.task.id, details: { status: "done" }, createdAt: new Date(f.now() + 1) });
      inserted(); await gate;
    });
    try {
      await ready; const newer = await f.activity(); await f.service.tick();
      expect(f.received.filter(r => r.body.eventId).map(r => r.body.eventId)).toEqual(["evt_" + newer.id]);
    } finally { release(); await transaction; }
    await f.service.tick();
    expect(f.received.filter(r => r.body.eventId).at(-1)!.body.eventId).toBe("evt_" + lateId);
    await f.service.unsubscribe(f.principal, f.input);
  });

  it("sends only comment/document references and checks hosted membership on each delivery", async () => {
    const f = await eventFixture("https://cloud.example");
    const authority = { token: "fixture-cloud-proof", expiresAt: f.now() + 60_000 };
    await expect(f.service.subscribe(f.principal, f.input)).rejects.toThrow();
    const subscription = await f.service.subscribe(f.principal, f.input, authority);
    expect(new Date(subscription.refreshBefore).getTime()).toBe(authority.expiresAt);
    await f.activity(); f.denyCloud(); await f.service.tick();
    expect(f.received.filter(r => r.body.eventId)).toHaveLength(0);
    await f.service.unsubscribe(f.principal, f.input);
    const g = await eventFixture();
    for (const [name, action, details] of [
      ["paperclip.task.comment_created", "issue.comment_added", { commentId: randomUUID(), body: "private comment" }],
      ["paperclip.task.document_updated", "issue.document_updated", { key: "report", revisionNumber: 2, body: "private report" }],
    ] as const) {
      const input = { ...g.input, name, arguments: { companyId: g.company.id, taskId: g.task.id } };
      await g.service.subscribe(g.principal, input); await g.activity(action, details); await g.service.tick();
      expect(g.received.at(-1)!.body.name).toBe(name); expect(JSON.stringify(g.received.at(-1)!.body)).not.toContain("private");
      await g.service.unsubscribe(g.principal, input);
    }
  });

});


describe("MCP event outbound boundaries", () => {
  it.each(["https://127.0.0.1/", "https://169.254.169.254/", "https://[::1]/", "https://localhost/"])("rejects callback destination %s before sending", async url => {
    await expect(eventFetch(url, { method: "POST", body: "private" })).rejects.toMatchObject({ code: -32015, reason: "invalid_destination" });
  });
  it("rejects malformed, short and long signing material", () => {
    for (const secret of ["bad", "whsec_%%%", "whsec_" + Buffer.alloc(23).toString("base64"), "whsec_" + Buffer.alloc(65).toString("base64")]) expect(() => signingKey(secret)).toThrow();
    expect(signingKey("whsec_" + Buffer.alloc(32).toString("base64"))).toHaveLength(32);
  });
});
