import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, approvals, companies, companyMemberships, companySecrets, connectionGrants,
  createDb, heartbeatRuns, issues, toolAccessAuditEvents, toolActionRequests,
  toolApplications, toolCallEvents, toolConnections, toolOauthStates,
} from "@paperclipai/db";
import { classifyRisk, toolAccessService, type McpToolDescriptor } from "../services/tool-access.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const actor = { actorType: "user" as const, actorId: "braintrust-reviewer" };
const redirectUri = "https://paperclip.fixture.test/api/tools/oauth/callback";
const initialTools: McpToolDescriptor[] = [
  { name: "sql_query", inputSchema: { type: "object", properties: { query: { type: "string" } } }, annotations: { readOnlyHint: true } },
  // Deliberately incorrect provider hints must never downgrade reviewed risk.
  { name: "run_eval", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  { name: "edit_dataset_rows", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  { name: "set_automation_status", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
];

describe("Braintrust reviewed tool risks", () => {
  it.each([
    "sql_query", "infer_schema", "summarize_experiment", "list_recent_objects", "resolve_object",
    "generate_permalink", "lookup_users", "lookup_api_keys", "get_trace_work_items", "search_patterns",
    "generate_monitor_chart", "list_monitoring_views", "get_monitoring_view", "list_automations",
    "list_slack_channels", "get_project_settings", "search_docs", "load_braintrust_skill",
  ])("allows only reviewed retrieval %s to be read risk", name => {
    expect(classifyRisk({ name }, "braintrust")).toBe("read");
    expect(classifyRisk({ name, annotations: { readOnlyHint: false } }, "braintrust")).toBe("write");
    expect(classifyRisk({ name, annotations: { writeHint: true } }, "braintrust")).toBe("write");
    expect(classifyRisk({ name, annotations: { destructiveHint: true } }, "braintrust")).toBe("destructive");
  });

  it.each([
    "update_trace_work_report", "new_pattern", "update_pattern", "create_preprocessor", "test_preprocessor_on_trace",
    "create_facet", "test_facet_on_trace", "enable_topics_automation", "set_topics_automation", "rewind_topics_automation",
    "create_monitoring_view", "update_monitoring_view", "create_log_alert", "create_environment_update_alert",
    "create_threshold_alert", "create_scheduled_loop_job", "create_prompt", "create_evaluator", "create_human_review_score",
    "test_evaluator", "update_online_scoring_rule", "run_eval", "add_to_dataset", "set_project_default_preprocessor",
    "new_provider_tool", "sql_query_v2", "SQL_QUERY",
  ])("keeps %s at write risk even when the provider advertises read-only", name => {
    expect(classifyRisk({ name, annotations: { readOnlyHint: true } }, "braintrust")).toBe("write");
    expect(classifyRisk({ name, annotations: { destructive: true } }, "braintrust")).toBe("destructive");
  });

  it.each(["edit_dataset_rows", "set_automation_status"])("keeps %s destructive regardless of hints", name => {
    expect(classifyRisk({ name, annotations: { readOnlyHint: true, writeHint: true } }, "braintrust")).toBe("destructive");
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("Braintrust connection lifecycle and governed gateway", () => {
  let db: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-braintrust-");
    db = createDb(temp.connectionString);
  }, 30000);
  afterAll(async () => { await temp?.cleanup(); });

  async function fixture(options: { methodKey?: string; personal?: boolean; deferOAuth?: boolean } = {}) {
    const methodKey = options.methodKey ?? "mcp-api-key";
    const oauth = methodKey.endsWith("oauth");
    const origin = methodKey.includes("-eu-") ? "https://api-eu.braintrust.dev" : "https://api.braintrust.dev";
    const endpoint = `${origin}/mcp`;
    const accessToken = `braintrust-fixture-${randomUUID()}`;
    const refreshToken = `braintrust-refresh-${randomUUID()}`;
    const [company] = await db.insert(companies).values({ name: "Braintrust fixture", issuePrefix: `BT${randomUUID().slice(0, 6)}` }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: actor.actorId, status: "active", membershipRole: "admin" });
    let tools = [...initialTools];
    let authorized = !oauth;
    const request = vi.fn(async (url: string, init: RequestInit) => {
      // A region-specific token must never be sent to another region.
      expect(new URL(url).origin).toBe(origin);
      const headers = new Headers(init.headers);
      const body = String(init.body ?? "");
      if (url === endpoint && init.method === "POST") {
        if (!authorized || headers.get("authorization") !== `Bearer ${accessToken}`) {
          return new Response(null, { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` } });
        }
        const rpc = JSON.parse(body);
        if (rpc.method === "initialize") return Response.json({ jsonrpc: "2.0", id: rpc.id,
          result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "Braintrust fixture", version: "1" } } });
        if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
        if (rpc.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { tools } });
        if (rpc.method === "tools/call") return Response.json({ jsonrpc: "2.0", id: rpc.id,
          result: { content: [{ type: "text", text: `Executed ${rpc.params.name}` }], structuredContent: { operation: rpc.params.name, reflectedCredential: accessToken } } });
      }
      if (url.includes("oauth-protected-resource")) return Response.json({ resource: endpoint, authorization_servers: [origin], scopes_supported: ["mcp"] });
      if (url === `${origin}/.well-known/oauth-authorization-server`) return Response.json({
        issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`,
        registration_endpoint: `${origin}/oauth/register`, code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"], scopes_supported: ["mcp"],
      });
      if (url === `${origin}/oauth/register`) return Response.json({ ...JSON.parse(body), client_id: "braintrust-fixture-client" });
      if (url === `${origin}/oauth/token`) {
        authorized = true;
        return Response.json({ access_token: accessToken, refresh_token: refreshToken, expires_in: 3600, token_type: "Bearer", scope: "mcp" });
      }
      return new Response(null, { status: 404 });
    });
    const service = toolAccessService(db, { remoteHttpRequest: request, remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }] });
    const connectInput = { galleryKey: "braintrust", connectionMethodKey: methodKey,
      ...(options.personal ? { grantKind: "user" as const } : {}),
      ...(!oauth ? { credentialValues: { "credentials.authorization": accessToken } } : {}) };
    const connect = () => service.connectGalleryApp(company.id, connectInput, actor);
    const signIn = async (connectionId: string) => {
      const start = await service.startOAuth(company.id, connectionId, { redirectUri, actor });
      const authorization = new URL(start.authorizationUrl);
      expect(start.registrationSource).toBe("dcr");
      expect(authorization.origin).toBe(origin);
      expect(authorization.searchParams.get("scope")).toBe("mcp");
      expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorization.searchParams.get("resource")).toBe(endpoint);
      return service.completeOAuthCallback({ state: authorization.searchParams.get("state")!, code: "fixture-code", iss: origin, redirectUri, actor });
    };
    let connected = await connect();
    if (oauth && options.deferOAuth) return { company, service, request, connect, accessToken, endpoint, origin, signIn, connected,
      agent: undefined, gateway: undefined, session: undefined, call: undefined, run: undefined, issue: undefined, setTools: undefined };
    if (oauth && !options.deferOAuth) connected = await signIn(connected.connectionId);
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Braintrust analyst", role: "engineer", adapterType: "process" }).returning();
    await service.finishGalleryAppConnection(company.id, connected.connectionId, { enabledCatalogEntryIds: connected.catalog.map(entry => entry.id), askFirstCatalogEntryIds: [], access: { agentIds: [agent.id] } }, actor);
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Braintrust fixture work", assigneeAgentId: agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id,
      scopeKind: "issue", invocationSource: "on_demand", status: "running", responsibleUserId: actor.actorId, contextSnapshot: { issueId: issue.id } }).returning();
    const gateway = createToolGatewayService(db, { remoteHttpRequest: request, toolActionSigningSecret: "braintrust-fixture-signing-key" });
    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id, issueId: issue.id });
    const listed = await gateway.listToolsForSession(session.token);
    const call = (name: string, parameters = {}) => {
      const tool = listed.find(entry => entry.upstreamToolName === name);
      expect(tool, name).toBeTruthy();
      return gateway.executeTool({ sessionToken: session.token, tool: tool!.name, parameters, idempotencyKey: randomUUID() });
    };
    return { company, service, request, connect, accessToken, endpoint, origin, signIn,
      connected, agent, gateway, session, call, run, issue, setTools: (next: McpToolDescriptor[]) => { tools = next; } };
  }

  it.each([
    ["mcp-api-key", false], ["mcp-eu-api-key", true], ["mcp-oauth", true], ["mcp-eu-oauth", false],
  ])("connects %s with the selected credential ownership and run-scoped reads and writes", async (methodKey, personal) => {
    const f = await fixture({ methodKey: String(methodKey), personal: Boolean(personal) });
    const connected = f.connected!;
    expect(connected.connection.config).toMatchObject({ url: f.endpoint, sourceTemplateKey: "braintrust", connectionMethodKey: methodKey, quarantineNewEntries: true });
    expect(connected.catalog.every(entry => entry.status === "active")).toBe(true);
    expect(connected.suggestedDefaults.askFirstRiskLevels).toEqual([]);
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, connected.connectionId));
    expect(grant.kind).toBe(personal ? "user" : "organization");
    for (const ref of grant.credentialSecretRefs) {
      const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.id, ref.secretId));
      expect(secret.scope).toBe(personal ? "user" : "company");
      expect(secret.ownerUserId).toBe(personal ? actor.actorId : null);
    }
    expect(JSON.stringify(await f.call!("sql_query", { query: "SELECT id FROM project_logs LIMIT 1" }))).toContain("Executed sql_query");
    const write = JSON.stringify(await f.call!("run_eval"));
    expect(write).toContain("Executed run_eval");
    expect(write).not.toContain(f.accessToken);
    const persisted = { connection: await f.service.getConnection(connected.connectionId),
      audit: await db.select().from(toolAccessAuditEvents).where(eq(toolAccessAuditEvents.companyId, f.company.id)),
      calls: await db.select().from(toolCallEvents).where(eq(toolCallEvents.companyId, f.company.id)) };
    expect(JSON.stringify(persisted)).not.toContain(f.accessToken);
  });

  it("keeps EU OAuth cancellation resumable with the same region and method", async () => {
    const f = await fixture({ methodKey: "mcp-eu-oauth", deferOAuth: true });
    const connected = f.connected!;
    const start = await f.service.startOAuth(f.company.id, connected.connectionId, { redirectUri, actor });
    await expect(f.service.completeOAuthCallback({ state: new URL(start.authorizationUrl).searchParams.get("state")!, error: "access_denied", redirectUri, actor })).rejects.toMatchObject({ status: 400 });
    expect(await db.select().from(toolOauthStates).where(eq(toolOauthStates.connectionId, connected.connectionId))).toHaveLength(0);
    const resumed = await f.service.connectGalleryApp(f.company.id, { galleryKey: "braintrust", connectionMethodKey: "mcp-eu-oauth", resumeConnectionId: connected.connectionId }, actor);
    expect(resumed.connectionId).toBe(connected.connectionId);
    expect(resumed.connection.config).toMatchObject({ url: f.endpoint, connectionMethodKey: "mcp-eu-oauth" });
    await f.signIn(connected.connectionId);
    expect((await f.service.listCatalog(connected.connectionId)).every(entry => entry.status === "active")).toBe(true);
  });

  it("cleans up vaulted credentials and the new identity after failed discovery", async () => {
    const [company] = await db.insert(companies).values({ name: "Braintrust failed setup", issuePrefix: `BF${randomUUID().slice(0, 6)}` }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: actor.actorId, status: "active", membershipRole: "admin" });
    const service = toolAccessService(db, {
      remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }],
      remoteHttpRequest: async () => new Response("provider-private-detail", { status: 503 }),
    });
    await expect(service.connectGalleryApp(company.id, { galleryKey: "braintrust", connectionMethodKey: "mcp-api-key", grantKind: "user",
      credentialValues: { "credentials.authorization": "braintrust-failed-setup-key" } }, actor)).rejects.toMatchObject({ status: 502 });
    for (const table of [toolConnections, toolApplications, connectionGrants, companySecrets]) {
      expect(await db.select().from(table).where(eq(table.companyId, company.id))).toHaveLength(0);
    }
  });

  it.each(["mcp-api-key", "mcp-eu-oauth"])("preserves policy and quarantines added or changed tools on %s refresh and reconnect", async methodKey => {
    const f = await fixture({ methodKey });
    const connected = f.connected!;
    const offName = "set_automation_status", askName = "edit_dataset_rows";
    await f.service.finishGalleryAppConnection(f.company.id, connected.connectionId, {
      enabledCatalogEntryIds: connected.catalog.filter(entry => entry.toolName !== offName).map(entry => entry.id),
      askFirstCatalogEntryIds: connected.catalog.filter(entry => entry.toolName === askName).map(entry => entry.id), access: { agentIds: [f.agent!.id] },
    }, actor);
    f.request.mockClear();
    await expect(f.call!(offName)).rejects.toThrow();
    await expect(f.call!(askName)).rejects.toMatchObject({ reasonCode: "approval_required" });
    expect(f.request).not.toHaveBeenCalled();
    const [pending] = await db.select().from(toolActionRequests).where(eq(toolActionRequests.companyId, f.company.id));
    if (pending.approvalId) await db.update(approvals).set({ status: "approved", decidedByUserId: actor.actorId, decidedAt: new Date() }).where(eq(approvals.id, pending.approvalId));
    await f.gateway!.approveActionRequest({ companyId: f.company.id, actionRequestId: pending.id, actor: { userId: actor.actorId } });
    expect(f.request.mock.calls.filter(([, init]) => String(init.body).includes('"method":"tools/call"'))).toHaveLength(1);
    f.setTools!([...initialTools.map(tool => tool.name === "sql_query" ? {
      ...tool, inputSchema: { type: "object", properties: { query: { type: "string" }, project_id: { type: "string" } } },
    } : tool), { name: "provider_added_tool", annotations: { readOnlyHint: true } }]);
    const refreshed = await f.service.refreshCatalog(connected.connectionId, actor, { enableAllByDefault: true });
    expect(refreshed.catalog.find(entry => entry.toolName === "sql_query")?.status).toBe("quarantined");
    expect(refreshed.catalog.find(entry => entry.toolName === "provider_added_tool")).toMatchObject({ riskLevel: "write", status: "quarantined" });
    if (methodKey.endsWith("oauth")) await f.signIn(connected.connectionId);
    else await f.service.reconnectGalleryApp(connected.connectionId, f.company.id, { credentialValues: { "credentials.authorization": f.accessToken } }, actor);
    const afterReconnect = await f.service.refreshCatalog(connected.connectionId, actor, { enableAllByDefault: true });
    expect(afterReconnect.connection.config.quarantineNewEntries).toBe(true);
    expect(afterReconnect.connection.transportConfig.quarantineNewEntries).toBe(true);
    expect(afterReconnect.catalog.filter(entry => ["sql_query", "provider_added_tool"].includes(entry.toolName)).every(entry => entry.status === "quarantined")).toBe(true);
    f.request.mockClear();
    await expect(f.call!("sql_query")).rejects.toThrow();
    await expect(f.call!(offName)).rejects.toThrow();
    await expect(f.call!(askName, { dataset_id: "new-dataset-after-reconnect" })).rejects.toMatchObject({ reasonCode: "approval_required" });
    expect(f.request).not.toHaveBeenCalled();
  });

  it("refreshes the EU OAuth grant at its issuer and enforces ownership, company and revocation boundaries", async () => {
    const f = await fixture({ methodKey: "mcp-eu-oauth", personal: true });
    const connected = f.connected!;
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, connected.connectionId));
    f.request.mockClear();
    await f.service.refreshOAuthGrantCredentials({ companyId: f.company.id, connectionId: connected.connectionId, grantId: grant.id, forceRefresh: true, actor });
    expect(f.request.mock.calls.some(([url, init]) => url === `${f.origin}/oauth/token` && new URLSearchParams(String(init.body)).get("grant_type") === "refresh_token")).toBe(true);
    expect(JSON.stringify(await f.call!("sql_query"))).not.toContain(f.accessToken);
    await expect(f.service.getConnection(connected.connectionId, randomUUID())).rejects.toMatchObject({ status: 404 });
    await expect(f.gateway!.createSession({ companyId: randomUUID(), agentId: f.agent!.id, runId: f.run!.id })).rejects.toThrow();
    await expect(f.service.reconnectGalleryApp(connected.connectionId, f.company.id, { credentialValues: { "credentials.authorization": "other-user-value" } }, { actorType: "user", actorId: "another-user" })).rejects.toThrow();
    // Existing gateway sessions must reject a secret that no longer belongs to
    // the selected personal identity; they cannot fall back to company secrets.
    const accessRef = grant.credentialSecretRefs.find(ref => ref.configPath === "oauth.access_token")!;
    await db.update(companySecrets).set({ ownerUserId: "another-user" }).where(eq(companySecrets.id, accessRef.secretId));
    f.request.mockClear();
    await expect(f.call!("sql_query")).rejects.toMatchObject({ reasonCode: "grant_credential_invalid" });
    expect(f.request).not.toHaveBeenCalled();
    await db.update(companySecrets).set({ ownerUserId: actor.actorId }).where(eq(companySecrets.id, accessRef.secretId));
    await f.service.revokeConnectionGrant(connected.connectionId, grant.id, actor);
    await expect(f.call!("sql_query")).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
    await f.service.archiveConnection(connected.connectionId, f.company.id, actor);
    expect(await db.select().from(companySecrets).where(and(eq(companySecrets.companyId, f.company.id), eq(companySecrets.ownerUserId, actor.actorId)))).toHaveLength(0);
  });
});
