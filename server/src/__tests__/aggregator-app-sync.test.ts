import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, companyMemberships, connectionGrants, createDb, toolApplications, toolCatalogEntries, toolConnections, toolConnectionAppSnapshots } from "@paperclipai/db";
import { toolAccessService } from "../services/tool-access.js";
import { secretService } from "../services/secrets.js";
import { toolAccessRoutes } from "../routes/tool-access.js";
import { errorHandler } from "../middleware/error-handler.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Optional reuse of the explicitly disposable browser-test cluster on hosts with limited PostgreSQL startup resources.
const acceptanceDatabaseUrl = process.env.PAPERCLIP_AGGREGATOR_TEST_DATABASE_URL;
if (acceptanceDatabaseUrl && !["127.0.0.1", "localhost"].includes(new URL(acceptanceDatabaseUrl).hostname)) throw new Error("The acceptance database must be local and disposable");
const support = acceptanceDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Managed-account database tests unavailable: ${support.reason}`);
(support.supported ? describe : describe.skip)("provider-neutral account sync", () => {
  let db: ReturnType<typeof createDb>;
  let cleanup: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (acceptanceDatabaseUrl) { db = createDb(acceptanceDatabaseUrl); return; }
    const database = await startEmbeddedPostgresTestDatabase("paperclip-aggregator-sync-"); db = createDb(database.connectionString); cleanup = database.cleanup;
  }, 90_000);
  afterAll(async () => { await cleanup?.(); });
  async function fixture(provider: "arcade" | "executor" = "executor") {
    const [company] = await db.insert(companies).values({ name: "Aggregator sync test", issuePrefix: randomUUID().slice(0, 6).toUpperCase() }).returning();
    const userId = randomUUID();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: userId, membershipRole: "admin", status: "active" });
    const [application] = await db.insert(toolApplications).values({ companyId: company.id, applicationKey: randomUUID(), name: provider, type: "mcp_http", metadata: { sourceTemplateKey: provider } }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId: company.id, applicationId: application.id, uid: randomUUID(), name: `${provider} gateway`, transport: "mcp_remote", authKind: "none", credentialPolicy: "shared", status: "active", enabled: true, config: { sourceTemplateKey: provider, url: provider === "arcade" ? "https://api.arcade.dev/mcp/test" : "https://executor.example/mcp", managementUrl: "https://executor.example/team/integrations" } }).returning();
    await db.insert(connectionGrants).values({ companyId: company.id, connectionId: connection.id, kind: "organization", status: "active", isDefault: true });
    const names = provider === "executor" ? ["integrations"] : ["Notion.ListPages"];
    await db.insert(toolCatalogEntries).values(names.map(toolName => ({ companyId: company.id, connectionId: connection.id, name: toolName, toolName, versionHash: "v1", status: "active", riskLevel: "read" as const })));
    let accounts = [{ integration: "notion", owner: "user", connection: "Work", lastHealth: { status: "healthy", checkedAt: Date.now() } }];
    let fail = false;
    let partial = false;
    const calls: { url: string; method: string; name?: string; authorization?: string }[] = [];
    const access = toolAccessService(db, { remoteHttpRequest: async (url, init) => {
      const rpc = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: String(url), method: init.method ?? "GET", name: rpc?.params?.name, authorization: new Headers(init.headers).get("Authorization") ?? undefined });
      if (rpc?.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { tools: names.map(name => ({ name, inputSchema: { type: "object" } })) } });
      if (fail) return new Response("upstream error with private token", { status: 401 });
      if (!rpc) return Response.json({ items: String(url).includes("/v1/tools") ? [{ qualified_name: names[0], toolkit: { name: "Notion" }, requirements: { met: true, authorization: { provider_id: "notion", token_status: "completed" } } }] : [{ id: "arcade-work", provider_id: "notion", user_id: "arcade-user", connection_status: "active", provider_user_info: { email: "Work" } }] });
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { structuredContent: { items: accounts, hasMore: partial, nextOffset: partial ? 0 : null } } });
    } });
    return { company, connection, actor: { actorType: "user" as const, actorId: userId }, access, calls, disconnect: () => { accounts = []; }, fail: () => { fail = true; }, partial: () => { partial = true; } };
  }
  async function sync(f: Awaited<ReturnType<typeof fixture>>) {
    await f.access.syncAggregatorApps(f.connection.id, true, f.actor);
    let result = await f.access.listAggregatorApps(f.connection.id, f.actor);
    await vi.waitFor(async () => { result = await f.access.listAggregatorApps(f.connection.id, f.actor); expect(result.sync.status).not.toBe("syncing"); }, { timeout: 5000 });
    return result;
  }
  it("replays the account migrations without losing observations or weakening company boundaries", async () => {
    const f = await fixture();
    await sync(f);
    const before = await db.select().from(toolConnectionAppSnapshots).where(eq(toolConnectionAppSnapshots.connectionId, f.connection.id));
    for (const name of ["0295_public_captain_cross", "0296_stiff_thaddeus_ross"]) {
      const migration = await readFile(new URL(`../../../packages/db/src/migrations/${name}.sql`, import.meta.url), "utf8");
      for (const statement of migration.split("--> statement-breakpoint")) await db.execute(sql.raw(statement));
    }
    expect(await db.select().from(toolConnectionAppSnapshots).where(eq(toolConnectionAppSnapshots.connectionId, f.connection.id))).toEqual(before);
    const other = await fixture();
    await expect(db.insert(toolConnectionAppSnapshots).values({ companyId: other.company.id, connectionId: f.connection.id,
      userId: other.actor.actorId, credentialKey: "different", toolkit: "notion", status: "connected", accounts: [] })).rejects.toThrow();
  });
  it("imports and reconciles Executor accounts without new executable connections or access grants", async () => {
    const f = await fixture();
    const grants = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, f.connection.id));
    expect((await sync(f)).apps[0]).toMatchObject({ provider: "executor", appSlug: "notion", status: "connected" });
    expect(await db.select().from(toolConnections).where(eq(toolConnections.companyId, f.company.id))).toHaveLength(1);
    expect(await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, f.connection.id))).toEqual(grants);
    f.disconnect();
    expect((await sync(f)).apps.flatMap(app => app.accounts)).toHaveLength(0);
  });
  it.each(["fail", "partial"] as const)("retains stale observations after %s and isolates users, gateways and credential changes", async failure => {
    const f = await fixture(); await sync(f); f[failure]();
    const result = await sync(f);
    expect(result.sync.status).toBe("error");
    expect(result.apps[0].accounts).toHaveLength(1);
    expect(result.apps[0].errorAt).toBeTruthy();
    expect(JSON.stringify(result)).not.toContain("private token");
    expect((await f.access.listAggregatorApps(f.connection.id, { actorType: "user", actorId: randomUUID() })).apps).toHaveLength(0);
    const other = await fixture(); expect((await other.access.listAggregatorApps(other.connection.id, other.actor)).apps).toHaveLength(0);
    await db.update(toolConnections).set({ config: { ...f.connection.config, url: "https://executor.example/rotated" } }).where(eq(toolConnections.id, f.connection.id));
    expect((await f.access.listAggregatorApps(f.connection.id, f.actor)).apps).toHaveLength(0);
  });
  it("reports unsupported Executor inventory without trying arbitrary tools", async () => {
    const f = await fixture(); await sync(f); f.calls.length = 0; await db.update(toolCatalogEntries).set({ status: "inactive" }).where(eq(toolCatalogEntries.connectionId, f.connection.id));
    expect((await f.access.syncAggregatorApps(f.connection.id, true, f.actor)).discovery.availability).toBe("unsupported");
    expect(f.calls).toHaveLength(0);
    expect((await f.access.listAggregatorApps(f.connection.id, f.actor)).apps[0].freshness).toBe("stale");
  });
  it("reuses an existing Arcade API key and secret-backed user header without extra sync setup", async () => {
    const f = await fixture("arcade");
    const key = await secretService(db).create(f.company.id, { name: "Arcade project", provider: "local_encrypted", value: "existing-key" }, { userId: f.actor.actorId });
    const user = await secretService(db).create(f.company.id, { name: "Arcade user", provider: "local_encrypted", value: "arcade-user" }, { userId: f.actor.actorId });
    await db.update(toolConnections).set({ authKind: "api_key", credentialRefs: [
      { name: "authorization", secretId: key.id, placement: "header", key: "Authorization", prefix: "Bearer " },
      { name: "headers.Arcade-User-ID", secretId: user.id, placement: "header", key: "Arcade-User-ID", prefix: "" },
    ], credentialSecretRefs: [
      { secretId: key.id, configPath: "credentials.authorization", versionSelector: "latest" },
      { secretId: user.id, configPath: "headers.Arcade-User-ID", versionSelector: "latest" },
    ] }).where(eq(toolConnections.id, f.connection.id));
    for (const [secretId, configPath] of [[key.id, "credentials.authorization"], [user.id, "headers.Arcade-User-ID"]]) await secretService(db).createBinding({ companyId: f.company.id, secretId, targetType: "tool_connection", targetId: f.connection.id, configPath });
    expect((await f.access.listAggregatorApps(f.connection.id, f.actor)).discovery.availability).toBe("available");
    expect((await sync(f)).apps[0]).toMatchObject({ provider: "arcade", appSlug: "notion" });
    expect(f.calls.filter(call => call.method === "GET").every(call => call.authorization === "Bearer existing-key")).toBe(true);
  });

  it("keeps optional Arcade discovery credentials in the vault, uses them only for discovery, and invalidates rotation", async () => {
    const f = await fixture("arcade");
    expect((await f.access.listAggregatorApps(f.connection.id, f.actor)).discovery.availability).toBe("setup_required");
    await f.access.configureArcadeDiscovery(f.connection.id, { apiKey: "project-discovery-key", userId: "arcade-user" }, f.actor);
    const result = await sync(f);
    expect(result.apps[0]).toMatchObject({ provider: "arcade", appSlug: "notion" });
    const [saved] = await db.select().from(toolConnections).where(eq(toolConnections.id, f.connection.id));
    expect(JSON.stringify(saved)).not.toContain("project-discovery-key");
    expect(saved.credentialSecretRefs).toHaveLength(0);
    expect(f.calls.filter(call => call.method === "POST").every(call => call.authorization !== "Bearer project-discovery-key")).toBe(true);
    expect(f.calls.filter(call => call.method === "GET").every(call => call.authorization === "Bearer project-discovery-key")).toBe(true);
    const metadata = (saved.config.aggregatorDiscovery as Record<string, { secretId: string }>)[f.actor.actorId];
    await secretService(db).rotateCurrentUserSecretValue(f.company.id, f.actor.actorId, metadata.secretId, { value: "rotated-discovery-key" }, { userId: f.actor.actorId });
    expect((await f.access.listAggregatorApps(f.connection.id, f.actor)).apps).toHaveLength(0);
    expect(await db.select().from(toolConnectionAppSnapshots).where(eq(toolConnectionAppSnapshots.connectionId, f.connection.id))).toHaveLength(1);
    expect((await sync(f)).apps[0].accounts).toHaveLength(1);
    expect(f.calls.filter(call => call.method === "GET").at(-1)?.authorization).toBe("Bearer rotated-discovery-key");
  });
  it("rejects optional sync configuration by ordinary members and agents", async () => {
    const f = await fixture("arcade");
    const memberId = randomUUID();
    await db.insert(companyMemberships).values({ companyId: f.company.id, principalType: "user", principalId: memberId, membershipRole: "member", status: "active" });
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = req.headers["x-test-agent"] ? { type: "agent", agentId: randomUUID(), companyId: f.company.id } : { type: "board", userId: memberId, source: "session", isInstanceAdmin: false, companyIds: [f.company.id] }; next(); });
    app.use("/api", toolAccessRoutes(db)); app.use(errorHandler);
    for (const agent of [false, true]) {
      const response = await request(app).put(`/api/tool-connections/${f.connection.id}/aggregator/discovery`).set("x-test-agent", agent ? "yes" : "").send({ apiKey: "not-saved", userId: "arcade-user" });
      expect(response.status).toBe(403);
    }
    const [saved] = await db.select().from(toolConnections).where(eq(toolConnections.id, f.connection.id));
    expect(saved.config.aggregatorDiscovery).toBeUndefined();
  });

  it("enforces company membership and connection-manager access on all generic endpoints", async () => {
    const f = await fixture("arcade");
    const app = express(); app.use(express.json());
    let viewingUser = randomUUID();
    app.use((req, _res, next) => { req.actor = { type: "board", userId: viewingUser, source: "session", isInstanceAdmin: false, companyIds: viewingUser === f.actor.actorId ? [f.company.id] : [] }; next(); });
    app.use("/api", toolAccessRoutes(db)); app.use(errorHandler);
    for (const path of ["/aggregator/apps", "/aggregator/apps/sync", "/aggregator/apps/refresh", "/aggregator/discovery"]) {
      const endpoint = `/api/tool-connections/${f.connection.id}${path}`;
      const response = path.endsWith("discovery") ? await request(app).put(endpoint).send({ apiKey: "no", userId: "no" }) : path.endsWith("apps") ? await request(app).get(endpoint) : await request(app).post(endpoint).send({});
      expect([403, 404]).toContain(response.status);
    }
    viewingUser = f.actor.actorId;
    await request(app).get(`/api/tool-connections/${f.connection.id}/aggregator/apps`).expect(200).expect("Cache-Control", "private, no-store");
  });
});
