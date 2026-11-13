import { randomUUID } from "node:crypto";
import express from "express";
import http from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, approvals, companies, companyMemberships, connectionGrants, createDb, heartbeatRuns, issues, principalPermissionGrants, toolActionRequests, toolCatalogEntries, toolConnections, toolInvocations, toolMcpAppViews, toolPolicies,
} from "@paperclipai/db";
import { MCP_APP_MIME_TYPE, MCP_APPS_EXTENSION_ID } from "@paperclipai/shared";
import { errorHandler } from "../middleware/error-handler.js";
import { mcpAppsRoutes } from "../routes/mcp-apps.js";
import { toolAccessRoutes } from "../routes/tool-access.js";
import { toolAccessService, type McpToolDescriptor } from "../services/tool-access.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { mcpAppCallToolResult } from "../services/mcp-app-views.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const actor = { actorType: "user" as const, actorId: "circleback-reviewer" };
const redirectUri = "https://paperclip.fixture.test/api/tools/oauth/callback";
const VIEW_URI = "ui://circleback/meetings.html";
// Real views bundle their scripts; Circleback's is about 3.5 MB. This one is
// larger than the 1 MB limit on agent-facing tool results.
const VIEW_HTML = `<!doctype html><html><body><div id=cards>Meetings</div><script>/* ${"view bundle ".repeat(120_000)} */</script></body></html>`;

// Circleback-shaped server: a model+app view tool, an app-only refresh tool,
// a model-only view tool, and a plain read tool.
const tools: McpToolDescriptor[] = [
  { name: "SearchMeetings", inputSchema: { type: "object" } },
  { name: "DisplayMeetings", inputSchema: { type: "object", properties: { meetingIds: { type: "array" } } },
    _meta: { ui: { resourceUri: VIEW_URI } } } as McpToolDescriptor,
  { name: "RefreshMeetingCards", inputSchema: { type: "object" },
    _meta: { ui: { resourceUri: VIEW_URI, visibility: ["app"] } } } as McpToolDescriptor,
  { name: "DisplayCalendarEvents", inputSchema: { type: "object" },
    _meta: { ui: { resourceUri: "ui://circleback/calendar.html", visibility: ["model"] } } } as McpToolDescriptor,
];

describe("mcpAppCallToolResult", () => {
  it("rebuilds the MCP CallToolResult from the gateway's normalized result", () => {
    expect(mcpAppCallToolResult({
      content: "text",
      data: { content: [{ type: "text", text: "Two meetings" }], structuredContent: { meetings: [1, 2] }, isError: false },
    }, { "circleback/viewState": "cards" })).toEqual({
      content: [{ type: "text", text: "Two meetings" }],
      structuredContent: { meetings: [1, 2] },
      _meta: { "circleback/viewState": "cards" },
    });
    expect(mcpAppCallToolResult({ content: "plain" })).toEqual({ content: [{ type: "text", text: "plain" }] });
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("MCP Apps views end to end (Circleback)", () => {
  let db: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-mcp-apps-");
    db = createDb(temp.connectionString);
  }, 30000);
  afterAll(async () => { await temp?.cleanup(); });

  async function fixture(options: { requireSession?: boolean; personal?: boolean } = {}) {
    const origin = "https://circleback.ai";
    const endpoint = `${origin}/api/mcp`;
    const accessToken = `circleback-fixture-${randomUUID()}`;
    const [company] = await db.insert(companies).values({ name: "Circleback fixture", issuePrefix: `CB${randomUUID().slice(0, 6)}` }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: actor.actorId, status: "active", membershipRole: "admin" });
    let authorized = false;
    const initializeCapabilities: unknown[] = [];
    const resourceReadSessions: Array<string | null> = [];
    let failResourceReads = false;
    let expireNextResourceRead = false;
    let initializeGate: { wait: Promise<void>; entered: () => void } | null = null;
    let sessionCounter = 0;
    const request = vi.fn(async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      const body = String(init.body ?? "");
      if (url === endpoint && init.method === "POST") {
        if (!authorized || headers.get("authorization") !== `Bearer ${accessToken}`) {
          return new Response(null, { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/api/mcp"` } });
        }
        const rpc = JSON.parse(body);
        if (rpc.method === "initialize") {
          initializeCapabilities.push(rpc.params?.capabilities);
          const gate = initializeGate;
          initializeGate = null;
          if (gate) {
            gate.entered();
            await gate.wait;
          }
          sessionCounter += 1;
          return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "Circleback fixture", version: "1" } } },
            options.requireSession ? { headers: { "mcp-session-id": `fixture-session-${sessionCounter}` } } : undefined);
        }
        // A stateful server refuses requests outside an initialized session.
        if (options.requireSession && rpc.method !== "notifications/initialized" && !headers.get("mcp-session-id")?.startsWith("fixture-session-")) {
          return Response.json({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32000, message: "Bad Request: No valid session ID provided" } }, { status: 400 });
        }
        if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
        if (rpc.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { tools } });
        if (rpc.method === "resources/read") {
          resourceReadSessions.push(headers.get("mcp-session-id"));
          if (failResourceReads) return new Response("view unavailable", { status: 500 });
          if (expireNextResourceRead) {
            expireNextResourceRead = false;
            return new Response("session expired", { status: 404 });
          }
          return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { contents: [{
            uri: rpc.params.uri, mimeType: MCP_APP_MIME_TYPE, text: VIEW_HTML,
            _meta: { ui: { csp: { resourceDomains: ["https://cdn.circleback.ai"] }, prefersBorder: true } },
          }] } });
        }
        if (rpc.method === "tools/call") {
          return Response.json({ jsonrpc: "2.0", id: rpc.id, result: {
            content: [{ type: "text", text: `${rpc.params.name} done` }],
            structuredContent: { tool: rpc.params.name, meetings: [{ id: "m1", name: "Paperclip <> Heavybit" }] },
            _meta: { "circleback/cards": [{ id: "m1" }] },
          } });
        }
      }
      if (url.includes("oauth-protected-resource")) return Response.json({ resource: endpoint, authorization_servers: [origin], scopes_supported: ["user", "user:write"] });
      if (url === `${origin}/.well-known/oauth-authorization-server`) return Response.json({
        issuer: origin, authorization_endpoint: `${origin}/api/oauth/authorize`, token_endpoint: `${origin}/api/oauth/access-token`,
        registration_endpoint: `${origin}/api/oauth/register`, code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"], scopes_supported: ["user", "user:write"],
      });
      if (url === `${origin}/api/oauth/register`) return Response.json({ ...JSON.parse(body), client_id: "circleback-fixture-client" });
      if (url === `${origin}/api/oauth/access-token`) {
        authorized = true;
        return Response.json({ access_token: accessToken, refresh_token: `r-${randomUUID()}`, expires_in: 3600, token_type: "Bearer", scope: "user user:write" });
      }
      return new Response(null, { status: 404 });
    });
    const service = toolAccessService(db, { remoteHttpRequest: request, remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }] });
    const connected = await service.connectGalleryApp(company.id, { galleryKey: "circleback", connectionMethodKey: "mcp-oauth", ...(options.personal ? { grantKind: "user" as const } : {}) }, actor);
    const start = await service.startOAuth(company.id, connected.connectionId, { redirectUri, actor });
    const authorization = new URL(start.authorizationUrl);
    expect(start.registrationSource).toBe("dcr");
    const signedIn = await service.completeOAuthCallback({ state: authorization.searchParams.get("state")!, code: "fixture-code", iss: origin, redirectUri, actor });
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Meeting analyst", role: "engineer", adapterType: "process" }).returning();
    const [otherAgent] = await db.insert(agents).values({ companyId: company.id, name: "Second analyst", role: "engineer", adapterType: "process" }).returning();
    await service.finishGalleryAppConnection(company.id, signedIn.connectionId, { enabledCatalogEntryIds: signedIn.catalog.map(entry => entry.id), askFirstCatalogEntryIds: [], access: { agentIds: [agent.id, otherAgent.id] } }, actor);
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Recap the partner meeting", assigneeAgentId: agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id,
      scopeKind: "issue", invocationSource: "on_demand", status: "running", responsibleUserId: actor.actorId, contextSnapshot: { issueId: issue.id } }).returning();
    const gateway = createToolGatewayService(db, { remoteHttpRequest: request, toolActionSigningSecret: "circleback-fixture-signing-key" });
    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id, issueId: issue.id });
    const app = express();
    app.use(express.json());
    let actorKind: "board" | "agent" | "teammate" = "board";
    app.use((req, _res, next) => {
      req.actor = actorKind !== "agent"
        ? { type: "board", userId: actorKind === "teammate" ? "circleback-teammate" : actor.actorId, source: "session", companyIds: [company.id],
          memberships: [{ companyId: company.id, status: "active", membershipRole: actorKind === "teammate" ? "member" : "admin" }] }
        : { type: "agent", companyId: company.id, agentId: agent.id, source: "agent_key" };
      next();
    });
    // Same order as app.ts: a view's tool calls are served by the tool-access router.
    app.use(toolAccessRoutes(db, { toolGateway: gateway, remoteHttpRequest: request, remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }] }));
    app.use(mcpAppsRoutes(db, gateway));
    app.use(errorHandler);
    return { company, agent, issue, run, gateway, session, request, app, initializeCapabilities, resourceReadSessions, connectionId: signedIn.connectionId,
      failResourceReads: (fail: boolean) => { failResourceReads = fail; },
      expireNextResourceRead: () => { expireNextResourceRead = true; },
      /** Holds the next initialize request; `entered` resolves once that request is being held. */
      holdNextInitialize: () => {
        let release!: () => void;
        let markEntered!: () => void;
        const entered = new Promise<void>((resolve) => { markEntered = resolve; });
        initializeGate = { wait: new Promise<void>((resolve) => { release = resolve; }), entered: markEntered };
        return { release, entered };
      },
      otherAgent,
      setActor: (kind: "board" | "agent" | "teammate") => { actorKind = kind; } };
  }

  it("keeps the view declaration, hides app-only tools from the agent, and records the call's view", async () => {
    const f = await fixture();
    // Paperclip only initializes stateful servers; when it does, it advertises MCP Apps.
    expect(f.initializeCapabilities.every((capabilities) => JSON.stringify(capabilities).includes(MCP_APPS_EXTENSION_ID))).toBe(true);
    const catalog = await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, f.connectionId));
    expect(catalog.find(entry => entry.toolName === "DisplayMeetings")?.uiMeta).toEqual({ resourceUri: VIEW_URI, visibility: ["model", "app"] });
    expect(catalog.find(entry => entry.toolName === "SearchMeetings")?.uiMeta).toBeNull();

    const listed = await f.gateway.listToolsForSession(f.session.token);
    const listedNames = listed.map(tool => tool.upstreamToolName);
    expect(listedNames).toEqual(expect.arrayContaining(["SearchMeetings", "DisplayMeetings", "DisplayCalendarEvents"]));
    expect(listedNames).not.toContain("RefreshMeetingCards");

    const display = listed.find(tool => tool.upstreamToolName === "DisplayMeetings")!;
    const result = await f.gateway.executeTool({ sessionToken: f.session.token, tool: display.name, parameters: { meetingIds: ["m1"] }, idempotencyKey: randomUUID() });
    expect(JSON.stringify(result)).toContain("DisplayMeetings done");
    // The provider `_meta` is for the view only; the agent never receives it.
    expect(JSON.stringify(result)).not.toContain("circleback/cards");
    // A call to a tool without a view records nothing.
    const search = listed.find(tool => tool.upstreamToolName === "SearchMeetings")!;
    await f.gateway.executeTool({ sessionToken: f.session.token, tool: search.name, parameters: {}, idempotencyKey: randomUUID() });

    const views = await db.select().from(toolMcpAppViews).where(eq(toolMcpAppViews.companyId, f.company.id));
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      issueId: f.issue.id, runId: f.run.id, agentId: f.agent.id, applicationName: "Circleback",
      toolName: display.name, upstreamToolName: "DisplayMeetings", resourceUri: VIEW_URI,
      toolInput: { meetingIds: ["m1"] },
      toolResult: {
        content: [{ type: "text", text: "DisplayMeetings done" }],
        structuredContent: { tool: "DisplayMeetings", meetings: [{ id: "m1", name: "Paperclip <> Heavybit" }] },
        _meta: { "circleback/cards": [{ id: "m1" }] },
      },
    });
  });

  it("serves the view to task readers and runs the view's tool calls with the viewer's authority", async () => {
    const f = await fixture();
    const listed = await f.gateway.listToolsForSession(f.session.token);
    const display = listed.find(tool => tool.upstreamToolName === "DisplayMeetings")!;
    await f.gateway.executeTool({ sessionToken: f.session.token, tool: display.name, parameters: { meetingIds: ["m1"] }, idempotencyKey: randomUUID() });

    const list = await http(f.app).get(`/issues/${f.issue.id}/mcp-app-views`).expect(200);
    expect(list.body).toHaveLength(1);
    const viewId = list.body[0].id as string;
    expect(list.body[0]).toMatchObject({ runId: f.run.id, upstreamToolName: "DisplayMeetings", toolInput: { meetingIds: ["m1"] } });

    const detail = await http(f.app).get(`/issues/${f.issue.id}/mcp-app-views/${viewId}`).expect(200);
    expect(detail.body.resource).toMatchObject({ uri: VIEW_URI, html: VIEW_HTML, prefersBorder: true, csp: { resourceDomains: ["https://cdn.circleback.ai"] } });
    expect(detail.body.toolResult.structuredContent.meetings[0].id).toBe("m1");

    const appCall = await http(f.app).post(`/issues/${f.issue.id}/mcp-app-views/${viewId}/tool-calls`)
      .send({ name: "RefreshMeetingCards", arguments: { meetingIds: ["m1"] } }).expect(200);
    expect(appCall.body).toMatchObject({
      content: [{ type: "text", text: "RefreshMeetingCards done" }],
      structuredContent: { tool: "RefreshMeetingCards" },
      // The view's own calls keep the provider `_meta` the cards need.
      _meta: { "circleback/cards": [{ id: "m1" }] },
    });

    // Task-scoped rules apply to a view's tool calls: Ask first holds the call.
    const [askFirst] = await db.insert(toolPolicies).values({ companyId: f.company.id, name: "Ask first on this task", policyType: "require_approval", priority: 1, selectors: { issueId: f.issue.id } }).returning();
    const held = await http(f.app).post(`/issues/${f.issue.id}/mcp-app-views/${viewId}/tool-calls`)
      .send({ name: "RefreshMeetingCards", arguments: { meetingIds: ["m1"] } }).expect(200);
    expect(held.body).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining("needs approval") }] });
    // Approving the held app-only call runs it, with the task still attached.
    const [pending] = await db.select().from(toolActionRequests)
      .where(and(eq(toolActionRequests.companyId, f.company.id), eq(toolActionRequests.status, "pending")));
    expect(pending).toBeTruthy();
    if (pending.approvalId) await db.update(approvals).set({ status: "approved", decidedByUserId: actor.actorId, decidedAt: new Date() }).where(eq(approvals.id, pending.approvalId));
    const refreshCalls = () => f.request.mock.calls.filter(([, init]) => String(init.body).includes('"name":"RefreshMeetingCards"')).length;
    const callsBefore = refreshCalls();
    await f.gateway.approveActionRequest({ companyId: f.company.id, actionRequestId: pending.id, actor: { userId: actor.actorId } });
    expect(refreshCalls()).toBe(callsBefore + 1);
    const [approvedInvocation] = await db.select().from(toolInvocations).where(eq(toolInvocations.id, pending.invocationId));
    expect(approvedInvocation).toMatchObject({ status: "succeeded", issueId: f.issue.id });
    await db.delete(toolPolicies).where(eq(toolPolicies.id, askFirst.id));

    // A held view call whose tool loses app visibility before approval does not run.
    const [askFirstAgain] = await db.insert(toolPolicies).values({ companyId: f.company.id, name: "Ask first again", policyType: "require_approval", priority: 1, selectors: { issueId: f.issue.id } }).returning();
    await http(f.app).post(`/issues/${f.issue.id}/mcp-app-views/${viewId}/tool-calls`)
      .send({ name: "RefreshMeetingCards", arguments: { meetingIds: ["m2"] } }).expect(200);
    const [stillPending] = await db.select().from(toolActionRequests)
      .where(and(eq(toolActionRequests.companyId, f.company.id), eq(toolActionRequests.status, "pending")));
    if (stillPending.approvalId) await db.update(approvals).set({ status: "approved", decidedByUserId: actor.actorId, decidedAt: new Date() }).where(eq(approvals.id, stillPending.approvalId));
    await db.update(toolCatalogEntries).set({ uiMeta: { resourceUri: VIEW_URI, visibility: ["model"] } })
      .where(and(eq(toolCatalogEntries.connectionId, f.connectionId), eq(toolCatalogEntries.toolName, "RefreshMeetingCards")));
    const beforeRevokedApproval = refreshCalls();
    await f.gateway.approveActionRequest({ companyId: f.company.id, actionRequestId: stillPending.id, actor: { userId: actor.actorId } }).catch(() => undefined);
    expect(refreshCalls()).toBe(beforeRevokedApproval);
    await db.update(toolCatalogEntries).set({ uiMeta: { resourceUri: VIEW_URI, visibility: ["app"] } })
      .where(and(eq(toolCatalogEntries.connectionId, f.connectionId), eq(toolCatalogEntries.toolName, "RefreshMeetingCards")));
    await db.delete(toolPolicies).where(eq(toolPolicies.id, askFirstAgain.id));

    // A model-only tool is never callable from a view.
    await http(f.app).post(`/issues/${f.issue.id}/mcp-app-views/${viewId}/tool-calls`)
      .send({ name: "DisplayCalendarEvents", arguments: {} }).expect(404);

    // Another task cannot read this view, and agents cannot use the routes.
    const [otherIssue] = await db.insert(issues).values({ companyId: f.company.id, title: "Other task" }).returning();
    await http(f.app).get(`/issues/${otherIssue.id}/mcp-app-views/${viewId}`).expect(404);
    const [otherCompany] = await db.insert(companies).values({ name: "Other", issuePrefix: `OT${randomUUID().slice(0, 6)}` }).returning();
    const [foreignIssue] = await db.insert(issues).values({ companyId: otherCompany.id, title: "Foreign" }).returning();
    await http(f.app).get(`/issues/${foreignIssue.id}/mcp-app-views`).expect(404);
    f.setActor("agent");
    await http(f.app).get(`/issues/${f.issue.id}/mcp-app-views`).expect(403);

    // A company member who cannot open a private task cannot read its views.
    await db.insert(companyMemberships).values({ companyId: f.company.id, principalType: "user", principalId: "circleback-teammate", status: "active", membershipRole: "member" });
    f.setActor("teammate");
    await http(f.app).get(`/issues/${f.issue.id}/mcp-app-views`).expect(200);
    // A view's tool calls need what a connection test call needs. Reading the
    // task is not enough: the member also needs tool permission ...
    const callFromView = () => http(f.app).post(`/issues/${f.issue.id}/mcp-app-views/${viewId}/tool-calls`)
      .send({ name: "RefreshMeetingCards", arguments: {} });
    expect((await callFromView()).status).toBe(403);
    await db.insert(principalPermissionGrants).values({ companyId: f.company.id, principalType: "user", principalId: "circleback-teammate", permissionKey: "tools:use", grantedByUserId: actor.actorId });
    expect((await callFromView()).status).toBe(200);
    // ... and authority to act as the view's agent, which ends with the agent.
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, f.agent.id));
    expect((await callFromView()).status).toBe(403);
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.agent.id));
    await db.update(issues).set({ visibility: "private" }).where(eq(issues.id, f.issue.id));
    await http(f.app).get(`/issues/${f.issue.id}/mcp-app-views`).expect(404);
    await http(f.app).get(`/issues/${f.issue.id}/mcp-app-views/${viewId}`).expect(404);
  });

  it("reads view documents through an MCP session when the server requires one, without touching connection health", async () => {
    const f = await fixture({ requireSession: true });
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, f.connectionId));
    expect(connection.config).toMatchObject({ mcpSessionRequired: true });
    const listed = await f.gateway.listToolsForSession(f.session.token);
    const display = listed.find(tool => tool.upstreamToolName === "DisplayMeetings")!;
    await f.gateway.executeTool({ sessionToken: f.session.token, tool: display.name, parameters: { meetingIds: ["m1"] }, idempotencyKey: randomUUID() });
    const viewId = (await http(f.app).get(`/issues/${f.issue.id}/mcp-app-views`).expect(200)).body[0].id as string;
    const detail = await http(f.app).get(`/issues/${f.issue.id}/mcp-app-views/${viewId}`).expect(200);
    expect(detail.body.resource.html).toBe(VIEW_HTML);
    expect(f.resourceReadSessions.at(-1)).toMatch(/^fixture-session-/);

    const healthBefore = (await db.select().from(toolConnections).where(eq(toolConnections.id, f.connectionId)))[0]!.healthStatus;
    f.failResourceReads(true);
    await http(f.app).get(`/issues/${f.issue.id}/mcp-app-views/${viewId}`).expect(502);
    const healthAfter = (await db.select().from(toolConnections).where(eq(toolConnections.id, f.connectionId)))[0]!.healthStatus;
    expect(healthAfter).toBe(healthBefore);
  });

  it("retries an expired view read without interrupting another agent's session setup", async () => {
    const f = await fixture({ requireSession: true });
    const listed = await f.gateway.listToolsForSession(f.session.token);
    const display = listed.find(tool => tool.upstreamToolName === "DisplayMeetings")!;
    await f.gateway.executeTool({ sessionToken: f.session.token, tool: display.name, parameters: { meetingIds: ["m1"] }, idempotencyKey: randomUUID() });
    const viewId = (await http(f.app).get(`/issues/${f.issue.id}/mcp-app-views`).expect(200)).body[0].id as string;
    await http(f.app).get(`/issues/${f.issue.id}/mcp-app-views/${viewId}`).expect(200);

    // Another agent starts a tool call; its session setup is still in flight ...
    const [otherRun] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.otherAgent.id, issueId: f.issue.id,
      scopeKind: "issue", invocationSource: "on_demand", status: "running", contextSnapshot: { issueId: f.issue.id } }).returning();
    const otherSession = await f.gateway.createSession({ companyId: f.company.id, agentId: f.otherAgent.id, runId: otherRun.id, issueId: f.issue.id });
    const otherTool = (await f.gateway.listToolsForSession(otherSession.token)).find(tool => tool.upstreamToolName === "SearchMeetings")!;
    const held = f.holdNextInitialize();
    const otherCall = f.gateway.executeTool({ sessionToken: otherSession.token, tool: otherTool.name, parameters: {}, idempotencyKey: randomUUID() });
    await held.entered;

    // ... when the view read finds its session expired and starts a new one.
    f.expireNextResourceRead();
    await http(f.app).get(`/issues/${f.issue.id}/mcp-app-views/${viewId}`).expect(200);
    held.release();
    await expect(otherCall).resolves.toMatchObject({ status: "completed" });
  });

  it("reads a view's document only with the viewer's own access to the connection", async () => {
    // A personal connection of the user who connected it.
    const f = await fixture({ personal: true });
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, f.connectionId));
    expect(grant).toMatchObject({ kind: "user", subjectUserId: actor.actorId });
    const listed = await f.gateway.listToolsForSession(f.session.token);
    const display = listed.find(tool => tool.upstreamToolName === "DisplayMeetings")!;
    await f.gateway.executeTool({ sessionToken: f.session.token, tool: display.name, parameters: { meetingIds: ["m1"] }, idempotencyKey: randomUUID() });
    const viewId = (await http(f.app).get(`/issues/${f.issue.id}/mcp-app-views`).expect(200)).body[0].id as string;
    await http(f.app).get(`/issues/${f.issue.id}/mcp-app-views/${viewId}`).expect(200);

    // A teammate who can read the task sees that the view exists, but cannot
    // read its document through someone else's personal connection.
    await db.insert(companyMemberships).values({ companyId: f.company.id, principalType: "user", principalId: "circleback-teammate", status: "active", membershipRole: "member" });
    f.setActor("teammate");
    await http(f.app).get(`/issues/${f.issue.id}/mcp-app-views`).expect(200);
    const denied = await http(f.app).get(`/issues/${f.issue.id}/mcp-app-views/${viewId}`).expect(404);
    expect(denied.body).toMatchObject({ error: "View not found" });
  });
});
