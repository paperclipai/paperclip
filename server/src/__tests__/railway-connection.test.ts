import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, approvals, companies, companyMemberships, companySecrets, connectionGrants, createDb, heartbeatRuns, issues, toolCatalogEntries, toolActionRequests, toolConnections, toolPolicies, toolProfileBindings, toolProfiles, toolAccessAuditEvents } from "@paperclipai/db";
import { toolAccessService } from "../services/tool-access.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { RAILWAY_API_URL, RAILWAY_MCP_URL, RAILWAY_QUERIES } from "../services/railway.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { deploymentData, railwayAuthorizationMetadata, railwayResourceMetadata, target, targetData } from "./fixtures/railway/provider.js";
const support = await getEmbeddedPostgresTestSupport();
const actor = { actorType: "user" as const, actorId: "railway-reviewer" };
const redirectUri = "http://localhost:3100/api/tools/oauth/callback";
const token = "railway-fixture-opaque-access-token";
const initialTools = [
  { name: "list-projects", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "redeploy", inputSchema: { type: "object", properties: { deploymentId: { type: "string" } } }, annotations: { readOnlyHint: true } },
  { name: "railway-agent", annotations: { readOnlyHint: true } },
  { name: "accept-deploy", annotations: { readOnlyHint: true } },
];

(support.supported ? describe : describe.skip)("Railway connection lifecycle and gateway", () => {
  let db: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("paperclip-railway-"); db = createDb(temp.connectionString); }, 20000);
  afterAll(async () => { await temp?.cleanup(); });

  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "Railway fixture", issuePrefix: `RW${randomUUID().slice(0, 6)}` }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: actor.actorId, status: "active", membershipRole: "admin" });
    let tools: unknown[] = [...initialTools];
    let apiStatus = 200;
    let tokenStatus = 200;
    const request = vi.fn(async (url: string, init: RequestInit) => {
      const body = init.body ? String(init.body) : "";
      if (url === RAILWAY_API_URL) {
        if (apiStatus !== 200) return new Response("private provider error", { status: apiStatus });
        const { query, variables } = JSON.parse(body);
        // Workspace-scoped OAuth rejects account-wide projects even with HTTP 200.
        if (query === RAILWAY_QUERIES.projects && !variables?.workspaceId) return Response.json({ errors: [{ message: "Not Authorized", extensions: { code: "INTERNAL_SERVER_ERROR" } }], data: null });
        return Response.json({ data: query === RAILWAY_QUERIES.target ? targetData : query === RAILWAY_QUERIES.deployment ? deploymentData : query === RAILWAY_QUERIES.restart ? { deploymentRestart: true } : { projects: { edges: [] } } });
      }
      if (url.replace(/\/$/, "") === RAILWAY_MCP_URL && init.method === "POST") {
        if (new Headers(init.headers).get("authorization") !== `Bearer ${token}`) return new Response("", { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.railway.com/.well-known/oauth-protected-resource"' } });
        if (JSON.parse(body).method === "tools/call") {
          expect(JSON.parse(body).params).toEqual({ name: "list-workspaces", arguments: {} });
          return Response.json({ jsonrpc: "2.0", id: "paperclip-railway-workspace-probe", result: { structuredContent: { workspaces: [{ id: target.projectId }] } } });
        }
        return Response.json({ jsonrpc: "2.0", id: "paperclip-catalog-refresh", result: { tools } });
      }
      if (url.includes("oauth-protected-resource")) return Response.json(railwayResourceMetadata);
      if (url.includes("oauth-authorization-server")) return Response.json(railwayAuthorizationMetadata);
      if (url === railwayAuthorizationMetadata.registration_endpoint) return Response.json({ ...JSON.parse(body), client_id: "railway-fixture-client" });
      if (url === railwayAuthorizationMetadata.token_endpoint) return tokenStatus === 200 ? Response.json({ access_token: token, refresh_token: "railway-fixture-refresh", expires_in: 3600, token_type: "Bearer" }) : Response.json({ error: "invalid_grant", error_description: "private provider message" }, { status: tokenStatus });
      return new Response("", { status: 404 });
    });
    const service = toolAccessService(db, { remoteHttpRequest: request, remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }] });
    const connection = await service.connectGalleryApp(company.id, { galleryKey: "railway", methodKey: "mcp-oauth", name: "Railway" }, actor);
    const start = await service.startOAuth(company.id, connection.connectionId, { redirectUri, actor });
    const url = new URL(start.authorizationUrl);
    expect(start.registrationSource).toBe("dcr");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")).toContain("offline_access");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("resource")).toBe(RAILWAY_MCP_URL);
    await service.completeOAuthCallback({ state: url.searchParams.get("state")!, code: "fixture-code", iss: railwayAuthorizationMetadata.issuer, redirectUri, actor });
    return { company, service, connectionId: connection.connectionId, request, setTools: (next: unknown[]) => { tools = next; }, setApiStatus: (next: number) => { apiStatus = next; }, setTokenStatus: (next: number) => { tokenStatus = next; } };
  }

  it("discovers direct tools, blocks opaque actions and quarantines changed tools even on reconnect", async () => {
    const f = await fixture();
    const rows = await f.service.listCatalog(f.connectionId);
    expect((await f.service.getConnection(f.connectionId))?.config?.railwayApiStatus).toBe("available");
    expect(rows.find((r) => r.toolName === "paperclip-railway-read-logs")?.status).toBe("active");
    expect(rows.find((r) => r.toolName === "redeploy")?.riskLevel).toBe("destructive");
    expect(rows.filter((r) => ["railway-agent", "accept-deploy"].includes(r.toolName)).every((r) => r.status === "disabled")).toBe(true);
    f.setTools([...initialTools.map((tool) => tool.name === "list-projects" ? { ...tool, inputSchema: { type: "object", properties: { changed: { type: "string" } } } } : tool), { name: "new-tool" }]);
    await f.service.refreshCatalog(f.connectionId, actor);
    const changed = await f.service.listCatalog(f.connectionId);
    expect(changed.find((r) => r.toolName === "list-projects")?.status).toBe("quarantined");
    expect(changed.find((r) => r.toolName === "new-tool")?.status).toBe("quarantined");
    const start = await f.service.startOAuth(f.company.id, f.connectionId, { redirectUri, actor });
    await f.service.completeOAuthCallback({ state: new URL(start.authorizationUrl).searchParams.get("state")!, code: "reconnect-code", iss: railwayAuthorizationMetadata.issuer, redirectUri, actor });
    const after = await f.service.listCatalog(f.connectionId);
    expect(after.find((r) => r.toolName === "new-tool")?.status).toBe("quarantined");
    expect(JSON.stringify(await f.service.getConnection(f.connectionId))).not.toContain(token);
    f.setTools([{ name: "paperclip_railway_restart" }]);
    await expect(f.service.refreshCatalog(f.connectionId, actor)).rejects.toThrow("Railway advertised a reserved Paperclip action");
  });

  it("keeps direct operations unavailable when API acceptance fails and reports refresh failure safely", async () => {
    const f = await fixture();
    f.setApiStatus(403);
    await f.service.refreshCatalog(f.connectionId, actor);
    expect((await f.service.getConnection(f.connectionId))?.config?.railwayApiStatus).toBe("unavailable");
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, f.connectionId));
    f.setTokenStatus(400);
    let failure: unknown;
    try { await f.service.refreshOAuthGrantCredentials({ companyId: f.company.id, connectionId: f.connectionId, grantId: grant.id, forceRefresh: true, actor }); }
    catch (error) { failure = error; }
    expect(failure).toBeTruthy();
    expect(String(failure)).not.toContain("private provider message");
    expect(JSON.stringify(await f.service.getConnection(f.connectionId))).not.toContain(token);
  });

  it("denies retired source-deployment entries before refresh and disables them on refresh", async () => {
    const f = await fixture();
    const [agent] = await db.insert(agents).values({ companyId: f.company.id, name: "Railway operator", role: "engineer", adapterType: "process", adapterConfig: {} }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: agent.id, invocationSource: "on_demand", status: "running" }).returning();
    const [profile] = await db.insert(toolProfiles).values({ companyId: f.company.id, name: "Railway tools", profileKey: randomUUID(), defaultAction: "allow" }).returning();
    await db.insert(toolProfileBindings).values({ companyId: f.company.id, profileId: profile.id, targetType: "agent", targetId: agent.id });
    const [existing] = await db.select().from(toolCatalogEntries).where(and(eq(toolCatalogEntries.connectionId, f.connectionId), eq(toolCatalogEntries.toolName, "paperclip-railway-restart")));
    const names = ["paperclip-railway-deploy-revision", "paperclip_railway_deploy_revision", "paperclipRailwayDeployRevision"];
    // Reproduce active catalog rows persisted by an older server, before refresh.
    await db.insert(toolCatalogEntries).values(names.map((name) => ({ ...existing, id: randomUUID(), name, toolName: name, inputSchema: { type: "object" } })));
    const gateway = createToolGatewayService(db, { remoteHttpRequest: f.request });
    const session = await gateway.createSession({ companyId: f.company.id, agentId: agent.id, runId: run.id });
    const listed = await gateway.listToolsForSession(session.token);
    expect(listed.some((tool) => names.includes(tool.upstreamToolName ?? ""))).toBe(false);
    const restart = listed.find((tool) => tool.upstreamToolName === "paperclip-railway-restart")!;
    expect(restart).toBeTruthy();
    f.request.mockClear();
    const { deploymentId: _, ...ids } = target;
    const parameters = { ...ids, repository: "example/app", commitSha: "a".repeat(40) };
    await expect(gateway.executeTool({ sessionToken: session.token, tool: restart.name.replace("paperclip-railway-restart", names[0]), parameters, idempotencyKey: randomUUID() })).rejects.toMatchObject({ reasonCode: "tool_not_found" });
    for (const toolName of names) {
      await expect(gateway.executeTestCall({ companyId: f.company.id, connectionId: f.connectionId, agentId: agent.id, userId: actor.actorId, toolName, parameters })).rejects.toMatchObject({ reasonCode: "tool_not_found" });
    }
    expect(f.request).not.toHaveBeenCalled();
    await f.service.refreshCatalog(f.connectionId, actor);
    const retired = (await f.service.listCatalog(f.connectionId)).filter((entry) => names.includes(entry.toolName));
    expect(retired).toHaveLength(names.length);
    expect(retired.every((entry) => entry.status === "disabled")).toBe(true);
  });

  it("preserves the dedicated SSH grant key on reconnect and removes it while disconnected", async () => {
    const f = await fixture();
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, f.connectionId));
    const setup = await f.service.configureRailwaySsh(f.connectionId, f.company.id, { action: "prepare", grantId: grant.id }, actor);
    expect(setup?.publicKey).toMatch(/^ssh-ed25519 /);
    const [keyGrant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id));
    const ref = keyGrant.credentialSecretRefs.find((r) => r.configPath === "railway.ssh_private_key")!;
    expect(ref).toBeTruthy();
    const start = await f.service.startOAuth(f.company.id, f.connectionId, { redirectUri, actor });
    await f.service.completeOAuthCallback({ state: new URL(start.authorizationUrl).searchParams.get("state")!, code: "reconnect", iss: railwayAuthorizationMetadata.issuer, redirectUri, actor });
    const [reconnected] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id));
    expect(reconnected.credentialSecretRefs).toContainEqual(ref);
    await f.service.revokeConnectionGrant(f.connectionId, grant.id, actor);
    await db.update(toolConnections).set({ status: "disabled" }).where(eq(toolConnections.id, f.connectionId));
    await f.service.configureRailwaySsh(f.connectionId, f.company.id, { action: "remove", grantId: grant.id }, actor);
    expect(await db.select().from(companySecrets).where(eq(companySecrets.id, ref.secretId))).toHaveLength(0);
    expect((await f.service.getConnection(f.connectionId))?.config?.railwaySsh).toBeNull();
  });

  it("enforces policy, grant, run and company boundaries before API execution", async () => {
    const f = await fixture();
    const [agent] = await db.insert(agents).values({ companyId: f.company.id, name: "Railway operator", role: "engineer", adapterType: "process", adapterConfig: {} }).returning();
    const [issue] = await db.insert(issues).values({ companyId: f.company.id, title: "Railway proof", assigneeAgentId: agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: agent.id, invocationSource: "on_demand", status: "running", contextSnapshot: { issueId: issue.id } }).returning();
    const [profile] = await db.insert(toolProfiles).values({ companyId: f.company.id, name: "Railway tools", profileKey: randomUUID(), defaultAction: "allow" }).returning();
    await db.insert(toolProfileBindings).values({ companyId: f.company.id, profileId: profile.id, targetType: "agent", targetId: agent.id });
    const gateway = createToolGatewayService(db, { remoteHttpRequest: f.request, toolActionSigningSecret: "railway-fixture-signing-key" });
    let session = await gateway.createSession({ companyId: f.company.id, agentId: agent.id, runId: run.id });
    const tool = (await gateway.listToolsForSession(session.token)).find((r) => r.upstreamToolName === "paperclip-railway-restart")!;
    expect(tool).toBeTruthy();
    const [policy] = await db.insert(toolPolicies).values({ companyId: f.company.id, name: "Approve Railway restart", policyType: "require_approval", selectors: { connectionId: f.connectionId }, priority: 10 }).returning();
    f.request.mockClear();
    await expect(gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: target, idempotencyKey: randomUUID() })).rejects.toMatchObject({ reasonCode: "approval_required" });
    expect(f.request).not.toHaveBeenCalled();
    const [pending] = await db.select().from(toolActionRequests).where(eq(toolActionRequests.companyId, f.company.id));
    await gateway.declineActionRequest({ companyId: f.company.id, actionRequestId: pending.id, actor: { userId: actor.actorId } });
    expect(f.request).not.toHaveBeenCalled();
    await expect(gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: target, idempotencyKey: randomUUID() })).rejects.toMatchObject({ status: 409 });
    expect(f.request).not.toHaveBeenCalled();
    const [nextIssue] = await db.insert(issues).values({ companyId: f.company.id, title: "New Railway operation", assigneeAgentId: agent.id }).returning();
    const [nextRun] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: agent.id, invocationSource: "on_demand", status: "running", contextSnapshot: { issueId: nextIssue.id } }).returning();
    session = await gateway.createSession({ companyId: f.company.id, agentId: agent.id, runId: nextRun.id });
    await db.update(toolPolicies).set({ policyType: "block" }).where(eq(toolPolicies.id, policy.id));
    await expect(gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: target, idempotencyKey: randomUUID() })).rejects.toMatchObject({ status: 403 });
    expect(f.request).not.toHaveBeenCalled();
    await db.update(toolPolicies).set({ policyType: "require_approval" }).where(eq(toolPolicies.id, policy.id));
    await expect(gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: target, idempotencyKey: randomUUID() })).rejects.toMatchObject({ reasonCode: "approval_required" });
    const [approved] = await db.select().from(toolActionRequests).where(and(eq(toolActionRequests.companyId, f.company.id), eq(toolActionRequests.status, "pending")));
    if (approved.approvalId) await db.update(approvals).set({ status: "approved", decidedByUserId: actor.actorId, decidedAt: new Date() }).where(eq(approvals.id, approved.approvalId));
    await gateway.approveActionRequest({ companyId: f.company.id, actionRequestId: approved.id, actor: { userId: actor.actorId } });
    expect(f.request.mock.calls.some(([, init]) => JSON.parse(String(init.body)).query === RAILWAY_QUERIES.restart)).toBe(true);
    await db.delete(toolPolicies).where(eq(toolPolicies.id, policy.id));
    expect(f.request.mock.calls.filter(([, init]) => String(init.body).includes("mutation"))).toHaveLength(1);
    expect(JSON.stringify(await db.select().from(toolAccessAuditEvents).where(eq(toolAccessAuditEvents.companyId, f.company.id)))).not.toContain(token);
    f.request.mockClear();
    const [revokedGrant] = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, f.connectionId));
    await f.service.revokeConnectionGrant(f.connectionId, revokedGrant.id, actor);
    await expect(gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: { ...target, deploymentId: randomUUID() }, idempotencyKey: randomUUID() })).rejects.toMatchObject({ status: 409, reasonCode: "organization_authorization_required" });
    expect(f.request).not.toHaveBeenCalled();
    await expect(gateway.createSession({ companyId: randomUUID(), agentId: agent.id, runId: run.id })).rejects.toThrow();
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, nextRun.id));
    await expect(gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: target, idempotencyKey: randomUUID() })).rejects.toMatchObject({ status: 401, reasonCode: "session_run_inactive" });
  });
});
