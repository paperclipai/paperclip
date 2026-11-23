import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, companySecretBindings, connectionGrants, createDb, principalPermissionGrants, toolApplications, toolCatalogEntries, toolConnections } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { syncConnectionCredentialBindings } from "../services/connection-credential-bindings.js";
import { connectionManagementService } from "../services/connection-management.js";
import { secretService } from "../services/secrets.js";
import { toolAccessService } from "../services/tool-access.js";
import type { PaperclipCloudConnector } from "../services/paperclip-cloud-connector.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("dedicated agent connection discovery", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let provider: Server;
  let origin: string;
  let requests: Array<string | undefined>;
  let rejectCredential: boolean;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("agent-connection-catalog-");
    db = createDb(database.connectionString);
    provider = createServer(async (req, res) => {
      if (req.method !== "POST") { res.writeHead(404); res.end(); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const message = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(req.headers.authorization);
      if (rejectCredential || req.headers.authorization !== "Bearer fixture-agent-access") {
        res.writeHead(401, { "www-authenticate": "Bearer", "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (message.method === "notifications/initialized") {
        res.writeHead(202); res.end(); return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: message.method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
        : { tools: [{ name: "get_fixture", description: "Read a fixture", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] } }));
    });
    await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  });

  beforeEach(() => {
    requests = [];
    rejectCredential = false;
    const localFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const href = String(url);
      if (href.startsWith(`${origin}/`)) return localFetch(url, init);
      if (href === "https://api.github.com/user") return Response.json({ id: 42, login: "fixture-bot" });
      if (href.startsWith("https://api.github.com/user/installations?")) return Response.json({ installations: [{ id: 101, repository_selection: "selected", account: { login: "example" } }] });
      if (href.startsWith("https://api.github.com/user/installations/101/repositories?")) return Response.json({ total_count: 1, repositories: [{ id: 1, full_name: "example/fixture" }] });
      throw new Error("Unexpected provider request");
    });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    if (provider) await new Promise<void>(resolve => provider.close(() => resolve()));
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
  });

  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "Agent catalog fixture", issuePrefix: `AC${randomUUID().slice(0, 6)}` }).returning();
    const [agent, otherAgent] = await db.insert(agents).values(["Owner", "Other"].map(name => ({ companyId: company.id, name, role: "engineer", adapterType: "process" }))).returning();
    const [application] = await db.insert(toolApplications).values({ companyId: company.id, name: "GitHub", type: "mcp_http" }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: company.id, applicationId: application.id, name: "GitHub", uid: randomUUID(),
      transport: "mcp_remote", authKind: "oauth", credentialPolicy: "per_agent", status: "active", enabled: true,
      healthStatus: "failed", healthMessage: "OAuth credentials have expired and need to be reconnected.",
      config: { sourceTemplateKey: "github", url: `${origin}/mcp`, oauth: {
        strategy: "paperclip_cloud_connector", provider: "github", connectorProfile: "github.code",
        tokenUrl: "https://github.com/login/oauth/access_token", expiresAt: null,
      } },
    }).returning();
    const secret = await secretService(db).create(company.id, { name: "Agent access", key: randomUUID(), provider: "local_encrypted", value: "fixture-agent-access" });
    const [grant] = await db.insert(connectionGrants).values({
      companyId: company.id, connectionId: connection.id, kind: "agent", subjectAgentId: agent.id, status: "active",
      credentialSecretRefs: [{ secretId: secret.id, configPath: "oauth.access_token", versionSelector: "latest", required: true }],
      providerTenant: { oauth: { strategy: "paperclip_cloud_connector", accessTokenExpiresAt: null },
        github: { userId: "42", login: "fixture-bot", installationCount: 1, repositoryCount: 1, repositorySelection: "selected", installationIds: ["101"], installationOwnerLogins: ["example"] } },
    }).returning();
    await syncConnectionCredentialBindings(db, connection);
    const connector = { setWebhookBinding: vi.fn(async () => undefined) } as unknown as PaperclipCloudConnector;
    const service = toolAccessService(db, { deploymentMode: "local_trusted", deploymentExposure: "private", paperclipCloudConnector: connector });
    return { company, agent, otherAgent, connection, grant, secret, service };
  }

  it.each(["background", "system", "operator", "agent"] as const)("renames and refreshes an agent-owned GitHub connection without reconnect (%s)", async mode => {
    const f = await fixture();
    const actor = mode === "background" ? undefined : mode === "system"
      ? { actorType: "system" as const } : mode === "operator"
      ? { actorType: "user" as const, actorId: "fixture-operator" }
      : { actorType: "agent" as const, actorId: f.agent.id };
    await f.service.updateConnection(f.connection.id, { name: "Renamed bot" });
    const refreshed = await f.service.refreshCatalog(f.connection.id, actor);
    expect(refreshed.connection).toMatchObject({ name: "Renamed bot", healthStatus: "ok", enabled: true });
    expect((await f.service.getConnection(f.connection.id, f.company.id)).requiresReauthorization).toBe(false);
    expect(refreshed.catalog.map(tool => tool.toolName)).toEqual(["get_fixture"]);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every(header => header === "Bearer fixture-agent-access")).toBe(true);
    await expect(f.service.checkHealth(f.connection.id, actor)).resolves.toMatchObject({ connection: { healthStatus: "ok" } });
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, f.grant.id));
    expect(grant.status).toBe("active");
    expect(grant.credentialSecretRefs).toEqual(f.grant.credentialSecretRefs);
    const bindings = await db.select().from(companySecretBindings).where(and(eq(companySecretBindings.targetId, f.connection.id), eq(companySecretBindings.secretId, f.secret.id)));
    expect(bindings).toHaveLength(1);
  });

  describe.each(["refreshCatalog", "checkHealth"] as const)("%s caller isolation", operation => {
    it.each(["another agent", "another company", "missing agent identity"])("denies %s without changing the owner's connection", async scope => {
      const f = await fixture();
      const actorId = scope === "another company" ? (await fixture()).agent.id : scope === "missing agent identity" ? null : f.otherAgent.id;
      await f.service.refreshCatalog(f.connection.id, { actorType: "agent", actorId: f.agent.id });
      const before = await db.select().from(toolConnections).where(eq(toolConnections.id, f.connection.id));
      const catalog = await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, f.connection.id));
      requests = [];
      vi.mocked(fetch).mockClear();
      await expect(f.service[operation](f.connection.id, { actorType: "agent", actorId }))
        .rejects.toMatchObject({ status: 422, details: { code: "agent_authorization_required" } });
      expect(requests).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
      expect(await db.select().from(toolConnections).where(eq(toolConnections.id, f.connection.id))).toEqual(before);
      expect(await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, f.connection.id))).toEqual(catalog);
      await expect(f.service.checkHealth(f.connection.id, { actorType: "agent", actorId: f.agent.id }))
        .resolves.toMatchObject({ connection: { healthStatus: "ok" } });
    });

    it("keeps the owner's tools healthy when a permitted managing agent lacks the credential", async () => {
      const f = await fixture();
      const userId = randomUUID();
      await db.insert(authUsers).values({ id: userId, name: "Manager", email: `${userId}@fixture.invalid`, createdAt: new Date(), updatedAt: new Date() });
      await db.insert(companyMemberships).values([
        { companyId: f.company.id, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" },
        { companyId: f.company.id, principalType: "agent", principalId: f.otherAgent.id, status: "active" },
      ]);
      await db.insert(principalPermissionGrants).values([
        { companyId: f.company.id, principalType: "agent", principalId: f.otherAgent.id, permissionKey: "tools:manage_connections" },
        { companyId: f.company.id, principalType: "user", principalId: userId, permissionKey: "tools:manage_connections" },
      ]);
      const managementContext = await connectionManagementService(db).authorize({
        type: "agent", agentId: f.otherAgent.id, companyId: f.company.id, onBehalfOfUserId: userId,
      }, "connections:configure", { type: "connection_management", companyId: f.company.id, connectionId: f.connection.id, operation });
      expect(managementContext.decision.allowed).toBe(true);
      await f.service.refreshCatalog(f.connection.id, { actorType: "agent", actorId: f.agent.id });
      const before = await db.select().from(toolConnections).where(eq(toolConnections.id, f.connection.id));
      requests = [];
      vi.mocked(fetch).mockClear();
      await expect(f.service[operation](f.connection.id, { actorType: "agent", actorId: f.otherAgent.id, managementContext }))
        .rejects.toMatchObject({ status: 422, details: { code: "agent_authorization_required" } });
      expect(requests).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
      expect(await db.select().from(toolConnections).where(eq(toolConnections.id, f.connection.id))).toEqual(before);
      expect((await f.service.listCatalog(f.connection.id, f.company.id)).map(tool => tool.toolName)).toEqual(["get_fixture"]);
    });
  });

  it("does not fall back to personal or organization grants when the agent grant is revoked", async () => {
    const f = await fixture();
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, f.grant.id));
    await db.insert(connectionGrants).values([
      { companyId: f.company.id, connectionId: f.connection.id, kind: "organization", status: "active", isDefault: true, credentialSecretRefs: f.grant.credentialSecretRefs },
      { companyId: f.company.id, connectionId: f.connection.id, kind: "user", subjectUserId: "fixture-operator", status: "active", credentialSecretRefs: f.grant.credentialSecretRefs },
    ]);
    await expect(f.service.refreshCatalog(f.connection.id))
      .rejects.toMatchObject({ status: 422, details: { code: "agent_authorization_required" } });
    await expect(f.service.refreshCatalog(f.connection.id, { actorType: "user", actorId: "fixture-operator" }))
      .rejects.toMatchObject({ status: 422, details: { code: "agent_authorization_required" } });
    expect((await f.service.getConnection(f.connection.id, f.company.id)).requiresReauthorization).toBe(true);
    await expect(f.service.checkHealth(f.connection.id))
      .rejects.toMatchObject({ status: 422, details: { code: "agent_authorization_required" } });
    expect(requests).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the same agent grant for generic OAuth MCP health and discovery", async () => {
    const f = await fixture();
    await f.service.updateConnection(f.connection.id, { config: { url: `${origin}/mcp`, oauth: {
      provider: origin, tokenUrl: `${origin}/token`, expiresAt: null,
    } } });
    await expect(f.service.refreshCatalog(f.connection.id)).resolves.toMatchObject({ connection: { healthStatus: "ok" } });
    await expect(f.service.checkHealth(f.connection.id)).resolves.toMatchObject({ connection: { healthStatus: "ok" } });
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every(header => header === "Bearer fixture-agent-access")).toBe(true);
  });

  it("does not choose between multiple active agent authorizations in background work", async () => {
    const f = await fixture();
    await db.insert(connectionGrants).values({ companyId: f.company.id, connectionId: f.connection.id,
      kind: "agent", subjectAgentId: f.otherAgent.id, status: "active", credentialSecretRefs: f.grant.credentialSecretRefs });
    await expect(f.service.refreshCatalog(f.connection.id))
      .rejects.toMatchObject({ status: 422, details: { code: "agent_authorization_ambiguous" } });
    await expect(f.service.checkHealth(f.connection.id))
      .rejects.toMatchObject({ status: 422, details: { code: "agent_authorization_ambiguous" } });
    expect(requests).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("still requires reconnect when the provider rejects the agent's credential", async () => {
    const f = await fixture();
    rejectCredential = true;
    await expect(f.service.refreshCatalog(f.connection.id)).rejects.toThrow();
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every(header => header === "Bearer fixture-agent-access")).toBe(true);
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, f.grant.id));
    expect(grant.status).toBe("needs_reauthorization");
    expect((await f.service.getConnection(f.connection.id, f.company.id)).requiresReauthorization).toBe(true);
  });
});
