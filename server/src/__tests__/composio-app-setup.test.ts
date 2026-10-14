import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, companyMemberships, connectionGrants, createDb, issues, toolApplications, toolCatalogEntries, toolConnections, toolConnectionAppSnapshots } from "@paperclipai/db";
import { composioAppSetupSchema } from "@paperclipai/shared";
import { composioAppAccounts, composioAppSetupResult } from "../services/composio-app-setup.js";
import { toolAccessService } from "../services/tool-access.js";
import { toolAccessPolicyService } from "../services/tool-access-policy.js";
import { toolAccessRoutes } from "../routes/tool-access.js";
import { errorHandler } from "../middleware/error-handler.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("Composio app authorization evidence", () => {
  it("completes app setup without an agent selection", () => {
    expect(composioAppSetupSchema.parse({ action: "complete" })).toEqual({ action: "complete" });
    expect(composioAppSetupSchema.safeParse({ action: "complete", agentId: randomUUID() }).success).toBe(false);
  });
  it("keeps only the requested app's account identities and never treats missing or malformed evidence as an empty list", () => {
    const response = { results: { gmail: { accounts: [{ id: "gmail", status: "ACTIVE" }] }, circleback_mcp: { accounts: [{ id: "ca_1", alias: "Work", status: "active", is_default: true, access_token: "secret" }] } } };
    expect(composioAppAccounts(response, "circleback_mcp")).toEqual([{ id: "ca_1", alias: "Work", status: "ACTIVE", isDefault: true }]);
    expect(composioAppAccounts(response, "missing")).toBeUndefined();
    expect(composioAppAccounts({ circleback_mcp: { accounts: [] } }, "circleback_mcp")).toEqual([]);
    expect(composioAppAccounts({ circleback_mcp: { accounts: [{ status: "active" }] } }, "circleback_mcp")).toBeUndefined();
    expect(() => composioAppAccounts({ circleback_mcp: { error: "expired", accounts: [] } }, "circleback_mcp")).toThrow("could not check");
  });
  it("accepts a hosted link and only verifies the requested toolkit", () => {
    expect(composioAppSetupResult({ results: { circleback_mcp: { redirect_url: "https://connect.composio.dev/link/test" } } }, "circleback_mcp"))
      .toEqual({ status: "authorization_required", authorizationUrl: "https://connect.composio.dev/link/test" });
    expect(composioAppSetupResult({ results: { gmail: { status: "ACTIVE" }, circleback_mcp: { accounts: [{ status: "INITIATED" }] } } }, "circleback_mcp"))
      .toEqual({ status: "not_connected" });
    expect(composioAppSetupResult({ result: { content: [{ type: "text", text: JSON.stringify({ results: { circleback_mcp: { accounts: [{ status: "ACTIVE" }] } } }) }] } }, "circleback_mcp"))
      .toEqual({ status: "connected" });
  });
  it("rejects provider failures and untrusted handoff URLs", () => {
    expect(() => composioAppSetupResult({ isError: true }, "circleback_mcp")).toThrow("could not configure");
    expect(composioAppSetupResult({ redirect_url: "https://untrusted.example/link/test" }, "circleback_mcp")).toEqual({ status: "not_connected" });
  });
  it("recognizes the lowercase account status returned by the live Composio gateway", () => {
    const response = { result: { content: [{ type: "text", text: JSON.stringify({
      data: { results: { circleback_mcp: { toolkit: "circleback_mcp", status: "active", accounts: [{ status: "active", is_default: true }] } } },
      error: null, successful: true,
    }) }], isError: false } };
    expect(composioAppSetupResult(response, "circleback_mcp")).toEqual({ status: "connected" });
    expect(composioAppSetupResult(response, "gmail")).toEqual({ status: "not_connected" });
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("direct Composio setup", () => {
  let db: ReturnType<typeof createDb>;
  let cleanup: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-composio-setup-");
    db = createDb(database.connectionString);
    cleanup = database.cleanup;
  }, 20_000);
  afterAll(async () => { await cleanup?.(); });

  async function fixture(syncToolkits: string[] = ["circleback_mcp", "notion", "hubspot"]) {
    const [company] = await db.insert(companies).values({ name: "Composio direct setup", issuePrefix: randomUUID().slice(0, 6).toUpperCase() }).returning();
    const userId = randomUUID();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: userId, membershipRole: "admin", status: "active" });
    const [agent, otherAgent] = await db.insert(agents).values(["Default agent", "Other agent"].map(name => ({ companyId: company.id, name, role: "general" as const, status: "idle" as const, adapterType: "codex_local" }))).returning();
    const [app] = await db.insert(toolApplications).values({ companyId: company.id, applicationKey: randomUUID(), name: "Composio", type: "mcp_http", metadata: { sourceTemplateKey: "composio" } }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId: company.id, applicationId: app.id, uid: randomUUID(), name: "Composio account", transport: "mcp_remote", authKind: "none", credentialPolicy: "shared", status: "active", enabled: true, config: { sourceTemplateKey: "composio", url: "https://connect.composio.dev/mcp" } }).returning();
    await db.insert(connectionGrants).values({ companyId: company.id, connectionId: connection.id, kind: "organization", isDefault: true, status: "active" });
    const catalog = await db.insert(toolCatalogEntries).values([
      ["COMPOSIO_SEARCH_TOOLS", "read"], ["COMPOSIO_GET_TOOL_SCHEMAS", "read"], ["COMPOSIO_MULTI_EXECUTE_TOOL", "destructive"], ["COMPOSIO_MANAGE_CONNECTIONS", "destructive"],
    ].map(([toolName, riskLevel]) => ({ companyId: company.id, connectionId: connection.id, name: toolName, toolName, versionHash: "v1", status: "active" as const, riskLevel: riskLevel as "read" | "destructive" }))).returning();
    const accountId = randomUUID();
    let accounts = [{ id: accountId, alias: "Work", status: "initiated", is_default: true, access_token: "never-store-this-token" }];
    let onList = async () => {};
    let listResult: unknown = undefined;
    let failedToolkit: string | undefined;
    let mutationStatus = 200;
    let applyMutation = true;
    const operations: string[] = [];
    const batches: { name: string; action: string; account_id?: string; alias?: string }[][] = [];
    const access = toolAccessService(db, { composioAppToolkits: syncToolkits, remoteHttpRequest: async (_url, init) => {
      const request = JSON.parse(String(init.body));
      const toolkits = request.params.arguments.toolkits;
      expect(request.params.name).toBe("COMPOSIO_MANAGE_CONNECTIONS");
      batches.push(toolkits);
      const results: Record<string, unknown> = {};
      for (const toolkit of toolkits) {
        operations.push(toolkit.action);
        if (toolkit.action === "list") await onList();
        else if (mutationStatus !== 200) return new Response("unconfirmed", { status: mutationStatus });
        if (applyMutation && toolkit.name === "circleback_mcp") {
          if (toolkit.action === "rename") accounts = accounts.map(account => account.id === toolkit.account_id ? { ...account, alias: toolkit.alias } : account);
          if (toolkit.action === "remove") accounts = accounts.filter(account => account.id !== toolkit.account_id);
        }
        results[toolkit.name] = toolkit.name === failedToolkit ? { toolkit: toolkit.name, accounts: [{ status: "ACTIVE" }] }
          : toolkit.action === "add" ? { redirect_url: "https://connect.composio.dev/link/test" }
          : listResult ?? { toolkit: toolkit.name, accounts: toolkit.name === "circleback_mcp" ? accounts : [] };
      }
      return Response.json({ jsonrpc: "2.0", id: request.id, result: { structuredContent: { data: { results } } } });
    } });
    return { company, agent, otherAgent, connection, catalog, access, operations, batches, accountId, actor: { actorType: "user" as const, actorId: userId },
      activate: () => { accounts = accounts.map(account => ({ ...account, status: "active" })); },
      disconnect: () => { accounts = []; },
      setListResult: (result: unknown) => { listResult = result; },
      failToolkit: (toolkit: string) => { failedToolkit = toolkit; },
      setMutationStatus: (status: number) => { mutationStatus = status; },
      refuseMutation: () => { applyMutation = false; },
      onList: (callback: () => Promise<void>) => { onList = callback; } };

  }

  async function configureAccess(f: Awaited<ReturnType<typeof fixture>>, agentId?: string) {
    await f.access.putConnectionInstalls(f.connection.id, { installs: agentId
      ? [{ targetType: "agent", targetId: agentId }] : [{ targetType: "company", targetId: f.company.id }] }, f.actor);
    await f.access.finishGalleryAppConnection(f.company.id, f.connection.id, {
      enabledCatalogEntryIds: f.catalog.map(tool => tool.id),
      askFirstCatalogEntryIds: f.catalog.filter(tool => ["COMPOSIO_MULTI_EXECUTE_TOOL", "COMPOSIO_MANAGE_CONNECTIONS"].includes(tool.toolName)).map(tool => tool.id),
      access: agentId ? { agentIds: [agentId] } : "all_agents",
    }, f.actor);
  }

  it("generates and verifies app sign-in without a task or new access grants, preserving company-wide gateway defaults", async () => {
    const f = await fixture();
    await configureAccess(f);
    const grants = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, f.connection.id));
    const installs = await f.access.listConnectionInstalls(f.connection.id, f.company.id);
    const before = (await f.access.getEffectiveProfilesForAgent(f.company.id, f.agent.id)).allowedTools;
    expect(await f.access.setupComposioApp(f.connection.id, "circleback_mcp", { action: "start" }, f.actor)).toMatchObject({ status: "authorization_required" });
    expect(f.operations).toEqual(["list", "add"]);
    expect(await db.select().from(issues).where(eq(issues.companyId, f.company.id))).toHaveLength(0);
    await expect(f.access.setupComposioApp(f.connection.id, "circleback_mcp", { action: "complete" }, f.actor)).rejects.toThrow("Finish connecting");
    expect((await f.access.getEffectiveProfilesForAgent(f.company.id, f.agent.id)).allowedTools).toEqual(before);
    f.activate();
    await f.access.setupComposioApp(f.connection.id, "circleback_mcp", { action: "complete" }, f.actor);
    expect((await f.access.getEffectiveProfilesForAgent(f.company.id, f.agent.id)).allowedTools).toEqual(before);
    expect((await f.access.getEffectiveProfilesForAgent(f.company.id, f.otherAgent.id)).allowedTools.map(t => t.toolName).sort()).toEqual(f.catalog.map(t => t.toolName).sort());
    expect(await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, f.connection.id))).toEqual(grants);
    expect(await f.access.listConnectionInstalls(f.connection.id, f.company.id)).toEqual(installs);
    const tool = f.catalog.find(t => t.toolName === "COMPOSIO_MULTI_EXECUTE_TOOL")!;
    const decision = await toolAccessPolicyService(db).decide({ companyId: f.company.id, actor: { actorType: "agent", actorId: f.agent.id, agentId: f.agent.id }, request: { connectionId: f.connection.id, catalogEntryId: tool.id, toolName: tool.toolName, arguments: {} } });
    expect(decision.decision).toBe("require_approval");
    expect(f.operations.filter(action => action === "add")).toHaveLength(1);
  });
  it("does not create another link for an active account and rejects unknown toolkits", async () => {
    const f = await fixture();
    f.activate();
    expect(await f.access.setupComposioApp(f.connection.id, "circleback_mcp", { action: "start" }, f.actor)).toEqual({ status: "connected" });
    expect(f.operations).toEqual(["list"]);
    await expect(f.access.setupComposioApp(f.connection.id, "invented", { action: "start" }, f.actor)).rejects.toThrow("not in the catalog");
  });
  it("keeps meta-tool execution behind approval even if its catalog risk is read", async () => {
    const f = await fixture();
    const tool = f.catalog.find(t => t.toolName === "COMPOSIO_MULTI_EXECUTE_TOOL")!;
    await db.update(toolCatalogEntries).set({ riskLevel: "read" }).where(eq(toolCatalogEntries.id, tool.id));
    await configureAccess(f);
    f.activate();
    await f.access.setupComposioApp(f.connection.id, "circleback_mcp", { action: "complete" }, f.actor);
    const decision = await toolAccessPolicyService(db).decide({ companyId: f.company.id, actor: { actorType: "agent", actorId: f.agent.id, agentId: f.agent.id }, request: { connectionId: f.connection.id, catalogEntryId: tool.id, toolName: tool.toolName, arguments: {} } });
    expect(decision.decision).toBe("require_approval");
  });
  it("does not complete app setup if the gateway is disabled while checking Composio", async () => {
    const f = await fixture();
    f.activate();
    f.onList(async () => { await db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, f.connection.id)); });
    await expect(f.access.setupComposioApp(f.connection.id, "circleback_mcp", { action: "complete" }, f.actor)).rejects.toThrow("no longer active");
    expect((await f.access.getEffectiveProfilesForAgent(f.company.id, f.agent.id)).allowedTools).toHaveLength(0);
  });
  it("preserves a saved gateway's restricted access when another app is connected", async () => {
    const f = await fixture();
    await configureAccess(f, f.agent.id);
    const before = (await f.access.getEffectiveProfilesForAgent(f.company.id, f.agent.id)).allowedTools;
    f.activate();
    await f.access.setupComposioApp(f.connection.id, "circleback_mcp", { action: "complete" }, f.actor);
    expect((await f.access.getEffectiveProfilesForAgent(f.company.id, f.agent.id)).allowedTools).toEqual(before);
    expect((await f.access.getEffectiveProfilesForAgent(f.company.id, f.otherAgent.id)).allowedTools).toHaveLength(0);
  });
  it("rejects agents, non-managers, and other companies before calling Composio", async () => {
    const f = await fixture();
    const userId = randomUUID();
    await db.insert(companyMemberships).values({ companyId: f.company.id, principalType: "user", principalId: userId, membershipRole: "member", status: "active" });
    let providerCalls = 0;
    const member: Express.Request["actor"] = { type: "board", userId, source: "session", isInstanceAdmin: false, companyIds: [f.company.id], memberships: [{ companyId: f.company.id, membershipRole: "member", status: "active" }] };
    const actors: [Express.Request["actor"], number][] = [
      [member, 403],
      [{ ...member, companyIds: [randomUUID()], memberships: [] }, 404],
      [{ type: "agent", agentId: f.agent.id, companyId: f.company.id, source: "agent_key" }, 403],
    ];
    for (const [actor, status] of actors) {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.actor = actor; next(); });
      app.use("/api", toolAccessRoutes(db, { remoteHttpRequest: async () => { providerCalls++; throw new Error("Must not reach provider"); } }));
      app.use(errorHandler);
      await request(app).post(`/api/tool-connections/${f.connection.id}/composio/apps/circleback_mcp/setup`).send({ action: "start" }).expect(status);
      await request(app).get(`/api/tool-connections/${f.connection.id}/composio/apps`).expect(status);
      await request(app).post(`/api/tool-connections/${f.connection.id}/composio/apps/sync`).send({ force: true }).expect(status);
      await request(app).post(`/api/tool-connections/${f.connection.id}/composio/apps/refresh`).send({ toolkits: ["circleback_mcp"] }).expect(status);
      await request(app).post(`/api/tool-connections/${f.connection.id}/composio/apps/circleback_mcp/accounts`).send({ action: "remove", accountId: f.accountId }).expect(status);
    }
    expect(providerCalls).toBe(0);
  });
  it("persists safe observations per user and gateway, and refreshes known apps without creating accounts", async () => {
    const f = await fixture();
    f.activate();
    const result = await f.access.refreshComposioApps(f.connection.id, ["circleback_mcp", "hubspot"], f.actor);
    expect(result.apps.find(app => app.toolkit === "circleback_mcp")).toMatchObject({ connectionId: f.connection.id, status: "connected", accounts: [{ id: f.accountId, alias: "Work", status: "ACTIVE" }] });
    expect(JSON.stringify(await db.select().from(toolConnectionAppSnapshots).where(eq(toolConnectionAppSnapshots.connectionId, f.connection.id)))).not.toContain("never-store-this-token");
    expect((await f.access.listComposioApps(f.connection.id, { ...f.actor, actorId: randomUUID() })).apps).toEqual([]);
    f.operations.length = 0;
    f.disconnect();
    const refreshed = await f.access.refreshComposioApps(f.connection.id, [], f.actor);
    expect(f.operations).toEqual(["list"]);
    expect(refreshed.apps.find(app => app.toolkit === "circleback_mcp")).toMatchObject({ status: "not_connected", accounts: [] });
    expect((await f.access.getEffectiveProfilesForAgent(f.company.id, f.agent.id)).allowedTools).toEqual([]);
  });
  it("rechecks apps from earlier direct setup and hides observations after a gateway identity changes", async () => {
    const f = await fixture();
    f.activate();
    await f.access.setupComposioApp(f.connection.id, "circleback_mcp", { action: "start" }, f.actor);
    await db.delete(toolConnectionAppSnapshots).where(eq(toolConnectionAppSnapshots.connectionId, f.connection.id));
    expect((await f.access.refreshComposioApps(f.connection.id, [], f.actor)).apps).toHaveLength(1);
    await db.update(toolConnections).set({ config: { ...f.connection.config, url: "https://connect.composio.dev/other-mcp" } }).where(eq(toolConnections.id, f.connection.id));
    expect((await f.access.listComposioApps(f.connection.id, f.actor)).apps).toEqual([]);
  });
  async function finishSync(f: Awaited<ReturnType<typeof fixture>>) {
    await vi.waitFor(async () => expect((await f.access.listComposioApps(f.connection.id, f.actor)).sync.status).not.toBe("syncing"), { timeout: 10_000 });
    return f.access.listComposioApps(f.connection.id, f.actor);
  }

  it("discovers already connected apps across the catalog without a visible-page filter or access changes", async () => {
    const f = await fixture(); f.activate();
    const grants = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, f.connection.id));
    await f.access.syncComposioApps(f.connection.id, false, f.actor);
    const result = await finishSync(f);
    expect(result.sync).toMatchObject({ status: "ready", checked: 3, total: 3, failed: 0, coverage: "supported_catalog" });
    expect(result.apps.find(app => app.toolkit === "circleback_mcp")).toMatchObject({ status: "connected", errorAt: null });
    expect(f.batches.flat().map(tool => tool.name)).toEqual(["circleback_mcp", "notion", "hubspot"]);
    expect(f.operations.every(action => action === "list")).toBe(true);
    expect(await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, f.connection.id))).toEqual(grants);
    expect(await db.select().from(issues).where(eq(issues.companyId, f.company.id))).toHaveLength(0);
    await f.access.syncComposioApps(f.connection.id, false, f.actor);
    expect(f.operations).toHaveLength(3); // Fresh inventory does not start another scan.
    f.disconnect();
    await f.access.syncComposioApps(f.connection.id, true, f.actor);
    expect((await finishSync(f)).apps.find(app => app.toolkit === "circleback_mcp")).toMatchObject({ status: "not_connected", accounts: [] });
  });

  it("shares a lease between concurrent syncs and bounds provider batches", async () => {
    const { COMPOSIO_APP_TOOLKITS } = await import("@paperclipai/shared/aggregator-app-catalog");
    const names = ["circleback_mcp", ...COMPOSIO_APP_TOOLKITS.filter(name => name !== "circleback_mcp").slice(0, 35)];
    const f = await fixture(names); f.activate();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    f.onList(() => held);
    await Promise.all([f.access.syncComposioApps(f.connection.id, true, f.actor), f.access.syncComposioApps(f.connection.id, true, f.actor)]);
    expect(f.batches).toHaveLength(1);
    release();
    const result = await finishSync(f);
    expect(result.sync).toMatchObject({ status: "ready", total: 36, checked: 36 });
    expect(f.batches.map(batch => batch.length)).toEqual([32, 4]);
    expect(new Set(f.batches.flat().map(tool => tool.name)).size).toBe(36);
  });

  it("keeps failed account observations unverified and restores them after a successful sync", async () => {
    const f = await fixture(); f.activate();
    await f.access.syncComposioApps(f.connection.id, true, f.actor); await finishSync(f);
    f.setListResult({ accounts: [{ status: "ACTIVE" }] });
    await f.access.syncComposioApps(f.connection.id, true, f.actor);
    const failed = await finishSync(f);
    expect(failed.sync.status).toBe("error");
    expect(failed.apps.find(app => app.toolkit === "circleback_mcp")).toMatchObject({ status: "connected", accounts: [{ id: f.accountId }] });
    expect(failed.apps.find(app => app.toolkit === "circleback_mcp")?.errorAt).toBeTruthy();
    f.setListResult(undefined);
    await f.access.syncComposioApps(f.connection.id, true, f.actor);
    expect((await finishSync(f)).apps.find(app => app.toolkit === "circleback_mcp")?.errorAt).toBeNull();
  });

  it("reports an incomplete sync when a toolkit without prior accounts fails", async () => {
    const f = await fixture(); f.activate(); f.failToolkit("hubspot");
    await f.access.syncComposioApps(f.connection.id, true, f.actor);
    const result = await finishSync(f);
    expect(result.sync).toMatchObject({ status: "error", checked: 3, total: 3, failed: 1 });
    expect(result.sync.error).toBeTruthy();
    expect(result.apps.find(app => app.toolkit === "circleback_mcp")?.accounts[0].id).toBe(f.accountId);
    expect(result.apps.find(app => app.toolkit === "hubspot")).toBeUndefined();
  });

  it("rejects observations when credentials change while a provider request is in flight", async () => {
    const f = await fixture(); f.activate();
    f.onList(async () => { await db.update(toolConnections).set({ config: { ...f.connection.config, url: "https://connect.composio.dev/replaced" } }).where(eq(toolConnections.id, f.connection.id)); });
    await f.access.syncComposioApps(f.connection.id, true, f.actor);
    await vi.waitFor(() => expect(f.operations.length).toBeGreaterThan(0));
    await vi.waitFor(async () => expect((await f.access.listComposioApps(f.connection.id, f.actor)).sync.status).toBe("idle"));
    expect((await f.access.listComposioApps(f.connection.id, f.actor)).apps).toEqual([]);
  });

  it("renames and removes only a verified account in the selected toolkit, and confirms both changes", async () => {
    const f = await fixture(); f.activate();
    const grants = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, f.connection.id));
    await expect(f.access.manageComposioAppAccount(f.connection.id, "hubspot", { action: "remove", accountId: f.accountId }, f.actor)).rejects.toThrow("no longer available");
    expect(f.operations).toEqual(["list"]);
    const renamed = await f.access.manageComposioAppAccount(f.connection.id, "circleback_mcp", { action: "rename", accountId: f.accountId, alias: "Meetings" }, f.actor);
    expect(renamed.apps.find(app => app.toolkit === "circleback_mcp")?.accounts[0].alias).toBe("Meetings");
    expect(f.batches.some(batch => batch.some(op => op.action === "rename" && op.account_id === f.accountId && op.alias === "Meetings"))).toBe(true);
    const removed = await f.access.manageComposioAppAccount(f.connection.id, "circleback_mcp", { action: "remove", accountId: f.accountId }, f.actor);
    expect(removed.apps.find(app => app.toolkit === "circleback_mcp")).toMatchObject({ status: "not_connected", accounts: [] });
    expect((await db.select().from(toolConnections).where(eq(toolConnections.id, f.connection.id)))[0]).toMatchObject({ status: "active", enabled: true });
    expect(await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, f.connection.id))).toEqual(grants);
  });
  it("adds another account without a task or an agent grant, even when an account is already active", async () => {
    const f = await fixture(); f.activate();
    const result = await f.access.manageComposioAppAccount(f.connection.id, "circleback_mcp", { action: "add" }, f.actor);
    expect(result.authorizationUrl).toBe("https://connect.composio.dev/link/test");
    expect(f.operations).toEqual(["add"]);
    expect(await db.select().from(issues).where(eq(issues.companyId, f.company.id))).toHaveLength(0);
    expect((await f.access.getEffectiveProfilesForAgent(f.company.id, f.agent.id)).allowedTools).toEqual([]);
  });
  it("retains previous observations when a list result is incomplete or fails", async () => {
    const f = await fixture(); f.activate();
    await f.access.refreshComposioApps(f.connection.id, ["circleback_mcp"], f.actor);
    f.setListResult({ toolkit: "circleback_mcp", accounts: [{ status: "ACTIVE" }] });
    await expect(f.access.refreshComposioApps(f.connection.id, ["circleback_mcp"], f.actor)).rejects.toThrow("complete account list");
    expect((await f.access.listComposioApps(f.connection.id, f.actor)).apps[0].accounts[0].id).toBe(f.accountId);
    f.setListResult({ toolkit: "circleback_mcp", error: "expired", accounts: [] });
    await expect(f.access.refreshComposioApps(f.connection.id, ["circleback_mcp"], f.actor)).rejects.toThrow("could not check");
    expect((await f.access.listComposioApps(f.connection.id, f.actor)).apps[0].status).toBe("connected");
  });
  it("never retries an uncertain mutation or reports an unconfirmed rename as success", async () => {
    const f = await fixture(); f.activate();
    f.setMutationStatus(400);
    await expect(f.access.manageComposioAppAccount(f.connection.id, "circleback_mcp", { action: "remove", accountId: f.accountId }, f.actor)).rejects.toThrow("has not confirmed");
    expect(f.operations.filter(op => op === "remove")).toHaveLength(1);
    f.setMutationStatus(200); f.refuseMutation();
    await expect(f.access.manageComposioAppAccount(f.connection.id, "circleback_mcp", { action: "rename", accountId: f.accountId, alias: "Meetings" }, f.actor)).rejects.toThrow("has not confirmed");
    expect((await f.access.listComposioApps(f.connection.id, f.actor)).apps[0].accounts[0].alias).toBe("Work");
  });
});
