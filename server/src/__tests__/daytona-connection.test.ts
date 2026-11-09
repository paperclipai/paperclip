import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, companyMemberships, companySecrets, connectionGrants, createDb,
  ensurePostgresDatabase, applyPendingMigrations, heartbeatRuns, issues, toolCatalogEntries, toolConnections } from "@paperclipai/db";
import { toolAccessService } from "../services/tool-access.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { DAYTONA_API_URL, DAYTONA_TOOLS, daytonaClient, executeDaytonaTool } from "../services/daytona.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
const actor = { actorType: "user" as const, actorId: "daytona-reviewer" };
const credential = "daytona-fixture-secret";
(support.supported ? describe : describe.skip)("Daytona governed provider actions", () => {
  let db: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  beforeAll(async () => {
    if (external) {
      const url = new URL(external); url.pathname = "/daytona_" + randomUUID().replaceAll("-", "");
      await ensurePostgresDatabase(external, url.pathname.slice(1));
      await applyPendingMigrations(url.toString()); db = createDb(url.toString());
    } else { temp = await startEmbeddedPostgresTestDatabase("daytona-connector-"); db = createDb(temp.connectionString); }
  }, 30000);
  afterAll(async () => { await db?.$client.end(); await temp?.cleanup(); });

  async function fixture(personal = false) {
    const [company] = await db.insert(companies).values({ name: "Daytona fixture", issuePrefix: `D${randomUUID().slice(0, 6)}` }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: actor.actorId, membershipRole: "admin", status: "active" });
    const organizationId = randomUUID(), sandboxId = randomUUID();
    let sandboxOrganization = organizationId, proxy = "https://proxy.app.daytona.io/toolbox";
    const request = vi.fn(async (url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${credential}`);
      expect(["error", "manual"]).toContain(init.redirect);
      const parsed = new URL(url);
      if (url === `${DAYTONA_API_URL}/api-keys/current`) return Response.json({ organizationId, key: credential });
      if (parsed.pathname === "/api/sandbox" && init.method === "GET") return Response.json([{ id: sandboxId, name: "External sandbox", organizationId }]);
      if (parsed.pathname === "/api/sandbox" && init.method === "POST") return Response.json({ id: sandboxId, organizationId, ...JSON.parse(init.body as string) });
      if (url === `${DAYTONA_API_URL}/sandbox/${sandboxId}`) return init.method === "DELETE" ? new Response(null, { status: 204 })
        : Response.json({ id: sandboxId, name: "External sandbox", organizationId: sandboxOrganization, state: "started", toolboxProxyUrl: proxy });
      if (parsed.pathname === `/toolbox/${sandboxId}/process/execute`) return Response.json({ exitCode: 0, result: `done ${credential}` });
      if (parsed.pathname === `/toolbox/${sandboxId}/files/download`) return new Response("file bytes", { headers: { "Content-Type": "application/octet-stream" } });
      if (parsed.pathname === `/toolbox/${sandboxId}/files/upload-v2`) {
        expect(Buffer.isBuffer(init.body)).toBe(true);
        const form = await new Response(init.body, { headers: init.headers }).formData();
        expect(await (form.get("file") as Blob).text()).toBe("uploaded bytes");
        return Response.json({ path: parsed.searchParams.get("path") });
      }
      throw new Error("Unexpected provider request");
    });
    const service = toolAccessService(db, { remoteHttpRequest: request, remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }] });
    const connected = await service.connectGalleryApp(company.id, { galleryKey: "daytona", methodKey: "workspace-diagnostics",
      ...(personal ? { grantKind: "user" as const } : {}), credentialValues: { "credentials.authorization": credential } }, actor);
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Maintainer", role: "engineer", adapterType: "process" }).returning();
    await service.finishGalleryAppConnection(company.id, connected.connectionId, { enabledCatalogEntryIds: connected.catalog.map(c => c.id),
      askFirstCatalogEntryIds: [], access: { agentIds: [agent.id] } }, actor);
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Provider work", assigneeAgentId: agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id,
      scopeKind: "issue", invocationSource: "on_demand", status: "running", responsibleUserId: actor.actorId, contextSnapshot: { issueId: issue.id } }).returning();
    const gateway = createToolGatewayService(db, { remoteHttpRequest: request });
    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id, issueId: issue.id });
    const tools = await gateway.listToolsForSession(session.token);
    const call = (name: string, parameters: unknown, timeoutMs?: number) => {
      const tool = tools.find(t => t.upstreamToolName === name);
      expect(tool, name).toBeTruthy();
      return gateway.executeTool({ sessionToken: session.token, tool: tool!.name, parameters, timeoutMs, idempotencyKey: randomUUID() });
    };
    return { company, service, connected, agent, request, call, gateway, session, organizationId, sandboxId,
      foreignOrganization: () => { sandboxOrganization = randomUUID(); }, foreignProxy: () => { proxy = "https://attacker.example/toolbox"; } };
  }

  it.each([false, true])("uses the selected vault identity for real gateway reads and writes (personal=%s)", async personal => {
    const f = await fixture(personal);
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, f.connected.connectionId));
    const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.id, grant.credentialSecretRefs[0].secretId));
    expect(grant.kind).toBe(personal ? "user" : "organization");
    expect(secret.scope).toBe(personal ? "user" : "company");
    expect(secret.ownerUserId).toBe(personal ? actor.actorId : null);
    expect(f.connected.catalog).toHaveLength(DAYTONA_TOOLS.length);
    expect(f.connected.catalog.find(c => c.toolName === "daytona_api_list_sandboxes")).toMatchObject({ isReadOnly: true });
    expect(f.connected.catalog.find(c => c.toolName === "daytona_toolbox_execute_command")).toMatchObject({ isDestructive: true, isReadOnly: false });
    for (const name of ["daytona_api_set_ttl", "daytona_api_set_auto_delete_interval", "daytona_toolbox_set_file_permissions"]) {
      expect(f.connected.catalog.find(c => c.toolName === name), name).toMatchObject({ isDestructive: true, isReadOnly: false });
    }
    expect(JSON.stringify(await f.service.getConnection(f.connected.connectionId))).not.toContain(credential);
    // The sandbox has no Paperclip environment lease or task ownership record.
    expect(JSON.stringify(await f.call("daytona_api_list_sandboxes", {}))).toContain(f.sandboxId);
    expect(JSON.stringify(await f.call("daytona_api_create_sandbox", { body: { name: "Created through gateway" } }))).toContain("Created through gateway");
    const result = JSON.stringify(await f.call("daytona_toolbox_execute_command", { sandboxId: f.sandboxId, body: { command: "echo done" } }));
    expect(result).toContain("done"); expect(result).not.toContain(credential);
    expect(JSON.stringify(await f.call("daytona_api_get_current_api_key", {}))).not.toContain(credential);
  }, 30000);

  it("transfers file bytes without reading or writing the server filesystem", async () => {
    const f = await fixture();
    const download = JSON.stringify(await f.call("daytona_toolbox_download_file", { sandboxId: f.sandboxId, query: { path: "/workspace/file.txt" } }));
    expect(download).toContain(Buffer.from("file bytes").toString("base64"));
    const upload = await f.call("daytona_toolbox_upload_file", { sandboxId: f.sandboxId, query: { path: "/workspace/file.txt" },
      body: { file: Buffer.from("uploaded bytes").toString("base64") } });
    expect(JSON.stringify(upload)).toContain("/workspace/file.txt");
  });

  it("rejects a mismatched organization or untrusted toolbox URL before forwarding the key", async () => {
    const f = await fixture();
    f.foreignOrganization(); f.request.mockClear();
    await expect(f.call("daytona_toolbox_execute_command", { sandboxId: f.sandboxId, body: { command: "true" } })).rejects.toThrow("outside the selected account");
    expect(f.request).toHaveBeenCalledTimes(2);
    const g = await fixture(); g.foreignProxy(); g.request.mockClear();
    await expect(g.call("daytona_toolbox_execute_command", { sandboxId: g.sandboxId, body: { command: "true" } })).rejects.toThrow("unrecognized toolbox");
    expect(g.request.mock.calls.every(([url]) => url.startsWith(DAYTONA_API_URL))).toBe(true);
  });

  it("rejects foreign connection bindings, unknown arguments and path traversal", async () => {
    const f = await fixture(); f.request.mockClear();
    await expect(executeDaytonaTool({ binding: { companyId: randomUUID(), agentId: f.agent.id },
      connection: { companyId: f.company.id, config: {} }, headers: { Authorization: `Bearer ${credential}` }, request: f.request,
      toolName: "daytona_api_list_sandboxes", parameters: {} })).rejects.toThrow("Connection not found");
    await expect(f.call("daytona_api_list_sandboxes", { command: "printenv" })).rejects.toThrow();
    await expect(f.call("daytona_api_get_sandbox", { path: { sandboxIdOrName: "../api-keys" } })).rejects.toThrow("Invalid Daytona path");
  });

  it("rechecks revocation for a previously created gateway session", async () => {
    const f = await fixture();
    await db.update(toolConnections).set({ enabled: false }).where(and(eq(toolConnections.id, f.connected.connectionId), eq(toolConnections.companyId, f.company.id)));
    f.request.mockClear();
    await expect(f.call("daytona_api_list_sandboxes", {})).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });
  it("applies an Off action policy to writes through an existing session", async () => {
    const f = await fixture();
    await f.service.finishGalleryAppConnection(f.company.id, f.connected.connectionId, {
      enabledCatalogEntryIds: f.connected.catalog.filter(c => c.toolName !== "daytona_toolbox_execute_command").map(c => c.id),
      askFirstCatalogEntryIds: [], access: { agentIds: [f.agent.id] },
    }, actor);
    f.request.mockClear();
    await expect(f.call("daytona_toolbox_execute_command", { sandboxId: f.sandboxId, body: { command: "true" } })).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });
  it("quarantines added and changed actions even when a refresh requests all tools", async () => {
    const f = await fixture();
    const changed = f.connected.catalog.find(c => c.toolName === "daytona_toolbox_execute_command")!;
    const removed = f.connected.catalog.find(c => c.toolName === "daytona_api_create_sandbox")!;
    await db.update(toolCatalogEntries).set({ schemaHash: "earlier-schema", versionHash: "earlier-version" }).where(eq(toolCatalogEntries.id, changed.id));
    await db.delete(toolCatalogEntries).where(eq(toolCatalogEntries.id, removed.id));
    const refresh = await f.service.refreshCatalog(f.connected.connectionId, actor, { enableAllByDefault: true });
    expect(refresh.catalog.find(c => c.toolName === changed.toolName)?.status).toBe("quarantined");
    expect(refresh.catalog.find(c => c.toolName === removed.toolName)?.status).toBe("quarantined");
    f.request.mockClear();
    await expect(f.call("daytona_toolbox_execute_command", { sandboxId: f.sandboxId, body: { command: "true" } })).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });

  async function installLegacyCatalog(f: Awaited<ReturnType<typeof fixture>>) {
    await db.delete(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, f.connected.connectionId));
    const legacyNames = ["daytona_get_account", "daytona_list_workspaces", "daytona_get_workspace", "daytona_get_workspace_recovery"];
    const legacy = await db.insert(toolCatalogEntries).values(legacyNames.map(toolName => ({
      companyId: f.company.id, applicationId: f.connected.connection.applicationId, connectionId: f.connected.connectionId,
      name: toolName, toolName, title: toolName === "daytona_get_workspace_recovery" ? "Get workspace recovery" : toolName,
      entryKind: "tool", status: "active", riskLevel: "read", isReadOnly: true,
      inputSchema: { type: "object" }, versionHash: "legacy", schemaHash: "legacy",
    }))).returning();
    await f.service.finishGalleryAppConnection(f.company.id, f.connected.connectionId, {
      enabledCatalogEntryIds: legacy.map(entry => entry.id), askFirstCatalogEntryIds: [], access: { agentIds: [f.agent.id] },
    }, actor);
    // Earlier read-only defaults must not authorize the expanded native catalog.
    const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, f.connected.connectionId));
    await db.update(toolConnections).set({ config: { ...row.config, safeDefault: true } }).where(eq(toolConnections.id, row.id));
    return legacyNames;
  }

  it.each([false, true])("upgrades a saved four-action catalog without exposing or authorizing retired tools (personal=%s)", async personal => {
    const f = await fixture(personal);
    const legacyNames = await installLegacyCatalog(f);
    expect((await f.gateway.listToolsForSession(f.session.token)).some(tool => legacyNames.includes(tool.upstreamToolName ?? ""))).toBe(false);
    f.request.mockClear();
    const catalog = await f.service.listCatalog(f.connected.connectionId, f.company.id, actor);
    expect(catalog).toHaveLength(274);
    expect(catalog.every(entry => entry.status === "quarantined")).toBe(true);
    expect(catalog.some(entry => legacyNames.includes(entry.toolName))).toBe(false);
    const stored = await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, f.connected.connectionId));
    expect(stored.filter(entry => legacyNames.includes(entry.toolName))).toHaveLength(4);
    expect(stored.filter(entry => legacyNames.includes(entry.toolName)).every(entry => entry.status === "removed")).toBe(true);
    expect(f.request).toHaveBeenCalledTimes(1);
    f.request.mockClear();
    expect(await f.service.listCatalog(f.connected.connectionId, f.company.id, actor)).toHaveLength(274);
    expect(f.request).not.toHaveBeenCalled();
    expect((await f.gateway.listToolsForSession(f.session.token)).some(tool => tool.upstreamToolName?.startsWith("daytona_"))).toBe(false);
  }, 30000);

  it("hides retired native actions even when the saved key cannot refresh its catalog", async () => {
    const f = await fixture();
    await installLegacyCatalog(f);
    f.request.mockRejectedValue(new Error("Provider unavailable"));
    expect(await f.service.listCatalog(f.connected.connectionId, f.company.id, actor)).toEqual([]);
    expect((await f.gateway.listToolsForSession(f.session.token)).some(tool => tool.upstreamToolName?.startsWith("daytona_get_"))).toBe(false);
  });

  it("preserves existing Off and Allowed choices while retiring leftover actions", async () => {
    const f = await fixture();
    await f.service.finishGalleryAppConnection(f.company.id, f.connected.connectionId, {
      enabledCatalogEntryIds: f.connected.catalog.filter(entry => entry.toolName !== "daytona_toolbox_execute_command").map(entry => entry.id),
      askFirstCatalogEntryIds: [], access: { agentIds: [f.agent.id] },
    }, actor);
    await db.insert(toolCatalogEntries).values({
      companyId: f.company.id, applicationId: f.connected.connection.applicationId, connectionId: f.connected.connectionId,
      name: "daytona_get_workspace_recovery", toolName: "daytona_get_workspace_recovery", title: "Get workspace recovery",
      entryKind: "tool", status: "active", riskLevel: "read", isReadOnly: true,
      inputSchema: { type: "object" }, versionHash: "legacy", schemaHash: "legacy",
    });
    expect(await f.service.listCatalog(f.connected.connectionId, f.company.id, actor)).toHaveLength(274);
    f.request.mockClear();
    await expect(f.call("daytona_toolbox_execute_command", { sandboxId: f.sandboxId, body: { command: "true" } })).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
    expect(JSON.stringify(await f.call("daytona_api_list_sandboxes", {}))).toContain(f.sandboxId);
  });

  it("blocks a stale same-name contract before board refresh, including an existing session", async () => {
    const f = await fixture();
    const changed = f.connected.catalog.find(entry => entry.toolName === "daytona_toolbox_execute_command")!;
    await db.update(toolCatalogEntries).set({ versionHash: "earlier-provider-contract", schemaHash: "earlier-schema", riskLevel: "read" })
      .where(eq(toolCatalogEntries.id, changed.id));
    f.request.mockClear();
    expect((await f.gateway.listToolsForSession(f.session.token)).some(tool => tool.upstreamToolName === changed.toolName)).toBe(false);
    await expect(f.call(changed.toolName, { sandboxId: f.sandboxId, body: { command: "true" } })).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
    const refreshed = await f.service.refreshCatalog(f.connected.connectionId, actor);
    expect(refreshed.catalog.find(entry => entry.toolName === changed.toolName)?.status).toBe("quarantined");
  });

  it("carries a caller deadline across prerequisite reads and never starts a late write", async () => {
    const f = await fixture();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (url, init) => {
      if (url.endsWith("/api-keys/current")) await new Promise(resolve => setTimeout(resolve, 80));
      return original(url, init);
    });
    f.request.mockClear();
    await expect(f.call("daytona_toolbox_execute_command", { sandboxId: f.sandboxId, body: { command: "true" } }, 20)).rejects.toThrow("deadline expired");
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(f.request.mock.calls.every(([url]) => url.endsWith("/api-keys/current"))).toBe(true);
  });
});

describe("Daytona provider client", () => {
  it("validates every published action schema before provider dispatch", async () => {
    const request = vi.fn(async () => { throw new Error("Unexpected provider request"); });
    expect(DAYTONA_TOOLS).toHaveLength(274);
    for (const tool of DAYTONA_TOOLS) {
      await expect(executeDaytonaTool({ binding: { companyId: "company", agentId: "agent" },
        connection: { companyId: "company", config: {} }, headers: { Authorization: `Bearer ${credential}` },
        request, toolName: tool.name, parameters: null }), tool.name).rejects.toThrow("Invalid Daytona action arguments");
    }
    expect(request).not.toHaveBeenCalled();
  });
  it("fails closed on organization mismatch and sanitizes provider errors", async () => {
    await expect(daytonaClient({ Authorization: `Bearer ${credential}` }, async () => Response.json({ organizationId: randomUUID() }), randomUUID()).probe())
      .rejects.toThrow("configured organization");
    await expect(daytonaClient({ Authorization: `Bearer ${credential}` }, async () => new Response(credential, { status: 403 })).probe())
      .rejects.toThrow("Daytona denied access");
  });
  it("bounds response bytes", async () => {
    await expect(daytonaClient({ Authorization: `Bearer ${credential}` }, async () => new Response("x".repeat(8 * 1024 * 1024 + 1))).probe())
      .rejects.toThrow("exceeded the limit");
  });
  it("does not expose transport stream errors", async () => {
    const request = async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(credential)); } }));
    await expect(daytonaClient({ Authorization: `Bearer ${credential}` }, request).probe()).rejects.toThrow("response was interrupted");
  });
});
