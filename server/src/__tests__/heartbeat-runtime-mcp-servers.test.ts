import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  activityLog,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  toolAccessAuditEvents,
  toolApplications,
  toolConnectionInstalls,
  toolConnections,
  toolMcpGateways,
  toolMcpGatewayTokens,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  buildExactIssueManagedMcpServers,
  buildPaperclipRuntimeMcpServers,
  revokeHeartbeatRunGatewayTokens,
} from "../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("heartbeat runtime MCP servers", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const originalApiUrl = process.env.PAPERCLIP_API_URL;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-runtime-mcp-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    if (originalApiUrl === undefined) delete process.env.PAPERCLIP_API_URL;
    else process.env.PAPERCLIP_API_URL = originalApiUrl;
    await db.delete(toolMcpGatewayTokens);
    await db.delete(activityLog);
    await db.delete(toolAccessAuditEvents);
    await db.delete(heartbeatRuns);
    await db.delete(toolMcpGateways);
    await db.delete(toolConnectionInstalls);
    await db.delete(toolProfileBindings);
    await db.delete(toolProfileEntries);
    await db.delete(toolProfiles);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("provisions one gateway per installed connection and mints short-lived run tokens", async () => {
    process.env.PAPERCLIP_API_URL = "https://paperclip.example.test";
    const [company] = await db.insert(companies).values({
      name: `Runtime MCP ${randomUUID()}`,
      issuePrefix: `RM${randomUUID().slice(0, 5).toUpperCase()}`,
    }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: company!.id,
      name: "Runtime MCP Agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
    }).returning();
    const [application] = await db.insert(toolApplications).values({
      companyId: company!.id,
      applicationKey: `runtime-${randomUUID().slice(0, 8)}`,
      name: "Runtime MCP App",
      type: "mcp_http",
      status: "active",
    }).returning();
    const [installedConnection, uninstalledConnection] = await db.insert(toolConnections).values([
      {
        companyId: company!.id,
        applicationId: application!.id,
        name: "Installed MCP",
        uid: `test/${randomUUID()}`,
        transport: "mcp_remote",
        status: "active",
        enabled: true,
        config: { url: "https://installed.example.test/mcp" },
      },
      {
        companyId: company!.id,
        applicationId: application!.id,
        name: "Uninstalled MCP",
        uid: `test/${randomUUID()}`,
        transport: "mcp_remote",
        status: "active",
        enabled: true,
        config: { url: "https://uninstalled.example.test/mcp" },
      },
    ]).returning();
    const [profile] = await db.insert(toolProfiles).values({
      companyId: company!.id,
      profileKey: `app:${installedConnection!.id}`,
      name: "Installed MCP",
      defaultAction: "deny",
    }).returning();
    await db.insert(toolProfileEntries).values({
      companyId: company!.id,
      profileId: profile!.id,
      selectorType: "connection",
      effect: "include",
      applicationId: application!.id,
      connectionId: installedConnection!.id,
    });
    await db.insert(toolProfileBindings).values({
      companyId: company!.id,
      profileId: profile!.id,
      targetType: "agent",
      targetId: agent!.id,
    });
    await db.insert(toolConnectionInstalls).values({
      companyId: company!.id,
      connectionId: installedConnection!.id,
      targetType: "agent",
      targetId: agent!.id,
    });

    const before = Date.now();
    const first = await buildPaperclipRuntimeMcpServers({ db, agent: agent!, runId: randomUUID() });
    const second = await buildPaperclipRuntimeMcpServers({ db, agent: agent!, runId: randomUUID() });

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      name: "Installed MCP",
      connectionId: installedConnection!.id,
      url: expect.stringMatching(/^https:\/\/paperclip\.example\.test\/api\/tool-gateway\/gateways\/.+\/mcp$/),
      token: expect.stringMatching(/^pcgw_/),
    });
    expect(first.some((server) => server.connectionId === uninstalledConnection!.id)).toBe(false);
    expect(second).toHaveLength(1);

    const gateways = await db.select().from(toolMcpGateways);
    expect(gateways).toHaveLength(1);
    expect(gateways[0]!.metadata).toMatchObject({ managedRuntimeConnectionId: installedConnection!.id });
    const tokens = await db.select().from(toolMcpGatewayTokens);
    expect(tokens).toHaveLength(2);
    for (const token of tokens) {
      expect(token.subjectType).toBe("heartbeat_run");
      expect(token.subjectId).toMatch(/^[0-9a-f-]{36}$/);
      expect(token.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 59 * 60 * 1000);
      expect(token.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + 61 * 60 * 1000);
    }
    expect(JSON.stringify(tokens)).not.toContain(first[0]!.token);
  });

  it("audits permitted remote MCP connections that were not installed when delivery is empty", async () => {
    const [company] = await db.insert(companies).values({
      name: `Runtime MCP diagnostic ${randomUUID()}`,
      issuePrefix: `RD${randomUUID().slice(0, 5).toUpperCase()}`,
    }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: company!.id,
      name: "Runtime MCP Diagnostic Agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
    }).returning();
    const [application] = await db.insert(toolApplications).values({
      companyId: company!.id,
      applicationKey: `runtime-diagnostic-${randomUUID().slice(0, 8)}`,
      name: "Zapier",
      type: "mcp_http",
      status: "active",
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: company!.id,
      applicationId: application!.id,
      name: "Zapier",
      uid: `test/${randomUUID()}`,
      transport: "mcp_remote",
      status: "active",
      enabled: true,
      config: { url: "https://zapier.example.test/mcp" },
    }).returning();
    const [profile] = await db.insert(toolProfiles).values({
      companyId: company!.id,
      profileKey: `app:${connection!.id}`,
      name: "Zapier",
      defaultAction: "deny",
    }).returning();
    await db.insert(toolProfileEntries).values({
      companyId: company!.id,
      profileId: profile!.id,
      selectorType: "connection",
      effect: "include",
      applicationId: application!.id,
      connectionId: connection!.id,
    });
    await db.insert(toolProfileBindings).values({
      companyId: company!.id,
      profileId: profile!.id,
      targetType: "agent",
      targetId: agent!.id,
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: company!.id,
      agentId: agent!.id,
      status: "running",
      contextSnapshot: {},
    });

    const servers = await buildPaperclipRuntimeMcpServers({ db, agent: agent!, runId });

    expect(servers).toEqual([]);
    const [activity] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "tool_gateway.runtime_mcp_delivery"));
    expect(activity).toMatchObject({
      companyId: company!.id,
      agentId: agent!.id,
      runId,
      details: expect.objectContaining({
        reasonCode: "permitted_connections_not_installed",
        deliveredServerCount: 0,
        permittedNotInstalledCount: 1,
        permittedNotInstalledConnections: [{ id: connection!.id, name: "Zapier" }],
      }),
    });
    const [audit] = await db.select().from(toolAccessAuditEvents);
    expect(audit).toMatchObject({
      companyId: company!.id,
      actorType: "agent",
      actorId: agent!.id,
      reasonCode: "permitted_connections_not_installed",
      details: expect.objectContaining({ runId, deliveredServerCount: 0 }),
    });
  });

  it("selects only exact agent-and-issue gateways for OpenCode and revokes the run token", async () => {
    process.env.PAPERCLIP_API_URL = "https://paperclip.example.test";
    const [company] = await db.insert(companies).values({
      name: `Exact MCP ${randomUUID()}`,
      issuePrefix: `EX${randomUUID().slice(0, 5).toUpperCase()}`,
    }).returning();
    const [agent, otherAgent] = await db.insert(agents).values([
      {
        companyId: company!.id,
        name: "Exact OpenCode Agent",
        role: "engineer",
        adapterType: "opencode_local",
        adapterConfig: {},
      },
      {
        companyId: company!.id,
        name: "Other OpenCode Agent",
        role: "engineer",
        adapterType: "opencode_local",
        adapterConfig: {},
      },
    ]).returning();
    const [issue, otherIssue] = await db.insert(issues).values([
      { companyId: company!.id, title: "Exact issue", status: "todo" },
      { companyId: company!.id, title: "Other issue", status: "todo" },
    ]).returning();
    const [profile] = await db.insert(toolProfiles).values({
      companyId: company!.id,
      profileKey: `exact-${randomUUID()}`,
      name: "Exact managed profile",
      defaultAction: "deny",
    }).returning();
    const gateways = await db.insert(toolMcpGateways).values([
      {
        companyId: company!.id,
        profileId: profile!.id,
        name: "Exact gateway",
        slug: `exact-${randomUUID()}`,
        agentId: agent!.id,
        issueId: issue!.id,
      },
      {
        companyId: company!.id,
        profileId: profile!.id,
        name: "Unscoped gateway",
        slug: `unscoped-${randomUUID()}`,
      },
      {
        companyId: company!.id,
        profileId: profile!.id,
        name: "Agent-only gateway",
        slug: `agent-${randomUUID()}`,
        agentId: agent!.id,
      },
      {
        companyId: company!.id,
        profileId: profile!.id,
        name: "Issue-only gateway",
        slug: `issue-${randomUUID()}`,
        issueId: issue!.id,
      },
      {
        companyId: company!.id,
        profileId: profile!.id,
        name: "Other-issue gateway",
        slug: `other-issue-${randomUUID()}`,
        agentId: agent!.id,
        issueId: otherIssue!.id,
      },
      {
        companyId: company!.id,
        profileId: profile!.id,
        name: "Other-agent gateway",
        slug: `other-agent-${randomUUID()}`,
        agentId: otherAgent!.id,
        issueId: issue!.id,
      },
      {
        companyId: company!.id,
        profileId: profile!.id,
        name: "Mismatched context gateway",
        slug: `mismatched-context-${randomUUID()}`,
        agentId: agent!.id,
        issueId: issue!.id,
        contextScopeType: "issue",
        contextScopeId: otherIssue!.id,
      },
      {
        companyId: company!.id,
        profileId: profile!.id,
        name: "Routine-scoped gateway",
        slug: `routine-${randomUUID()}`,
        agentId: agent!.id,
        issueId: issue!.id,
        contextScopeType: "routine",
        contextScopeId: randomUUID(),
      },
      {
        companyId: company!.id,
        profileId: profile!.id,
        name: "Malformed issue-scoped gateway",
        slug: `malformed-${randomUUID()}`,
        agentId: agent!.id,
        issueId: issue!.id,
        contextScopeType: "issue",
        contextScopeId: null,
      },
    ]).returning();
    const exactGateway = gateways.find((gateway) => gateway.name === "Exact gateway");
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: company!.id,
      agentId: agent!.id,
      status: "running",
      contextSnapshot: { issueId: issue!.id },
    });
    const before = Date.now();

    const selection = await buildExactIssueManagedMcpServers({
      db,
      agent: agent!,
      runId,
      projectId: null,
      routineId: null,
      issueId: issue!.id,
    });

    expect(selection.exactIssueMode).toBe(true);
    expect(selection.servers).toEqual([
      expect.objectContaining({
        name: "Exact gateway",
        connectionId: exactGateway!.id,
        url: `https://paperclip.example.test/api/tool-gateway/gateways/${exactGateway!.id}/mcp`,
        token: expect.stringMatching(/^pcgw_/),
      }),
    ]);
    const [token] = await db.select().from(toolMcpGatewayTokens);
    expect(token).toMatchObject({
      gatewayId: exactGateway!.id,
      subjectType: "heartbeat_run",
      subjectId: runId,
      allowedActions: ["tools/list", "tools/call"],
      revokedAt: null,
    });
    expect(token!.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 59 * 60 * 1000);
    expect(token!.expiresAt!.getTime()).toBeLessThanOrEqual(before + 61 * 60 * 1000);
    expect(JSON.stringify(token)).not.toContain(selection.servers[0]!.token);

    await revokeHeartbeatRunGatewayTokens({ db, companyId: company!.id, runId });
    const [revoked] = await db.select().from(toolMcpGatewayTokens);
    expect(revoked!.revokedAt).toBeInstanceOf(Date);

    const emptyExactSelection = await buildExactIssueManagedMcpServers({
      db,
      agent: agent!,
      runId: randomUUID(),
      projectId: null,
      routineId: null,
      issueId: null,
    });
    expect(emptyExactSelection).toEqual({ exactIssueMode: true, servers: [] });
  });
});
