import express from "express";
import request from "supertest";
import { mcpGatewayProtocolRoutes } from "../routes/tool-gateway.js";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agents,
  activityLog,
  companies,
  companyMemberships,
  connectionGrants,
  createDb,
  heartbeatRuns,
  projects,
  issues,
  toolInvocations,
  toolActionRequests,
  issueThreadInteractions,
  toolAccessAuditEvents,
  toolApplications,
  toolConnectionInstalls,
  toolConnections,
  toolMcpGateways,
  toolMcpGatewayTokens,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
  toolRateLimitCounters,
  toolPolicies,
} from "@paperclipai/db";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildPaperclipRuntimeMcpServers } from "../services/heartbeat.js";
import { createToolGatewayService } from "../services/tool-gateway.js";

import { registerAssignedMcpGateway } from "../services/native-runtime/assigned-mcp-tools.js";
import type { PluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import { resolveNativeRuntimeMcpSnapshot } from "../services/native-runtime/runtime-context.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function pluginDispatcher(names: string[], onExecute: () => void = () => {}): PluginToolDispatcher {
  return {
    initialize: async () => {},
    teardown: () => {},
    listToolsForAgent: () => names.map((name) => ({
      name, displayName: name, description: "Read a status.", pluginId: "fixture",
      parametersSchema: { type: "object" },
    })),
    getTool: () => null,
    executeTool: async () => {
      onExecute();
      return { pluginId: "fixture", toolName: "read_status", result: { content: "ready" } };
    },
    registerPluginTools: () => {},
    unregisterPluginTools: () => {},
    toolCount: () => names.length,
    getRegistry: () => { throw new Error("unused"); },
  };
}

describeEmbeddedPostgres("heartbeat runtime plugin MCP servers", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const originalApiUrl = process.env.PAPERCLIP_API_URL;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-plugin-mcp-");
    db = createDb(tempDb.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  beforeEach(() => {
    registerAssignedMcpGateway(db, createToolGatewayService(db));
  });

  afterEach(async () => {
    if (originalApiUrl === undefined) delete process.env.PAPERCLIP_API_URL;
    else process.env.PAPERCLIP_API_URL = originalApiUrl;
    await db.delete(toolMcpGatewayTokens);
    await db.delete(activityLog);
    await db.delete(toolAccessAuditEvents);
    await db.delete(toolActionRequests);
    await db.delete(issueThreadInteractions);
    await db.delete(toolInvocations);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(toolMcpGateways);
    await db.delete(connectionGrants);
    await db.delete(toolConnectionInstalls);
    await db.delete(toolProfileBindings);
    await db.delete(toolProfileEntries);
    await db.delete(toolProfiles);
    await db.delete(toolRateLimitCounters);
    await db.delete(toolPolicies);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function pluginRun() {
    process.env.PAPERCLIP_API_URL = "https://paperclip.example.test";
    const [company] = await db.insert(companies).values({ name: "Plugin authorization", issuePrefix: "AUTH" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "Reader", role: "engineer", adapterType: "claude_local" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company!.id, title: "Read plugin status", status: "in_progress", workMode: "standard", assigneeAgentId: agent!.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company!.id, agentId: agent!.id, invocationSource: "assignment", status: "running", contextSnapshot: { issueId: issue!.id } }).returning();
    const name = "fixture:read_status";
    let calls = 0;
    const gateway = createToolGatewayService(db, { pluginToolDispatcher: pluginDispatcher([name], () => { calls += 1; }), toolActionSigningSecret: "plugin-authorization-test" });
    registerAssignedMcpGateway(db, gateway);
    return { company: company!, agent: agent!, issue: issue!, run: run!, name, gateway, calls: () => calls };
  }

  function gatewayPublicId(server: { url: string }) {
    return server.url.split("/").at(-1)!;
  }

  async function approvePluginActions() {
    const actions = await db.select().from(toolActionRequests);
    for (const action of actions) {
      await db.update(issueThreadInteractions).set({ status: "accepted", resolvedByUserId: "board-user", resolvedAt: new Date() })
        .where(eq(issueThreadInteractions.id, action.interactionId!));
      await db.update(toolActionRequests).set({ status: "approved", resolvedByUserId: "board-user", decidedAt: new Date(), resolvedAt: new Date() })
        .where(eq(toolActionRequests.id, action.id));
    }
    return actions;
  }

  it.each(["planning", "ask", "skill_test"] as const)("withholds plugin tools and rejects HTTP calls when the task changes to %s", async workMode => {
    const f = await pluginRun();
    await db.insert(toolPolicies).values({ companyId: f.company.id, name: "Allow plugin", policyType: "allow", selectors: { toolNames: [f.name] } });
    const [server] = await buildPaperclipRuntimeMcpServers({ db, agent: f.agent, runId: f.run.id });
    const locator = { gatewayPublicId: gatewayPublicId(server!), bearerToken: server!.token };
    expect((await f.gateway.listToolsForNamedGateway(locator)).map(tool => tool.name)).toEqual([f.name]);
    await db.update(issues).set({ workMode }).where(eq(issues.id, f.issue.id));
    expect((await resolveNativeRuntimeMcpSnapshot({ db, agent: f.agent, runId: f.run.id })).bindingId).toBeNull();
    expect(await buildPaperclipRuntimeMcpServers({ db, agent: f.agent, runId: f.run.id })).toEqual([]);
    expect(await f.gateway.listToolsForNamedGateway(locator)).toEqual([]);
    const app = express().use(express.json()).use(mcpGatewayProtocolRoutes(f.gateway));
    const invoke = () => request(app).post(new URL(server!.url).pathname)
      .set("Authorization", `Bearer ${server!.token}`)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: f.name, arguments: {} } });
    const denied = await invoke().expect(403);
    expect(denied.body.error.data.reasonCode).toBe("deny_policy_block");
    expect(f.calls()).toBe(0);
    await db.update(issues).set({ workMode: "standard" }).where(eq(issues.id, f.issue.id));
    await invoke().expect(200);
    expect(f.calls()).toBe(1);
  });

  it("reuses the plugin invocation's consumed rate slot after approval", async () => {
    const f = await pluginRun();
    await db.insert(toolPolicies).values([
      { companyId: f.company.id, name: "One call", policyType: "rate_limit", priority: 1, selectors: { toolNames: [f.name] }, config: { limit: 1, windowSeconds: 3600, keyBy: ["agent", "tool"] } },
      { companyId: f.company.id, name: "Review plugin", policyType: "require_approval", priority: 2, selectors: { toolNames: [f.name] } },
    ]);
    const [server] = await buildPaperclipRuntimeMcpServers({ db, agent: f.agent, runId: f.run.id });
    const call = { gatewayPublicId: gatewayPublicId(server!), sessionToken: server!.token, tool: f.name };
    await expect(f.gateway.executeTool({ ...call, parameters: { reviewed: true } })).rejects.toMatchObject({ reasonCode: "approval_required" });
    const [action] = await approvePluginActions();
    const counters = await db.select().from(toolRateLimitCounters);
    expect(counters).toMatchObject([{ limit: 1, remaining: 0 }]);
    await expect(f.gateway.executeTool({ ...call, approvedActionRequestId: action!.id })).resolves.toMatchObject({ status: "completed" });
    expect(f.calls()).toBe(1);
    expect(await db.select().from(toolRateLimitCounters)).toEqual(counters);
  });

  it.each(["added", "edited"] as const)("atomically charges a rate rule %s after concurrent plugin approvals", async change => {
    const f = await pluginRun();
    await db.insert(toolPolicies).values({ companyId: f.company.id, name: "Review plugin", policyType: "require_approval", priority: 2, selectors: { toolNames: [f.name] } });
    const [existingRate] = change === "edited" ? await db.insert(toolPolicies).values({
      companyId: f.company.id, name: "Other tool rate", policyType: "rate_limit", priority: 1,
      selectors: { toolNames: ["fixture:other"] }, config: { limit: 1, windowSeconds: 3600, keyBy: ["agent", "tool"] },
    }).returning() : [];
    const [server] = await buildPaperclipRuntimeMcpServers({ db, agent: f.agent, runId: f.run.id });
    const call = { gatewayPublicId: gatewayPublicId(server!), sessionToken: server!.token, tool: f.name };
    for (const item of [1, 2]) {
      await expect(f.gateway.executeTool({ ...call, parameters: { item } })).rejects.toMatchObject({ reasonCode: "approval_required" });
    }
    const actions = await approvePluginActions();
    expect(actions).toHaveLength(2);
    if (existingRate) {
      await db.update(toolPolicies).set({ selectors: { toolNames: [f.name] }, updatedAt: new Date() }).where(eq(toolPolicies.id, existingRate.id));
    } else {
      await db.insert(toolPolicies).values({ companyId: f.company.id, name: "New one-call rate", policyType: "rate_limit", priority: 1,
        selectors: { toolNames: [f.name] }, config: { limit: 1, windowSeconds: 3600, keyBy: ["agent", "tool"] } });
    }
    const results = await Promise.allSettled(actions.map(action => f.gateway.executeTool({ ...call, approvedActionRequestId: action.id })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected", reason: { status: 429, reasonCode: "rate_limited" } });
    expect(f.calls()).toBe(1);
    expect(await db.select().from(toolRateLimitCounters)).toMatchObject([{ limit: 1, remaining: 0 }]);
    const [waiting] = await db.select().from(toolActionRequests).where(eq(toolActionRequests.status, "approved"));
    expect(waiting).toBeDefined();
    const [invocation] = await db.select().from(toolInvocations).where(eq(toolInvocations.id, waiting!.invocationId));
    expect(invocation).toMatchObject({ status: "awaiting_approval", startedAt: null });
  });

  it("delivers only governed plugin tools without a remote connection and fences assignment changes", async () => {
    process.env.PAPERCLIP_API_URL = "https://paperclip.example.test";
    const [company] = await db.insert(companies).values({ name: "Plugin delivery", issuePrefix: "PLUG" }).returning();
    const [agent, otherAgent] = await db.insert(agents).values([
      { companyId: company!.id, name: "Reader", role: "engineer", adapterType: "claude_local" },
      { companyId: company!.id, name: "Other reader", role: "engineer", adapterType: "codex_local" },
    ]).returning();
    const [project] = await db.insert(projects).values({ companyId: company!.id, name: "Plugin project" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company!.id, projectId: project!.id, title: "Read status", status: "in_progress", assigneeAgentId: agent!.id }).returning();
    const [run, otherRun] = await db.insert(heartbeatRuns).values([
      { companyId: company!.id, agentId: agent!.id, invocationSource: "assignment", status: "running", contextSnapshot: { issueId: issue!.id, projectId: project!.id } },
      { companyId: company!.id, agentId: otherAgent!.id, invocationSource: "assignment", status: "running", contextSnapshot: {} },
    ]).returning();
    const names = ["fixture:read_status", "fixture:read_private", "fixture:read_blocked"];
    let dispatchCount = 0;
    const dispatcher = pluginDispatcher(names, () => { dispatchCount += 1; });
    const gateway = createToolGatewayService(db, { pluginToolDispatcher: dispatcher, toolActionSigningSecret: "plugin-delivery-test-secret" });
    registerAssignedMcpGateway(db, gateway);
    await db.insert(toolPolicies).values([
      { companyId: company!.id, name: "Reader grant", policyType: "allow", selectors: { agentIds: [agent!.id], toolNames: [names[0]!, names[2]!] } },
      { companyId: company!.id, name: "Other grant", policyType: "allow", selectors: { agentIds: [otherAgent!.id], toolNames: [names[1]!] } },
      { companyId: company!.id, name: "Explicit block", policyType: "block", priority: -100, selectors: { toolNames: [names[2]!] } },
    ]);
    const snapshot = await resolveNativeRuntimeMcpSnapshot({ db, agent: agent!, runId: run!.id });
    expect(snapshot.bindingId).not.toBeNull();
    const first = await buildPaperclipRuntimeMcpServers({ db, agent: agent!, runId: run!.id, expectedAssignmentDigest: snapshot.digest });
    expect(first).toHaveLength(1);
    const locator = { gatewayPublicId: gatewayPublicId(first[0]!), bearerToken: first[0]!.token };
    expect((await gateway.listToolsForNamedGateway(locator)).map((tool) => tool.name)).toEqual([names[0]]);
    await expect(gateway.executeTool({ gatewayPublicId: locator.gatewayPublicId, sessionToken: first[0]!.token, tool: names[0]!, parameters: {} })).resolves.toBeDefined();
    const [profile] = await db.select().from(toolProfiles);
    const entries = await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, profile!.id));
    expect(entries.map(({ selectorType, effect, toolName }) => ({ selectorType, effect, toolName }))).toEqual([
      { selectorType: "tool_name", effect: "include", toolName: names[0] },
    ]);
    expect(await db.select().from(toolConnections)).toEqual([]);
    const repeat = await buildPaperclipRuntimeMcpServers({ db, agent: agent!, runId: run!.id });
    expect(repeat[0]!.connectionId).toBe(first[0]!.connectionId);
    const other = await buildPaperclipRuntimeMcpServers({ db, agent: otherAgent!, runId: otherRun!.id });
    expect(other[0]!.connectionId).not.toBe(first[0]!.connectionId);

    await db.update(toolPolicies).set({ selectors: { agentIds: [agent!.id], toolNames: [names[1]!] } })
      .where(eq(toolPolicies.name, "Reader grant"));
    expect(await gateway.listToolsForNamedGateway(locator)).toEqual([]);
    for (const tool of [names[0]!, names[1]!]) {
      await expect(gateway.executeTool({ gatewayPublicId: locator.gatewayPublicId, sessionToken: first[0]!.token, tool, parameters: {} }))
        .rejects.toMatchObject({ reasonCode: "deny_default" });
    }
    expect(await buildPaperclipRuntimeMcpServers({
      db, agent: agent!, runId: run!.id,
      expectedAssignmentDigest: first[0]!.connectionId.slice("assignment:".length),
    })).toEqual([]);
    const changed = await buildPaperclipRuntimeMcpServers({ db, agent: agent!, runId: run!.id });
    expect(changed[0]!.connectionId).not.toBe(first[0]!.connectionId);
    await db.delete(toolPolicies);
    expect(await buildPaperclipRuntimeMcpServers({ db, agent: agent!, runId: run!.id })).toEqual([]);

    const [sourceProfile] = await db.insert(toolProfiles).values({ companyId: company!.id, profileKey: "reader", name: "Reader", defaultAction: "deny" }).returning();
    await db.insert(toolProfileEntries).values({ companyId: company!.id, profileId: sourceProfile!.id, selectorType: "tool_name", effect: "include", toolName: names[0]! });
    await db.insert(toolProfileBindings).values({ companyId: company!.id, profileId: sourceProfile!.id, targetType: "agent", targetId: agent!.id });
    const [profileMcp] = await buildPaperclipRuntimeMcpServers({ db, agent: agent!, runId: run!.id });
    const profileLocator = { gatewayPublicId: gatewayPublicId(profileMcp!), bearerToken: profileMcp!.token };
    expect((await gateway.listToolsForNamedGateway(profileLocator)).map((tool) => tool.name)).toEqual([names[0]]);
    await db.insert(toolPolicies).values({ companyId: company!.id, name: "Review plugin call", policyType: "require_approval", selectors: { toolNames: [names[0]!] } });
    await expect(gateway.executeTool({ gatewayPublicId: profileLocator.gatewayPublicId, sessionToken: profileMcp!.token, tool: names[0]!, parameters: { reviewed: true } }))
      .rejects.toMatchObject({ reasonCode: "approval_required" });
    const [actionRequest] = await approvePluginActions();
    await db.delete(toolPolicies);
    await db.delete(toolProfileBindings).where(eq(toolProfileBindings.profileId, sourceProfile!.id));
    expect(await gateway.listToolsForNamedGateway(profileLocator)).toEqual([]);
    await expect(gateway.executeTool({ gatewayPublicId: profileLocator.gatewayPublicId, sessionToken: profileMcp!.token, tool: names[0]!, parameters: {} }))
      .rejects.toMatchObject({ reasonCode: "deny_default" });
    const callsBeforeRetry = dispatchCount;
    await expect(gateway.executeTool({ gatewayPublicId: profileLocator.gatewayPublicId, sessionToken: profileMcp!.token, tool: names[0]!, parameters: {}, approvedActionRequestId: actionRequest!.id }))
      .rejects.toMatchObject({ reasonCode: "deny_default" });
    expect(dispatchCount).toBe(callsBeforeRetry);
    expect((await db.select().from(toolActionRequests))[0]!.status).toBe("approved");
    await db.insert(toolProfileBindings).values({ companyId: company!.id, profileId: sourceProfile!.id, targetType: "agent", targetId: agent!.id });
    await db.update(toolProfileEntries).set({ toolName: names[1]! }).where(eq(toolProfileEntries.profileId, sourceProfile!.id));
    const [differentAssignment] = await buildPaperclipRuntimeMcpServers({ db, agent: agent!, runId: run!.id });
    await db.update(toolProfileEntries).set({ toolName: names[0]! }).where(eq(toolProfileEntries.profileId, sourceProfile!.id));
    await expect(gateway.executeTool({ gatewayPublicId: gatewayPublicId(differentAssignment!), sessionToken: differentAssignment!.token, tool: names[0]!, parameters: {}, approvedActionRequestId: actionRequest!.id }))
      .rejects.toMatchObject({ reasonCode: "deny_default" });
    expect(dispatchCount).toBe(callsBeforeRetry);
    await db.insert(toolPolicies).values({ companyId: company!.id, name: "Review plugin retry", policyType: "require_approval", selectors: { toolNames: [names[0]!] } });
    await expect(gateway.executeTool({ gatewayPublicId: profileLocator.gatewayPublicId, sessionToken: profileMcp!.token, tool: names[0]!, parameters: {}, approvedActionRequestId: actionRequest!.id })).resolves.toBeDefined();
    expect(dispatchCount).toBe(callsBeforeRetry + 1);
  });

  it("delivers a plugin tool granted only for the run's project", async () => {
    process.env.PAPERCLIP_API_URL = "https://paperclip.example.test";
    const [company] = await db.insert(companies).values({ name: "Scoped plugin delivery", issuePrefix: "SCOP" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "Reader", role: "engineer", adapterType: "claude_local" }).returning();
    const [grantedProject, otherProject] = await db.insert(projects).values([
      { companyId: company!.id, name: "Granted project" },
      { companyId: company!.id, name: "Other project" },
    ]).returning();
    const [issue] = await db.insert(issues).values({ companyId: company!.id, projectId: grantedProject!.id, title: "Read status", status: "in_progress", assigneeAgentId: agent!.id }).returning();
    const [grantedRun, otherRun] = await db.insert(heartbeatRuns).values([
      { companyId: company!.id, agentId: agent!.id, invocationSource: "assignment", status: "running", contextSnapshot: { issueId: issue!.id } },
      { companyId: company!.id, agentId: agent!.id, invocationSource: "assignment", status: "running", contextSnapshot: { projectId: otherProject!.id } },
    ]).returning();
    const name = "fixture:read_status";
    const gateway = createToolGatewayService(db, { pluginToolDispatcher: pluginDispatcher([name]) });
    registerAssignedMcpGateway(db, gateway);
    await db.insert(toolPolicies).values({ companyId: company!.id, name: "Project grant", policyType: "allow", selectors: { agentIds: [agent!.id], projectIds: [grantedProject!.id], toolNames: [name] } });

    const snapshot = await resolveNativeRuntimeMcpSnapshot({ db, agent: agent!, runId: grantedRun!.id });
    expect(snapshot.bindingId).not.toBeNull();
    const [server] = await buildPaperclipRuntimeMcpServers({ db, agent: agent!, runId: grantedRun!.id, expectedAssignmentDigest: snapshot.digest });
    const locator = { gatewayPublicId: gatewayPublicId(server!), bearerToken: server!.token };
    expect((await gateway.listToolsForNamedGateway(locator)).map((tool) => tool.name)).toEqual([name]);
    await expect(gateway.executeTool({ gatewayPublicId: locator.gatewayPublicId, sessionToken: server!.token, tool: name, parameters: {} })).resolves.toBeDefined();

    expect((await resolveNativeRuntimeMcpSnapshot({ db, agent: agent!, runId: otherRun!.id })).bindingId).toBeNull();
    expect(await buildPaperclipRuntimeMcpServers({ db, agent: agent!, runId: otherRun!.id })).toEqual([]);
  });

});
