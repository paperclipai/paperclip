import { randomUUID } from "node:crypto";
import express from "express";
import http from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, companies, companyMemberships, createDb, heartbeatRuns, issues, toolCatalogEntries, toolMcpAppViews,
} from "@paperclipai/db";
import { MCP_APP_MIME_TYPE, MCP_APPS_EXTENSION_ID } from "@paperclipai/shared";
import { errorHandler } from "../middleware/error-handler.js";
import { mcpAppsRoutes } from "../routes/mcp-apps.js";
import { toolAccessService, type McpToolDescriptor } from "../services/tool-access.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { mcpAppCallToolResult } from "../services/mcp-app-views.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const actor = { actorType: "user" as const, actorId: "circleback-reviewer" };
const redirectUri = "https://paperclip.fixture.test/api/tools/oauth/callback";
const VIEW_URI = "ui://circleback/meetings.html";
const VIEW_HTML = "<!doctype html><html><body><div id=cards>Meetings</div><script>/* view */</script></body></html>";

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

  async function fixture() {
    const origin = "https://circleback.ai";
    const endpoint = `${origin}/api/mcp`;
    const accessToken = `circleback-fixture-${randomUUID()}`;
    const [company] = await db.insert(companies).values({ name: "Circleback fixture", issuePrefix: `CB${randomUUID().slice(0, 6)}` }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: actor.actorId, status: "active", membershipRole: "admin" });
    let authorized = false;
    const initializeCapabilities: unknown[] = [];
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
          return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "Circleback fixture", version: "1" } } });
        }
        if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
        if (rpc.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { tools } });
        if (rpc.method === "resources/read") {
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
    const connected = await service.connectGalleryApp(company.id, { galleryKey: "circleback", connectionMethodKey: "mcp-oauth" }, actor);
    const start = await service.startOAuth(company.id, connected.connectionId, { redirectUri, actor });
    const authorization = new URL(start.authorizationUrl);
    expect(start.registrationSource).toBe("dcr");
    const signedIn = await service.completeOAuthCallback({ state: authorization.searchParams.get("state")!, code: "fixture-code", iss: origin, redirectUri, actor });
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Meeting analyst", role: "engineer", adapterType: "process" }).returning();
    await service.finishGalleryAppConnection(company.id, signedIn.connectionId, { enabledCatalogEntryIds: signedIn.catalog.map(entry => entry.id), askFirstCatalogEntryIds: [], access: { agentIds: [agent.id] } }, actor);
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
        ? { type: "board", userId: actorKind === "teammate" ? "circleback-teammate" : actor.actorId, source: "session", companyIds: [company.id] }
        : { type: "agent", companyId: company.id, agentId: agent.id, source: "agent_key" };
      next();
    });
    app.use(mcpAppsRoutes(db, gateway));
    app.use(errorHandler);
    return { company, agent, issue, run, gateway, session, request, app, initializeCapabilities, connectionId: signedIn.connectionId,
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
    await db.update(issues).set({ visibility: "private" }).where(eq(issues.id, f.issue.id));
    await http(f.app).get(`/issues/${f.issue.id}/mcp-app-views`).expect(404);
    await http(f.app).get(`/issues/${f.issue.id}/mcp-app-views/${viewId}`).expect(404);
  });
});
