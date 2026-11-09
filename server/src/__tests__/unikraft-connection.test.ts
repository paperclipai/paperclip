import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, companyMemberships, companySecrets, connectionGrants, createDb,
  ensurePostgresDatabase, applyPendingMigrations, heartbeatRuns, issues, toolCatalogEntries, toolConnections } from "@paperclipai/db";
import { toolAccessService } from "../services/tool-access.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { UNIKRAFT_TOOLS, executeUnikraftTool, unikraftClient } from "../services/connectors/unikraft/client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
const actor = { actorType: "user" as const, actorId: "unikraft-reviewer" };
const credential = "unikraft-fixture-token";
(support.supported ? describe : describe.skip)("Unikraft governed provider actions", () => {
  let db: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  beforeAll(async () => {
    if (external) {
      const url = new URL(external); url.pathname = "/unikraft_" + randomUUID().replaceAll("-", "");
      await ensurePostgresDatabase(external, url.pathname.slice(1));
      await applyPendingMigrations(url.toString()); db = createDb(url.toString());
    } else { temp = await startEmbeddedPostgresTestDatabase("unikraft-connector-"); db = createDb(temp.connectionString); }
  }, 30000);
  afterAll(async () => { await db?.$client.end(); await temp?.cleanup(); });

  async function fixture(options: { personal?: boolean; metro?: string } = {}) {
    const [company] = await db.insert(companies).values({ name: "Unikraft fixture", issuePrefix: `U${randomUUID().slice(0, 6)}` }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: actor.actorId, membershipRole: "admin", status: "active" });
    const instanceId = randomUUID();
    const request = vi.fn(async (url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${credential}`);
      expect(["error", "manual"]).toContain(init.redirect);
      const parsed = new URL(url);
      expect(parsed.hostname).toMatch(/^api\.(dal|fra|sfo|sin|was)\.unikraft\.cloud$/);
      const metro = parsed.hostname.split(".")[1];
      const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      if (parsed.pathname === "/v1/users/quotas") return Response.json({ status: "success", data: { quotas: [{ uuid: randomUUID() }] }, op_time_us: 1 });
      if (parsed.pathname === "/v1/instances" && init.method === "GET") {
        return Response.json({ status: "success", data: { instances: [{ uuid: instanceId, name: "web", metro, selector: body ?? null }] }, op_time_us: 1 });
      }
      if (parsed.pathname === "/v1/instances" && init.method === "POST") return Response.json({ status: "success", data: { instances: [{ uuid: instanceId, ...body }] }, op_time_us: 1 });
      if (parsed.pathname === `/v1/instances/${instanceId}` && init.method === "DELETE") return Response.json({ status: "success", data: { instances: [{ uuid: instanceId, state: "deleted" }] }, op_time_us: 1 });
      if (parsed.pathname === "/v1/instances/web/plugins/sandbox/commands" && init.method === "POST") {
        return Response.json({ uuid: randomUUID(), cmd: body.cmd, stdout: `ran with ${credential}` });
      }
      throw new Error(`Unexpected provider request ${init.method} ${url}`);
    });
    const service = toolAccessService(db, { remoteHttpRequest: request, remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }] });
    const connected = await service.connectGalleryApp(company.id, { galleryKey: "unikraft", methodKey: "api-token",
      ...(options.personal ? { grantKind: "user" as const } : {}), ...(options.metro ? { configValues: { metro: options.metro } } : {}),
      credentialValues: { "credentials.authorization": credential } }, actor);
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Operator", role: "engineer", adapterType: "process" }).returning();
    await service.finishGalleryAppConnection(company.id, connected.connectionId, { enabledCatalogEntryIds: connected.catalog.map(c => c.id),
      askFirstCatalogEntryIds: [], access: { agentIds: [agent.id] } }, actor);
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Provider work", assigneeAgentId: agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id,
      scopeKind: "issue", invocationSource: "on_demand", status: "running", responsibleUserId: actor.actorId, contextSnapshot: { issueId: issue.id } }).returning();
    const gateway = createToolGatewayService(db, { remoteHttpRequest: request });
    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id, issueId: issue.id });
    const tools = await gateway.listToolsForSession(session.token);
    const call = (name: string, parameters: unknown) => {
      const tool = tools.find(t => t.upstreamToolName === name);
      expect(tool, name).toBeTruthy();
      return gateway.executeTool({ sessionToken: session.token, tool: tool!.name, parameters, idempotencyKey: randomUUID() });
    };
    return { company, service, connected, agent, request, call, gateway, session, instanceId };
  }

  it.each([false, true])("uses the selected vault identity for real gateway reads, writes and sandbox commands (personal=%s)", async personal => {
    const f = await fixture({ personal });
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, f.connected.connectionId));
    const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.id, grant.credentialSecretRefs[0].secretId));
    expect(grant.kind).toBe(personal ? "user" : "organization");
    expect(secret.scope).toBe(personal ? "user" : "company");
    expect(secret.ownerUserId).toBe(personal ? actor.actorId : null);
    expect(f.connected.catalog).toHaveLength(UNIKRAFT_TOOLS.length);
    expect(f.connected.catalog.find(c => c.toolName === "unikraft_get_instances")).toMatchObject({ isReadOnly: true });
    expect(f.connected.catalog.find(c => c.toolName === "unikraft_create_instance")).toMatchObject({ isReadOnly: false, isDestructive: false });
    for (const name of ["unikraft_delete_instance_by_uuid", "unikraft_stop_instances", "unikraft_sandbox_run_command"]) {
      expect(f.connected.catalog.find(c => c.toolName === name), name).toMatchObject({ isDestructive: true, isReadOnly: false });
    }
    expect(JSON.stringify(await f.service.getConnection(f.connected.connectionId))).not.toContain(credential);
    // The token is verified against the default metro.
    expect(f.request.mock.calls.some(([url]) => url === "https://api.fra.unikraft.cloud/v1/users/quotas")).toBe(true);
    // Batch selectors travel as a JSON body even on GET.
    const listed = JSON.stringify(await f.call("unikraft_get_instances", { body: [{ name: "web" }] }));
    expect(listed).toContain(f.instanceId); expect(listed).toContain('"metro":"fra"'); expect(listed).toContain('"name":"web"');
    expect(JSON.stringify(await f.call("unikraft_get_instances", { metro: "sin" }))).toContain('"metro":"sin"');
    expect(JSON.stringify(await f.call("unikraft_create_instance", { body: { image: "nginx:latest" } }))).toContain("nginx:latest");
    expect(JSON.stringify(await f.call("unikraft_delete_instance_by_uuid", { path: { uuid: f.instanceId } }))).toContain("deleted");
    const ran = JSON.stringify(await f.call("unikraft_sandbox_run_command", { instance: "web", body: { cmd: "echo done" } }));
    expect(ran).toContain("echo done"); expect(ran).not.toContain(credential);
  }, 30000);

  it("uses the connection's default metro for verification and actions that do not name one", async () => {
    const f = await fixture({ metro: "was" });
    expect(f.request.mock.calls.some(([url]) => url === "https://api.was.unikraft.cloud/v1/users/quotas")).toBe(true);
    expect(JSON.stringify(await f.call("unikraft_get_instances", {}))).toContain('"metro":"was"');
  });

  it("rejects unpublished metros, unknown arguments, path traversal and foreign bindings before forwarding the token", async () => {
    const f = await fixture(); f.request.mockClear();
    await expect(f.call("unikraft_get_instances", { metro: "attacker.example" })).rejects.toThrow();
    await expect(f.call("unikraft_get_instances", { command: "printenv" })).rejects.toThrow();
    await expect(f.call("unikraft_sandbox_run_command", { instance: "../../users/quotas", body: { cmd: "true" } })).rejects.toThrow("Invalid Unikraft path");
    expect(f.request).not.toHaveBeenCalled();
    await expect(executeUnikraftTool({ binding: { companyId: randomUUID(), agentId: f.agent.id },
      connection: { companyId: f.company.id, config: {} }, headers: { Authorization: `Bearer ${credential}` }, request: f.request,
      toolName: "unikraft_get_instances", parameters: {} })).rejects.toThrow("Connection not found");
    await expect(executeUnikraftTool({ binding: { companyId: f.company.id, agentId: f.agent.id },
      connection: { companyId: f.company.id, config: { methodConfig: { metro: "evil" } } }, headers: { Authorization: `Bearer ${credential}` },
      request: f.request, toolName: "unikraft_get_instances", parameters: {} })).rejects.toThrow("Choose a Unikraft Cloud metro");
    expect(f.request).not.toHaveBeenCalled();
  });

  it("rechecks revocation and Off policies for a previously created gateway session", async () => {
    const f = await fixture();
    await f.service.finishGalleryAppConnection(f.company.id, f.connected.connectionId, {
      enabledCatalogEntryIds: f.connected.catalog.filter(c => c.toolName !== "unikraft_sandbox_run_command").map(c => c.id),
      askFirstCatalogEntryIds: [], access: { agentIds: [f.agent.id] },
    }, actor);
    f.request.mockClear();
    await expect(f.call("unikraft_sandbox_run_command", { instance: "web", body: { cmd: "true" } })).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
    await db.update(toolConnections).set({ enabled: false }).where(and(eq(toolConnections.id, f.connected.connectionId), eq(toolConnections.companyId, f.company.id)));
    await expect(f.call("unikraft_get_instances", {})).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });

  it("blocks a stale same-name contract and quarantines it on refresh", async () => {
    const f = await fixture();
    const changed = f.connected.catalog.find(entry => entry.toolName === "unikraft_sandbox_run_command")!;
    await db.update(toolCatalogEntries).set({ versionHash: "earlier-provider-contract", schemaHash: "earlier-schema", riskLevel: "read" })
      .where(eq(toolCatalogEntries.id, changed.id));
    f.request.mockClear();
    expect((await f.gateway.listToolsForSession(f.session.token)).some(tool => tool.upstreamToolName === changed.toolName)).toBe(false);
    await expect(f.call(changed.toolName, { instance: "web", body: { cmd: "true" } })).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
    const refreshed = await f.service.refreshCatalog(f.connected.connectionId, actor, { enableAllByDefault: true });
    expect(refreshed.catalog.find(entry => entry.toolName === changed.toolName)?.status).toBe("quarantined");
  });

  it("does not export the token to agents", async () => {
    const f = await fixture();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agent.id));
    await expect(f.service.mintConnectionTokenForAgent({ connectionId: f.connected.connectionId, companyId: f.company.id,
      agentId: f.agent.id, runId: run.id, body: {} as never })).rejects.toThrow("Unikraft credentials stay in the governed tool gateway");
  });
});

describe("Unikraft provider client", () => {
  it("validates every published action schema before provider dispatch", async () => {
    const request = vi.fn(async () => { throw new Error("Unexpected provider request"); });
    expect(UNIKRAFT_TOOLS).toHaveLength(105);
    for (const tool of UNIKRAFT_TOOLS) {
      await expect(executeUnikraftTool({ binding: { companyId: "company", agentId: "agent" },
        connection: { companyId: "company", config: {} }, headers: { Authorization: `Bearer ${credential}` },
        request, toolName: tool.name, parameters: null }), tool.name).rejects.toThrow("Invalid Unikraft action arguments");
    }
    expect(request).not.toHaveBeenCalled();
  });
  it("sanitizes provider denials and rejects an unconfirmed token", async () => {
    await expect(unikraftClient({ Authorization: `Bearer ${credential}` }, async () => new Response(credential, { status: 401 })).probe())
      .rejects.toThrow("Unikraft denied access");
    await expect(unikraftClient({ Authorization: `Bearer ${credential}` }, async () => Response.json({ status: "error" })).probe())
      .rejects.toThrow("did not confirm");
  });
  it("accepts the documented -1 drain timeout for the longest drain", async () => {
    const request = vi.fn(async (_url: string, init: RequestInit) => Response.json({ status: "success", echo: JSON.parse(init.body as string) }));
    for (const [toolName, parameters] of [
      ["unikraft_stop_instances", { body: [{ name: "web", drain_timeout_ms: -1 }] }],
      ["unikraft_suspend_instance_by_uuid", { path: { uuid: randomUUID() }, body: { drain_timeout_ms: -1 } }],
    ] as const) {
      await executeUnikraftTool({ binding: { companyId: "company", agentId: "agent" }, connection: { companyId: "company", config: {} },
        headers: { Authorization: `Bearer ${credential}` }, request, toolName, parameters });
    }
    expect(request).toHaveBeenCalledTimes(2);
    await expect(executeUnikraftTool({ binding: { companyId: "company", agentId: "agent" }, connection: { companyId: "company", config: {} },
      headers: { Authorization: `Bearer ${credential}` }, request, toolName: "unikraft_stop_instances",
      parameters: { body: [{ name: "web", drain_timeout_ms: -2 }] } })).rejects.toThrow("Invalid Unikraft action arguments");
  });
  it("reports a timed-out sandbox wait as a still-running command, not a provider failure", async () => {
    const commandId = randomUUID();
    const request = vi.fn(async () => new Response(null, { status: 408 }));
    const call = (toolName: string) => executeUnikraftTool({ binding: { companyId: "company", agentId: "agent" },
      connection: { companyId: "company", config: {} }, headers: { Authorization: `Bearer ${credential}` }, request, toolName,
      parameters: { instance: "web", path: { uuid: commandId }, ...(toolName.endsWith("with_timeout") ? { body: { timeout_s: 0.01 } } : {}) } });
    await expect(call("unikraft_sandbox_wait_for_command_with_timeout")).resolves.toMatchObject({ status: "running", timedOut: true });
    expect(request.mock.calls[0]![0]).toBe(`https://api.fra.unikraft.cloud/v1/instances/web/plugins/sandbox/commands/${commandId}/wait_timeout`);
    // Other operations keep treating 408 as a failure.
    await expect(call("unikraft_sandbox_get_command_by_uuid")).rejects.toThrow("Unikraft could not complete this operation");
  });
  it("bounds response bytes", async () => {
    await expect(unikraftClient({ Authorization: `Bearer ${credential}` }, async () => new Response("x".repeat(8 * 1024 * 1024 + 1))).probe())
      .rejects.toThrow("exceeded the limit");
  });
});
