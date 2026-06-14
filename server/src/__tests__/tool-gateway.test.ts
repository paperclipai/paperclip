import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import express from "express";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companySecretBindings,
  companySecrets,
  companySecretVersions,
  companyMemberships,
  companies,
  createDb,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
  principalPermissionGrants,
  projects,
  toolAccessAuditEvents,
  toolActionRequests,
  toolApplications,
  toolCatalogEntries,
  toolCallEvents,
  toolConnections,
  toolGatewaySessions,
  toolInvocations,
  toolPolicies,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
  toolRuntimeSlots,
  secretAccessEvents,
} from "@paperclipai/db";
import type { PluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import { toolGatewayRoutes } from "../routes/tool-gateway.js";
import { createToolGatewayService, ToolGatewayHttpError } from "../services/tool-gateway.js";
import { secretService } from "../services/secrets.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const testToolActionSigningSecret = "test-tool-action-signing-secret";

type Db = ReturnType<typeof createDb>;
type ToolGatewayServiceOptions = NonNullable<Parameters<typeof createToolGatewayService>[1]>;

async function createCompany(db: Db) {
  return db
    .insert(companies)
    .values({
      name: `Gateway ${randomUUID()}`,
      issuePrefix: `TG${randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createAgent(db: Db, companyId: string, permissions: Record<string, unknown> = {}) {
  return db
    .insert(agents)
    .values({
      companyId,
      name: `Agent ${randomUUID()}`,
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createIssueAndRun(db: Db, companyId: string, agentId: string) {
  const project = await db
    .insert(projects)
    .values({ companyId, name: `Project ${randomUUID()}` })
    .returning()
    .then((rows) => rows[0]!);
  const issue = await db
    .insert(issues)
    .values({
      companyId,
      projectId: project.id,
      title: `Gateway issue ${randomUUID()}`,
      status: "in_progress",
      assigneeAgentId: agentId,
    })
    .returning()
    .then((rows) => rows[0]!);
  const run = await db
    .insert(heartbeatRuns)
    .values({
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
      contextSnapshot: { issueId: issue.id, projectId: project.id },
    })
    .returning()
    .then((rows) => rows[0]!);
  return { project, issue, run };
}

async function allowToolsForAgent(db: Db, companyId: string, agentId: string, toolNames: string[]) {
  const profile = await db
    .insert(toolProfiles)
    .values({
      companyId,
      profileKey: `gateway-${randomUUID()}`,
      name: `Gateway profile ${randomUUID()}`,
      defaultAction: "deny",
    })
    .returning()
    .then((rows) => rows[0]!);
  await db.insert(toolProfileBindings).values({
    companyId,
    profileId: profile.id,
    targetType: "agent",
    targetId: agentId,
  });
  if (toolNames.length > 0) {
    await db.insert(toolProfileEntries).values(toolNames.map((toolName) => ({
      companyId,
      profileId: profile.id,
      selectorType: "tool_name" as const,
      effect: "include" as const,
      toolName,
    })));
  }
  return profile;
}

async function allowAllToolsForAgent(db: Db, companyId: string, agentId: string) {
  const profile = await db
    .insert(toolProfiles)
    .values({
      companyId,
      profileKey: `gateway-all-${randomUUID()}`,
      name: `Gateway all profile ${randomUUID()}`,
      defaultAction: "allow",
    })
    .returning()
    .then((rows) => rows[0]!);
  await db.insert(toolProfileBindings).values({
    companyId,
    profileId: profile.id,
    targetType: "agent",
    targetId: agentId,
  });
  return profile;
}

async function createRemoteMcpTool(
  db: Db,
  companyId: string,
  input: {
    applicationKey?: string | null;
    connectionName?: string;
    url?: string;
    toolName?: string;
    title?: string | null;
    connectionEnabled?: boolean;
    connectionStatus?: "draft" | "active" | "disabled" | "archived";
    healthStatus?: "unknown" | "healthy" | "degraded" | "failed" | "unchecked" | "ok" | "error" | "missing_secret";
    catalogStatus?: "active" | "disabled" | "quarantined" | "removed";
    quarantinedAt?: Date | null;
    credentialRefs?: typeof toolConnections.$inferInsert["credentialRefs"];
    credentialSecretRefs?: typeof toolConnections.$inferInsert["credentialSecretRefs"];
  } = {},
) {
  const applicationKey = input.applicationKey ?? `app-${randomUUID().slice(0, 8)}`;
  let application = await db
    .select()
    .from(toolApplications)
    .where(and(eq(toolApplications.companyId, companyId), eq(toolApplications.applicationKey, applicationKey)))
    .limit(1)
    .then((rows) => rows[0]);
  if (!application) {
    [application] = await db.insert(toolApplications).values({
      companyId,
      applicationKey,
      name: `Remote app ${randomUUID()}`,
      type: "mcp_http",
      status: "active",
    }).returning();
  }
  const [connection] = await db.insert(toolConnections).values({
    companyId,
    applicationId: application.id,
    name: input.connectionName ?? `Remote connection ${randomUUID()}`,
    transport: "remote_http",
    status: input.connectionStatus ?? "active",
    enabled: input.connectionEnabled ?? true,
    healthStatus: input.healthStatus ?? "ok",
    config: { url: input.url ?? "https://mcp.example.test/mcp" },
    transportConfig: { url: input.url ?? "https://mcp.example.test/mcp" },
    credentialRefs: input.credentialRefs ?? [],
    credentialSecretRefs: input.credentialSecretRefs ?? [],
  }).returning();
  if (input.credentialRefs?.length || input.credentialSecretRefs?.length) {
    await db.insert(companySecretBindings).values([
      ...(input.credentialRefs ?? []).map((ref) => ({
        companyId,
        secretId: ref.secretId,
        targetType: "tool_connection" as const,
        targetId: connection!.id,
        configPath: `credentials.${ref.name}`,
      })),
      ...(input.credentialSecretRefs ?? []).map((ref) => ({
        companyId,
        secretId: ref.secretId,
        targetType: "tool_connection" as const,
        targetId: connection!.id,
        configPath: ref.configPath,
        versionSelector: String(ref.versionSelector ?? "latest"),
        required: ref.required ?? true,
        label: ref.label ?? null,
      })),
    ]).onConflictDoNothing();
  }
  const toolName = input.toolName ?? "kv_set";
  const [catalogEntry] = await db.insert(toolCatalogEntries).values({
    companyId,
    applicationId: application.id,
    connectionId: connection!.id,
    entryKind: "tool",
    name: `${toolName}-${randomUUID()}`,
    toolName,
    title: input.title ?? "KV Set",
    description: `Call ${toolName}`,
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" }, value: { type: "string" } },
      required: ["key", "value"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    riskLevel: "write",
    isReadOnly: false,
    isWrite: true,
    isDestructive: false,
    status: input.catalogStatus ?? "active",
    versionHash: randomUUID(),
    quarantinedAt: input.quarantinedAt ?? null,
  }).returning();
  return { application, connection: connection!, catalogEntry: catalogEntry! };
}

function expectGatewayError(error: unknown, status: number, reasonCode: string) {
  expect(error).toBeInstanceOf(ToolGatewayHttpError);
  const gatewayError = error as ToolGatewayHttpError;
  expect(gatewayError.status).toBe(status);
  expect(gatewayError.reasonCode).toBe(reasonCode);
}

function tamperToken(token: string) {
  const replacement = token.endsWith("A") ? "B" : "A";
  return `${token.slice(0, -1)}${replacement}`;
}

function createTestToolGatewayService(db: Db, options: ToolGatewayServiceOptions = {}) {
  return createToolGatewayService(db, {
    ...options,
    toolActionSigningSecret: options.toolActionSigningSecret ?? testToolActionSigningSecret,
  });
}

function createGatewayRouteApp(
  db: Db,
  gateway = createTestToolGatewayService(db),
  actor?: Express.Request["actor"],
) {
  const app = express();
  app.use(express.json());
  if (actor) {
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
  }
  app.use("/api", toolGatewayRoutes(db, gateway));
  return app;
}

type FakeMcpRequest = {
  headers: IncomingMessage["headers"];
  body: Record<string, unknown> | null;
};

async function startFakeRemoteMcpServer(handler: (request: FakeMcpRequest) => Promise<{
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
  delayMs?: number;
}> | {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
  delayMs?: number;
}) {
  const requests: FakeMcpRequest[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> | null = null;
      try {
        body = raw ? JSON.parse(raw) as Record<string, unknown> : null;
      } catch {
        body = null;
      }
      const requestRecord = { headers: req.headers, body };
      requests.push(requestRecord);
      const response = await handler(requestRecord);
      if (response.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, response.delayMs));
      }
      res.statusCode = response.status ?? 200;
      for (const [key, value] of Object.entries(response.headers ?? {})) {
        res.setHeader(key, value);
      }
      if (response.rawBody !== undefined) {
        res.end(response.rawBody);
      } else {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(response.body ?? {
          jsonrpc: "2.0",
          id: body?.id ?? "test",
          result: { content: [{ type: "text", text: "ok" }] },
        }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP fake MCP server address");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

describeEmbeddedPostgres("tool gateway acceptance", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tool-gateway-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(toolCallEvents);
    await db.delete(toolRuntimeSlots);
    await db.delete(toolGatewaySessions);
    await db.delete(toolActionRequests);
    await db.delete(toolInvocations);
    await db.delete(toolAccessAuditEvents);
    await db.delete(toolPolicies);
    await db.delete(toolProfileEntries);
    await db.delete(toolProfileBindings);
    await db.delete(toolProfiles);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(issueThreadInteractions);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("hides and denies every external tool when an agent has no gateway profile", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { issue, run } = await createIssueAndRun(db, company.id, agent.id);
    const gateway = createTestToolGatewayService(db, { runtimeSupervisor: { idleTtlMs: 25 } });
    const session = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });

    await expect(gateway.listToolsForSession(session.token)).resolves.toEqual([]);
    await gateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-remote-fixture:echo",
      parameters: { message: "not allowed" },
    }).then(
      () => {
        throw new Error("Expected unauthorized tool call to fail");
      },
      (error) => expectGatewayError(error, 403, "deny_default"),
    );

    const [deniedAudit] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "tool_gateway.call_denied"));
    expect(deniedAudit).toMatchObject({
      companyId: company.id,
      entityType: "issue",
      entityId: issue.id,
      agentId: agent.id,
      runId: run.id,
    });
  });

  it("filters discovery, executes a remote HTTP fixture, and audits run and issue links", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { issue, run } = await createIssueAndRun(db, company.id, agent.id);
    await allowToolsForAgent(db, company.id, agent.id, [
      "mcp-remote-fixture:add",
      "mcp-stdio-fixture:increment_counter",
      "mcp-stdio-fixture:runtime_status",
    ]);
    const gateway = createTestToolGatewayService(db, { runtimeSupervisor: { idleTtlMs: 25 } });
    const session = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });

    const toolNames = (await gateway.listToolsForSession(session.token)).map((tool) => tool.name);
    expect(toolNames).toContain("mcp-remote-fixture:add");
    expect(toolNames).toContain("mcp-stdio-fixture:increment_counter");
    expect(toolNames).not.toContain("mcp-remote-fixture:echo");

    const result = await gateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-remote-fixture:add",
      parameters: { a: 4, b: 7 },
    });
    expect(result).toMatchObject({
      status: "completed",
      tool: "mcp-remote-fixture:add",
      result: {
        content: "11",
        data: {
          result: 11,
          transport: "mcp_http",
          spawnedLocalProcess: false,
        },
      },
    });

    const [invocation] = await db.select().from(toolInvocations);
    expect(invocation).toMatchObject({
      companyId: company.id,
      agentId: agent.id,
      issueId: issue.id,
      runId: run.id,
      toolName: "mcp-remote-fixture:add",
      status: "succeeded",
    });
    const [callEvent] = await db.select().from(toolCallEvents);
    expect(callEvent).toMatchObject({
      companyId: company.id,
      agentId: agent.id,
      issueId: issue.id,
      runId: run.id,
      toolName: "mcp-remote-fixture:add",
      outcome: "success",
    });
    const [dedicatedAudit] = await db
      .select()
      .from(toolCallEvents)
      .where(eq(toolCallEvents.eventType, "call_completed"));
    expect(dedicatedAudit).toMatchObject({
      issueId: issue.id,
      runId: run.id,
      toolName: "mcp-remote-fixture:add",
    });
  });

  it("lists connected remote MCP catalog tools only for the scoped company and agent policy", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const unprofiledAgent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const { run: unprofiledRun } = await createIssueAndRun(db, company.id, unprofiledAgent.id);
    const remoteTool = await createRemoteMcpTool(db, company.id, {
      applicationKey: "kv-demo",
      connectionName: "KV Demo",
      toolName: "kv_set",
      title: "Set KV value",
    });
    const otherCompany = await createCompany(db);
    const otherAgent = await createAgent(db, otherCompany.id);
    const { run: otherRun } = await createIssueAndRun(db, otherCompany.id, otherAgent.id);
    const otherRemoteTool = await createRemoteMcpTool(db, otherCompany.id, {
      applicationKey: "kv-demo",
      connectionName: "KV Demo",
      toolName: "kv_set",
      title: "Set KV value",
    });
    const profile = await allowToolsForAgent(db, company.id, agent.id, []);
    await db.insert(toolProfileEntries).values({
      companyId: company.id,
      profileId: profile.id,
      selectorType: "catalog_entry",
      effect: "include",
      catalogEntryId: remoteTool.catalogEntry.id,
    });
    const otherProfile = await allowToolsForAgent(db, otherCompany.id, otherAgent.id, []);
    await db.insert(toolProfileEntries).values({
      companyId: otherCompany.id,
      profileId: otherProfile.id,
      selectorType: "connection",
      effect: "include",
      connectionId: otherRemoteTool.connection.id,
    });

    const gateway = createTestToolGatewayService(db);
    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
    const unprofiledSession = await gateway.createSession({
      companyId: company.id,
      agentId: unprofiledAgent.id,
      runId: unprofiledRun.id,
    });
    const otherSession = await gateway.createSession({
      companyId: otherCompany.id,
      agentId: otherAgent.id,
      runId: otherRun.id,
    });

    const tools = await gateway.listToolsForSession(session.token);
    const connectedTool = tools.find((tool) => tool.providerType === "mcp_remote_http");
    expect(connectedTool).toMatchObject({
      name: expect.stringMatching(/^mcp\.kv-demo-[0-9a-f]{8}:kv-set$/),
      displayName: "Set KV value",
      providerType: "mcp_remote_http",
      risk: "write",
      applicationId: remoteTool.application.id,
      applicationKey: "kv-demo",
      connectionId: remoteTool.connection.id,
      catalogEntryId: remoteTool.catalogEntry.id,
      upstreamToolName: "kv_set",
      parametersSchema: expect.objectContaining({ type: "object" }),
      providerMetadata: expect.objectContaining({
        applicationKey: "kv-demo",
        connectionId: remoteTool.connection.id,
        catalogEntryId: remoteTool.catalogEntry.id,
        transport: "remote_http",
        upstreamToolName: "kv_set",
        annotations: { readOnlyHint: false },
        risk: expect.objectContaining({ level: "write", isWrite: true }),
      }),
    });

    await expect(gateway.listToolsForSession(unprofiledSession.token)).resolves.toEqual([]);
    const otherTools = await gateway.listToolsForSession(otherSession.token);
    expect(otherTools).toEqual([
      expect.objectContaining({
        providerType: "mcp_remote_http",
        connectionId: otherRemoteTool.connection.id,
        catalogEntryId: otherRemoteTool.catalogEntry.id,
      }),
    ]);
    expect(otherTools.map((tool) => tool.catalogEntryId)).not.toContain(remoteTool.catalogEntry.id);
  });

  it("keeps connected remote MCP gateway names collision-safe and excludes inactive catalog sources", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const first = await createRemoteMcpTool(db, company.id, {
      applicationKey: "kv-demo",
      connectionName: "KV Demo Primary",
      toolName: "kv_set",
      title: "Set KV value",
    });
    const second = await createRemoteMcpTool(db, company.id, {
      applicationKey: "kv-demo",
      connectionName: "KV Demo Secondary",
      toolName: "kv_set",
      title: "Set KV value",
    });
    await createRemoteMcpTool(db, company.id, {
      applicationKey: "disabled-demo",
      connectionName: "Disabled Demo",
      toolName: "kv_set",
      connectionEnabled: false,
    });
    await createRemoteMcpTool(db, company.id, {
      applicationKey: "unhealthy-demo",
      connectionName: "Unhealthy Demo",
      toolName: "kv_set",
      healthStatus: "error",
    });
    await createRemoteMcpTool(db, company.id, {
      applicationKey: "quarantined-demo",
      connectionName: "Quarantined Demo",
      toolName: "kv_set",
      catalogStatus: "quarantined",
      quarantinedAt: new Date(),
    });
    await allowAllToolsForAgent(db, company.id, agent.id);
    const gateway = createTestToolGatewayService(db);
    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });

    const connectedTools = (await gateway.listToolsForSession(session.token))
      .filter((tool) => tool.providerType === "mcp_remote_http");
    expect(connectedTools).toHaveLength(2);
    expect(connectedTools.map((tool) => tool.catalogEntryId).sort()).toEqual([
      first.catalogEntry.id,
      second.catalogEntry.id,
    ].sort());
    expect(new Set(connectedTools.map((tool) => tool.name)).size).toBe(2);
    expect(connectedTools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      expect.stringMatching(new RegExp(`^mcp\\.kv-demo-${first.connection.id.replace(/-/g, "").slice(0, 8)}:kv-set$`)),
      expect.stringMatching(new RegExp(`^mcp\\.kv-demo-${second.connection.id.replace(/-/g, "").slice(0, 8)}:kv-set$`)),
    ]));
  });

  it("executes a connected remote HTTP MCP tool with stored credentials and redacted audit state", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { issue, run } = await createIssueAndRun(db, company.id, agent.id);
    const credentialValue = `remote-secret-${randomUUID()}`;
    const secret = await secretService(db).create(company.id, {
      name: `Remote MCP token ${randomUUID()}`,
      key: `remote_mcp_token_${randomUUID().replace(/-/g, "")}`,
      provider: "local_encrypted",
      value: credentialValue,
    });
    const fake = await startFakeRemoteMcpServer((fakeRequest) => {
      expect(fakeRequest.headers.authorization).toBe(`Bearer ${credentialValue}`);
      const params = fakeRequest.body?.params as Record<string, unknown>;
      const args = params.arguments as Record<string, unknown>;
      return {
        body: {
          jsonrpc: "2.0",
          id: fakeRequest.body?.id,
          result: {
            content: [{ type: "text", text: `stored ${String(args.key)}=${String(args.value)}` }],
            structuredContent: { saved: true, key: args.key },
          },
        },
      };
    });
    try {
      await createRemoteMcpTool(db, company.id, {
        applicationKey: "kv-demo",
        connectionName: "KV Demo",
        toolName: "kv_set",
        title: "Set KV value",
        url: fake.url,
        credentialRefs: [{
          name: "credentials.authorization",
          secretId: secret.id,
          version: "latest",
          placement: "header",
          key: "Authorization",
          prefix: "Bearer ",
        }],
        credentialSecretRefs: [{
          secretId: secret.id,
          versionSelector: "latest",
          configPath: "credentials.authorization",
          required: true,
          label: "Remote MCP token",
        }],
      });
      await allowAllToolsForAgent(db, company.id, agent.id);
      const gateway = createTestToolGatewayService(db);
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      const connectedTool = (await gateway.listToolsForSession(session.token))
        .find((tool) => tool.providerType === "mcp_remote_http");
      expect(connectedTool).toBeTruthy();

      const result = await gateway.executeTool({
        sessionToken: session.token,
        tool: connectedTool!.name,
        parameters: { key: "alpha", value: "one" },
      });
      expect(result).toMatchObject({
        status: "completed",
        tool: connectedTool!.name,
        result: {
          content: "stored alpha=one",
          data: {
            structuredContent: { saved: true, key: "alpha" },
            isError: false,
            transport: "mcp_http",
            spawnedLocalProcess: false,
          },
        },
      });
      expect(fake.requests).toHaveLength(1);
      expect(fake.requests[0]!.body).toMatchObject({
        method: "tools/call",
        params: {
          name: "kv_set",
          arguments: { key: "alpha", value: "one" },
        },
      });

      const [invocation] = await db.select().from(toolInvocations);
      expect(invocation).toMatchObject({
        companyId: company.id,
        agentId: agent.id,
        issueId: issue.id,
        runId: run.id,
        toolName: connectedTool!.name,
        status: "succeeded",
      });
      expect(invocation.connectionId).toBe(connectedTool!.connectionId);
      expect(invocation.catalogEntryId).toBe(connectedTool!.catalogEntryId);

      const persisted = JSON.stringify({
        invocations: await db.select().from(toolInvocations),
        callEvents: await db.select().from(toolCallEvents),
        audits: await db.select().from(toolAccessAuditEvents),
        activity: await db.select().from(activityLog),
      });
      expect(persisted).not.toContain(credentialValue);
    } finally {
      await fake.close();
    }
  });

  const remoteFailureCases = [
    {
      name: "HTTP status",
      reasonCode: "remote_http_status",
      status: 502,
      response: () => ({ status: 503, body: { error: "unavailable" } }),
    },
    {
      name: "invalid JSON",
      reasonCode: "remote_http_invalid_json",
      status: 502,
      response: () => ({ rawBody: "not json" }),
    },
    {
      name: "malformed MCP response",
      reasonCode: "remote_mcp_malformed_response",
      status: 502,
      response: () => ({ body: { jsonrpc: "2.0", id: "bad", result: { content: { type: "text", text: "bad" } } } }),
    },
    {
      name: "response size",
      reasonCode: "remote_http_response_too_large",
      status: 502,
      response: () => {
        const rawBody = "x".repeat(1_000_001);
        return { rawBody, headers: { "content-length": String(Buffer.byteLength(rawBody)) } };
      },
    },
    {
      name: "timeout abort",
      reasonCode: "tool_timeout",
      status: 504,
      timeoutMs: 10,
      response: () => ({ delayMs: 75, body: { jsonrpc: "2.0", id: "slow", result: { content: [{ type: "text", text: "late" }] } } }),
    },
  ];

  for (const scenario of remoteFailureCases) {
    it(`returns a controlled gateway error for remote MCP ${scenario.name}`, async () => {
      const company = await createCompany(db);
      const agent = await createAgent(db, company.id);
      const { run } = await createIssueAndRun(db, company.id, agent.id);
      const fake = await startFakeRemoteMcpServer(() => scenario.response());
      try {
        await createRemoteMcpTool(db, company.id, {
          applicationKey: `failure-${scenario.reasonCode}`,
          toolName: "kv_set",
          url: fake.url,
        });
        await allowAllToolsForAgent(db, company.id, agent.id);
        const gateway = createTestToolGatewayService(db);
        const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
        const connectedTool = (await gateway.listToolsForSession(session.token))
          .find((tool) => tool.providerType === "mcp_remote_http");
        expect(connectedTool).toBeTruthy();

        await gateway.executeTool({
          sessionToken: session.token,
          tool: connectedTool!.name,
          parameters: { key: "alpha", value: "one" },
          timeoutMs: scenario.timeoutMs,
        }).then(
          () => {
            throw new Error("Expected remote MCP call to fail");
          },
          (error) => expectGatewayError(error, scenario.status, scenario.reasonCode),
        );

        const [invocation] = await db.select().from(toolInvocations);
        expect(invocation).toMatchObject({
          status: scenario.status === 504 ? "timed_out" : "failed",
          errorCode: scenario.reasonCode,
        });
      } finally {
        await fake.close();
      }
    });
  }

  it("persists hashed sessions and accepts them across gateway service instances", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { issue, run } = await createIssueAndRun(db, company.id, agent.id);
    await allowToolsForAgent(db, company.id, agent.id, ["mcp-remote-fixture:add"]);

    const gatewayA = createTestToolGatewayService(db);
    const session = await gatewayA.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });

    const [storedSession] = await db
      .select()
      .from(toolGatewaySessions)
      .where(eq(toolGatewaySessions.id, session.id));
    expect(storedSession).toMatchObject({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
      issueId: issue.id,
      tokenHash: createHash("sha256").update(session.token).digest("hex"),
    });
    expect(JSON.stringify(storedSession)).not.toContain(session.token);

    const gatewayB = createTestToolGatewayService(db);
    await expect(gatewayB.listToolsForSession(session.token)).resolves.toEqual([
      expect.objectContaining({ name: "mcp-remote-fixture:add" }),
    ]);
    await expect(gatewayB.executeTool({
      sessionToken: session.token,
      tool: "mcp-remote-fixture:add",
      parameters: { a: 2, b: 5 },
    })).resolves.toMatchObject({
      status: "completed",
      result: { content: "7" },
    });

    const [usedSession] = await db
      .select()
      .from(toolGatewaySessions)
      .where(eq(toolGatewaySessions.id, session.id));
    expect(usedSession.lastUsedAt).toBeInstanceOf(Date);
  });

  it("rejects gateway session tokens passed through query strings", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const gateway = createTestToolGatewayService(db);
    const session = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });
    const app = createGatewayRouteApp(db, gateway);

    const listWithQueryToken = await request(app)
      .get("/api/tool-gateway/tools")
      .query({ sessionToken: session.token });
    expect(listWithQueryToken.status).toBe(401);
    expect(listWithQueryToken.body).toEqual({ error: "Tool gateway session token is required" });

    const callWithQueryToken = await request(app)
      .post("/api/tool-gateway/tools/call")
      .query({ sessionToken: session.token })
      .send({ tool: "mcp-remote-fixture:add", parameters: { a: 1, b: 2 } });
    expect(callWithQueryToken.status).toBe(401);
    expect(callWithQueryToken.body).toEqual({ error: "Tool gateway session token is required" });

    const listWithHeaderToken = await request(app)
      .get("/api/tool-gateway/tools")
      .set("x-paperclip-tool-gateway-token", session.token);
    expect(listWithHeaderToken.status).toBe(200);
  });

  it("denies agent actors from runtime control and raw gateway audit routes", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const gateway = createTestToolGatewayService(db);
    const app = createGatewayRouteApp(db, gateway, {
      type: "agent",
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
      source: "agent_jwt",
    });

    const list = await request(app)
      .get("/api/tool-gateway/runtime-slots")
      .query({ companyId: company.id });
    expect(list.status).toBe(403);
    expect(list.body.error).toBe("Board access required");

    const stop = await request(app)
      .post("/api/tool-gateway/runtime-slots/slot-1/stop")
      .send({ companyId: company.id });
    expect(stop.status).toBe(403);
    expect(stop.body.error).toBe("Board access required");

    const restart = await request(app)
      .post("/api/tool-gateway/runtime-slots/slot-1/restart")
      .send({ companyId: company.id });
    expect(restart.status).toBe(403);
    expect(restart.body.error).toBe("Board access required");

    const audit = await request(app)
      .get("/api/tool-gateway/audit")
      .query({ companyId: company.id });
    expect(audit.status).toBe(403);
    expect(audit.body.error).toBe("Board access required");
  });

  it("allows board runtime control and audit reads through explicit board permissions", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const userId = `board-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "operator",
    });
    await db.insert(principalPermissionGrants).values([
      {
        companyId: company.id,
        principalType: "user",
        principalId: userId,
        permissionKey: "tools:manage_runtime",
        scope: null,
        grantedByUserId: "owner",
      },
      {
        companyId: company.id,
        principalType: "user",
        principalId: userId,
        permissionKey: "tools:view_audit",
        scope: null,
        grantedByUserId: "owner",
      },
    ]);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    await allowToolsForAgent(db, company.id, agent.id, ["mcp-stdio-fixture:increment_counter"]);
    const gateway = createTestToolGatewayService(db, {
      runtimeSupervisor: { restartBackoffMs: 0, idleTtlMs: 10_000 },
    });
    const session = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });
    const first = await gateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-stdio-fixture:increment_counter",
      parameters: {},
    });
    const slotId = (first.result as { data: { slotId: string } }).data.slotId;

    const app = createGatewayRouteApp(db, gateway, {
      type: "board",
      userId,
      source: "session",
      companyIds: [company.id],
      memberships: [{ companyId: company.id, membershipRole: "operator", status: "active" }],
      isInstanceAdmin: false,
    });

    const list = await request(app)
      .get("/api/tool-gateway/runtime-slots")
      .query({ companyId: company.id });
    expect(list.status).toBe(200);
    expect(list.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: slotId, status: "idle" }),
    ]));

    const stop = await request(app)
      .post(`/api/tool-gateway/runtime-slots/${slotId}/stop`)
      .send({ companyId: company.id });
    expect(stop.status).toBe(200);
    expect(stop.body).toMatchObject({ id: slotId, status: "stopped" });

    const restart = await request(app)
      .post(`/api/tool-gateway/runtime-slots/${slotId}/restart`)
      .send({ companyId: company.id });
    expect(restart.status).toBe(200);
    expect(restart.body).toMatchObject({ id: slotId, status: "running" });

    const audit = await request(app)
      .get("/api/tool-gateway/audit")
      .query({ companyId: company.id, limit: 20 });
    expect(audit.status).toBe(200);
    expect(audit.body.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        companyId: company.id,
        action: expect.stringMatching(/^tool_gateway\./),
      }),
    ]));
    expect(audit.body).toHaveProperty("nextCursor");
  });

  it("filters, paginates, and enriches tool gateway audit events server-side", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const otherAgent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const [application] = await db.insert(toolApplications).values({
      companyId: company.id,
      name: "Plugin: acme.plugin-mail",
      type: "mcp_stdio",
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: company.id,
      applicationId: application!.id,
      name: "Plugin: acme.plugin-mail",
      transport: "local_stdio",
      status: "active",
      enabled: true,
    }).returning();
    const [newerInvocation, olderInvocation, otherInvocation] = await db.insert(toolInvocations).values([
      {
        companyId: company.id,
        actorType: "agent",
        actorId: agent.id,
        agentId: agent.id,
        runId: run.id,
        applicationId: application!.id,
        connectionId: connection!.id,
        toolName: "mail:send_email",
      },
      {
        companyId: company.id,
        actorType: "agent",
        actorId: agent.id,
        agentId: agent.id,
        runId: run.id,
        applicationId: application!.id,
        connectionId: connection!.id,
        toolName: "mail:read_email",
      },
      {
        companyId: company.id,
        actorType: "agent",
        actorId: otherAgent.id,
        agentId: otherAgent.id,
        runId: run.id,
        toolName: "other:delete_everything",
      },
    ]).returning();
    const now = Date.now();
    await db.insert(activityLog).values([
      {
        companyId: company.id,
        actorType: "agent",
        actorId: agent.id,
        action: "tool_gateway.call_completed",
        entityType: "issue",
        entityId: run.id,
        agentId: agent.id,
        runId: run.id,
        details: { invocationId: newerInvocation!.id, decision: "allow", reasonCode: "tool_completed", tool: "mail:send_email" },
        createdAt: new Date(now - 1_000),
      },
      {
        companyId: company.id,
        actorType: "agent",
        actorId: agent.id,
        action: "tool_gateway.call_allowed",
        entityType: "issue",
        entityId: run.id,
        agentId: agent.id,
        runId: run.id,
        details: { invocationId: olderInvocation!.id, decision: "allow", reasonCode: "profile_allows_tool", tool: "mail:read_email" },
        createdAt: new Date(now - 2_000),
      },
      {
        companyId: company.id,
        actorType: "agent",
        actorId: otherAgent.id,
        action: "tool_gateway.call_denied",
        entityType: "issue",
        entityId: run.id,
        agentId: otherAgent.id,
        runId: run.id,
        details: { invocationId: otherInvocation!.id, decision: "deny", reasonCode: "deny_policy_block", tool: "other:delete_everything" },
        createdAt: new Date(now - 500),
      },
    ]);

    const app = createGatewayRouteApp(db, createTestToolGatewayService(db), {
      type: "board",
      userId: "instance-admin",
      source: "session",
      companyIds: [company.id],
      memberships: [{ companyId: company.id, membershipRole: "owner", status: "active" }],
      isInstanceAdmin: true,
    });

    const firstPage = await request(app)
      .get("/api/tool-gateway/audit")
      .query({ companyId: company.id, app: connection!.id, agent: agent.id, outcome: "allowed", window: "24h", limit: 1 });
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.events).toEqual([
      expect.objectContaining({
        action: "tool_gateway.call_completed",
        agentId: agent.id,
        agentDisplayName: agent.name,
        applicationId: application!.id,
        connectionId: connection!.id,
        appDisplayName: "Mail",
        toolDisplayName: "Send Email",
        normalizedOutcome: "allowed",
      }),
    ]);
    expect(typeof firstPage.body.nextCursor).toBe("string");

    const secondPage = await request(app)
      .get("/api/tool-gateway/audit")
      .query({
        companyId: company.id,
        app: connection!.id,
        agent: agent.id,
        outcome: "allowed",
        window: "24h",
        limit: 1,
        cursor: firstPage.body.nextCursor,
      });
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.events).toEqual([
      expect.objectContaining({
        action: "tool_gateway.call_allowed",
        toolDisplayName: "Read Email",
      }),
    ]);
    expect(secondPage.body.nextCursor).toBeNull();

    // Free-text search resolves against the raw tool name server-side.
    const byToolName = await request(app)
      .get("/api/tool-gateway/audit")
      .query({ companyId: company.id, window: "24h", search: "delete_everything" });
    expect(byToolName.status).toBe(200);
    expect(byToolName.body.events).toEqual([
      expect.objectContaining({ action: "tool_gateway.call_denied", toolDisplayName: "Delete Everything" }),
    ]);

    // ...and against the humanized agent name (resolved to the agent's events).
    const byAgentName = await request(app)
      .get("/api/tool-gateway/audit")
      .query({ companyId: company.id, window: "24h", search: otherAgent.name });
    expect(byAgentName.status).toBe(200);
    expect(byAgentName.body.events).toEqual([
      expect.objectContaining({ agentId: otherAgent.id }),
    ]);
  });

  it("rejects durable sessions after the heartbeat run is no longer active", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const gateway = createTestToolGatewayService(db);
    const session = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });

    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", completedAt: new Date() })
      .where(eq(heartbeatRuns.id, run.id));

    await expect(gateway.listToolsForSession(session.token)).rejects.toMatchObject({
      status: 401,
      reasonCode: "session_run_inactive",
    });
    await expect(gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    })).rejects.toMatchObject({
      status: 403,
      reasonCode: "run_inactive",
    });

    const [audit] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "tool_gateway.session_rejected"));
    expect(audit).toMatchObject({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });
    expect(audit.details).toMatchObject({
      decision: "deny",
      reasonCode: "session_run_inactive",
      runStatus: "succeeded",
    });
    expect(JSON.stringify(audit)).not.toContain(session.token);
  });

  it("rejects expired, revoked, and tampered durable sessions without auditing token values", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const gateway = createTestToolGatewayService(db);

    const expired = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });
    await db
      .update(toolGatewaySessions)
      .set({ expiresAt: new Date(Date.now() - 1_000), updatedAt: new Date() })
      .where(eq(toolGatewaySessions.id, expired.id));
    await expect(gateway.listToolsForSession(expired.token)).rejects.toMatchObject({
      status: 401,
      reasonCode: "session_expired",
    });

    const revoked = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });
    await gateway.revokeSession({ companyId: company.id, sessionId: revoked.id });
    await expect(gateway.listToolsForSession(revoked.token)).rejects.toMatchObject({
      status: 401,
      reasonCode: "session_revoked",
    });

    const tampered = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });
    const badToken = tamperToken(tampered.token);
    await expect(gateway.listToolsForSession(badToken)).rejects.toMatchObject({
      status: 401,
      reasonCode: "session_invalid",
    });

    const audits = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "tool_gateway.session_rejected"));
    expect(audits).toHaveLength(3);
    const serializedAudits = JSON.stringify(audits);
    expect(serializedAudits).toContain("session_expired");
    expect(serializedAudits).toContain("session_revoked");
    expect(serializedAudits).toContain("session_invalid");
    expect(serializedAudits).not.toContain(expired.token);
    expect(serializedAudits).not.toContain(revoked.token);
    expect(serializedAudits).not.toContain(tampered.token);
    expect(serializedAudits).not.toContain(badToken);

    const dedicatedAudits = await db
      .select()
      .from(toolAccessAuditEvents)
      .where(eq(toolAccessAuditEvents.action, "call_denied"));
    expect(dedicatedAudits).toHaveLength(3);
    expect(dedicatedAudits.every((event) => event.outcome === "denied")).toBe(true);
  });

  it("cleans up expired durable sessions explicitly", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const gateway = createTestToolGatewayService(db);
    const oldSession = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });
    await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });
    await db
      .update(toolGatewaySessions)
      .set({ expiresAt: new Date(Date.now() - 1_000), updatedAt: new Date() })
      .where(eq(toolGatewaySessions.id, oldSession.id));

    await expect(gateway.cleanupExpiredSessions()).resolves.toEqual({ deletedCount: 1 });

    const remaining = await db.select().from(toolGatewaySessions);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).not.toBe(oldSession.id);
  });

  it("lazy-starts, reuses, and idles down the local stdio fixture slot", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    await allowToolsForAgent(db, company.id, agent.id, [
      "mcp-stdio-fixture:increment_counter",
      "mcp-stdio-fixture:runtime_status",
    ]);
    const gateway = createTestToolGatewayService(db, { runtimeSupervisor: { idleTtlMs: 25 } });
    const session = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });

    const first = await gateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-stdio-fixture:increment_counter",
      parameters: {},
    });
    const second = await gateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-stdio-fixture:runtime_status",
      parameters: {},
    });

    const firstData = (first.result as { data: Record<string, unknown> }).data;
    const secondData = (second.result as { data: Record<string, unknown> }).data;
    expect(firstData).toMatchObject({ lazyStarted: true, reusedRuntimeSlot: false, counter: 1 });
    expect(secondData).toMatchObject({ lazyStarted: false, reusedRuntimeSlot: true, counter: 1 });
    expect(secondData.slotId).toBe(firstData.slotId);
    await expect(gateway.listRuntimeSlots(company.id)).resolves.toHaveLength(1);
    const [idleSlot] = await db.select().from(toolRuntimeSlots).where(eq(toolRuntimeSlots.companyId, company.id));
    expect(idleSlot).toMatchObject({
      status: "idle",
      commandTemplateKey: "paperclip.slow-stateful-stdio",
      healthStatus: "ok",
    });
    expect(idleSlot.metadata).toMatchObject({
      counter: 1,
      useCount: 2,
      process: expect.objectContaining({ simulated: true }),
      resourceLimits: expect.objectContaining({ memoryCeilingSupported: expect.any(Boolean) }),
    });

    await new Promise((resolve) => setTimeout(resolve, 35));
    await expect(gateway.listRuntimeSlots(company.id)).resolves.toEqual([]);
    const [stoppedSlot] = await db.select().from(toolRuntimeSlots).where(eq(toolRuntimeSlots.id, idleSlot.id));
    expect(stoppedSlot).toMatchObject({
      status: "stopped",
      healthMessage: "Stopped after idle TTL.",
    });
  });

  it("supports explicit stop and restart actions for local stdio slots", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    await allowToolsForAgent(db, company.id, agent.id, ["mcp-stdio-fixture:increment_counter"]);
    const gateway = createTestToolGatewayService(db, { runtimeSupervisor: { restartBackoffMs: 0 } });
    const session = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });

    const first = await gateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-stdio-fixture:increment_counter",
      parameters: {},
    });
    const slotId = (first.result as { data: { slotId: string } }).data.slotId;

    await expect(gateway.stopRuntimeSlot({ companyId: company.id, slotId, actor: { agentId: agent.id, runId: run.id } }))
      .resolves.toMatchObject({ id: slotId, status: "stopped" });
    await expect(gateway.listRuntimeSlots(company.id)).resolves.toEqual([]);

    await expect(gateway.restartRuntimeSlot({ companyId: company.id, slotId, actor: { agentId: agent.id, runId: run.id } }))
      .resolves.toMatchObject({ id: slotId, status: "running" });
  });

  it("returns structured runtime defer when local stdio host capacity is exhausted", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    await allowToolsForAgent(db, company.id, agent.id, ["mcp-stdio-fixture:increment_counter"]);
    const otherCompany = await createCompany(db);
    const otherAgent = await createAgent(db, otherCompany.id);
    const { run: otherRun } = await createIssueAndRun(db, otherCompany.id, otherAgent.id);
    await allowToolsForAgent(db, otherCompany.id, otherAgent.id, ["mcp-stdio-fixture:increment_counter"]);
    const gateway = createTestToolGatewayService(db, {
      runtimeSupervisor: { idleTtlMs: 10_000, maxHostSlots: 1, hostId: "shared-host" },
    });
    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
    const otherSession = await gateway.createSession({ companyId: otherCompany.id, agentId: otherAgent.id, runId: otherRun.id });

    await gateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-stdio-fixture:increment_counter",
      parameters: {},
    });

    await gateway.executeTool({
      sessionToken: otherSession.token,
      tool: "mcp-stdio-fixture:increment_counter",
      parameters: {},
    }).then(
      () => {
        throw new Error("Expected host capacity to defer the second stdio slot");
      },
      (error) => expectGatewayError(error, 429, "runtime_capacity_unavailable"),
    );

    const [invocation] = await db
      .select()
      .from(toolInvocations)
      .where(eq(toolInvocations.companyId, otherCompany.id));
    const [deferAudit] = await db
      .select()
      .from(toolAccessAuditEvents)
      .where(eq(toolAccessAuditEvents.action, "runtime_deferred"));
    expect(invocation).toMatchObject({
      status: "rate_limited",
      errorCode: "runtime_capacity_unavailable",
    });
    expect(deferAudit).toMatchObject({
      outcome: "failure",
      reasonCode: "runtime_host_capacity_exhausted",
    });
  });

  it("fails closed for hosted public local stdio unless a trusted runtime host is configured", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    await allowToolsForAgent(db, company.id, agent.id, ["mcp-stdio-fixture:increment_counter"]);
    const hostedGateway = createTestToolGatewayService(db, {
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      trustedLocalStdioRuntimeHost: null,
    });
    const session = await hostedGateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });

    await hostedGateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-stdio-fixture:increment_counter",
      parameters: {},
    }).then(
      () => {
        throw new Error("Expected public hosted local stdio to fail closed");
      },
      (error) => expectGatewayError(error, 403, "local_stdio_unavailable_in_public_mode"),
    );

    const trustedGateway = createTestToolGatewayService(db, {
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      trustedLocalStdioRuntimeHost: "trusted-worker-1",
      runtimeSupervisor: { idleTtlMs: 10_000 },
    });
    const trustedSession = await trustedGateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
    await expect(trustedGateway.executeTool({
      sessionToken: trustedSession.token,
      tool: "mcp-stdio-fixture:increment_counter",
      parameters: {},
    })).resolves.toMatchObject({ status: "completed" });
  });

  it("suppresses restart storms with backoff-visible slot health", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    await allowToolsForAgent(db, company.id, agent.id, ["mcp-stdio-fixture:increment_counter"]);
    const gateway = createTestToolGatewayService(db, {
      runtimeSupervisor: {
        restartBackoffMs: 0,
        restartStormLimit: 1,
        restartStormWindowMs: 10_000,
      },
    });
    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
    const first = await gateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-stdio-fixture:increment_counter",
      parameters: {},
    });
    const slotId = (first.result as { data: { slotId: string } }).data.slotId;

    await gateway.restartRuntimeSlot({ companyId: company.id, slotId, actor: { agentId: agent.id, runId: run.id } });
    await gateway.restartRuntimeSlot({ companyId: company.id, slotId, actor: { agentId: agent.id, runId: run.id } }).then(
      () => {
        throw new Error("Expected restart storm suppression");
      },
      (error) => expectGatewayError(error, 429, "runtime_restart_suppressed"),
    );

    const [slot] = await db.select().from(toolRuntimeSlots).where(eq(toolRuntimeSlots.id, slotId));
    expect(slot).toMatchObject({
      status: "failed",
      healthStatus: "error",
      lastError: "restart_storm_suppressed",
    });
    expect(slot.metadata).toMatchObject({
      restartSuppressedUntil: expect.any(String),
    });
  });

  it("recovers stuck local stdio slots before reuse", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    await allowToolsForAgent(db, company.id, agent.id, [
      "mcp-stdio-fixture:increment_counter",
      "mcp-stdio-fixture:runtime_status",
    ]);
    const gateway = createTestToolGatewayService(db, { runtimeSupervisor: { stuckSlotMs: 1, idleTtlMs: 10_000 } });
    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
    const first = await gateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-stdio-fixture:increment_counter",
      parameters: {},
    });
    const slotId = (first.result as { data: { slotId: string } }).data.slotId;
    const staleAt = new Date(Date.now() - 60_000);
    await db
      .update(toolRuntimeSlots)
      .set({
        status: "running",
        lastUsedAt: staleAt,
        startedAt: staleAt,
        idleDeadlineAt: null,
        idleExpiresAt: null,
        updatedAt: staleAt,
      })
      .where(eq(toolRuntimeSlots.id, slotId));

    const recovered = await gateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-stdio-fixture:runtime_status",
      parameters: {},
    });

    expect((recovered.result as { data: { slotId: string; reusedRuntimeSlot: boolean } }).data).toMatchObject({
      slotId,
      reusedRuntimeSlot: true,
    });
    const [slot] = await db.select().from(toolRuntimeSlots).where(eq(toolRuntimeSlots.id, slotId));
    expect(slot).toMatchObject({
      status: "idle",
      healthStatus: "ok",
    });
    expect(slot.metadata).toMatchObject({
      stuckRecoveries: 1,
      lastRestartReason: "stuck_slot_recovered",
    });
  });

  it("defers write-risk tool calls into issue-thread approval requests", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { issue, run } = await createIssueAndRun(db, company.id, agent.id);
    await allowToolsForAgent(db, company.id, agent.id, ["mcp-remote-fixture:update_note"]);
    await db.insert(toolPolicies).values({
      companyId: company.id,
      name: "Review note updates",
      policyType: "require_approval",
      selectors: { toolName: "mcp-remote-fixture:update_note" },
      description: "Note updates require review.",
    });
    const gateway = createTestToolGatewayService(db);
    const session = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });

    await gateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-remote-fixture:update_note",
      parameters: { noteId: "n1", body: "review this write" },
    }).then(
      () => {
        throw new Error("Expected write-risk tool call to request approval");
      },
      (error) => expectGatewayError(error, 409, "approval_required"),
    );

    const [actionRequest] = await db.select().from(toolActionRequests);
    const [interaction] = await db.select().from(issueThreadInteractions);
    expect(actionRequest).toMatchObject({
      companyId: company.id,
      issueId: issue.id,
      status: "pending",
      requestedByAgentId: agent.id,
    });
    expect(interaction).toMatchObject({
      companyId: company.id,
      issueId: issue.id,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee_on_accept",
    });
  });

  it("wraps plugin tool discovery and execution behind the same gateway policy", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run, project } = await createIssueAndRun(db, company.id, agent.id);
    const calls: unknown[] = [];
    const dispatcher: PluginToolDispatcher = {
      initialize: async () => {},
      teardown: () => {},
      listToolsForAgent: () => [
        {
          name: "demo-plugin:read_status",
          displayName: "Read status",
          description: "Read status through a plugin tool.",
          parametersSchema: { type: "object" },
          pluginId: "demo-plugin",
        },
      ],
      getTool: () => null,
      executeTool: async (tool, parameters, runContext) => {
        calls.push({ tool, parameters, runContext });
        return {
          pluginId: "demo-plugin",
          toolName: "read_status",
          result: { content: "plugin ok", data: { ok: true } },
        };
      },
      registerPluginTools: () => {},
      unregisterPluginTools: () => {},
      toolCount: () => 1,
      getRegistry: () => {
        throw new Error("not used");
      },
    };
    const gateway = createTestToolGatewayService(db, { pluginToolDispatcher: dispatcher });

    await expect(gateway.listPluginToolsForAgent({ companyId: company.id, agentId: agent.id })).resolves.toEqual([]);
    await gateway.executePluginTool({
      actor: { type: "agent", companyId: company.id, agentId: agent.id, runId: run.id },
      tool: "demo-plugin:read_status",
      parameters: {},
      runContext: { companyId: company.id, agentId: agent.id, runId: run.id, projectId: project.id },
    }).then(
      () => {
        throw new Error("Expected plugin tool call without profile to fail");
      },
      (error) => expectGatewayError(error, 403, "deny_default"),
    );

    await allowToolsForAgent(db, company.id, agent.id, ["demo-plugin:read_status"]);

    await expect(gateway.listPluginToolsForAgent({ companyId: company.id, agentId: agent.id })).resolves.toEqual([
      expect.objectContaining({ name: "demo-plugin:read_status" }),
    ]);
    await expect(gateway.executePluginTool({
      actor: { type: "agent", companyId: company.id, agentId: agent.id, runId: run.id },
      tool: "demo-plugin:read_status",
      parameters: { id: "1" },
      runContext: { companyId: company.id, agentId: agent.id, runId: run.id, projectId: project.id },
    })).resolves.toMatchObject({
      pluginId: "demo-plugin",
      toolName: "read_status",
      result: { content: "plugin ok", data: { ok: true } },
    });
    expect(calls).toEqual([
      expect.objectContaining({
        tool: "demo-plugin:read_status",
        parameters: { id: "1" },
      }),
    ]);
  });

  it("rejects caller-supplied issue context outside the run company", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const run = await db
      .insert(heartbeatRuns)
      .values({
        companyId: company.id,
        agentId: agent.id,
        invocationSource: "assignment",
        status: "running",
        contextSnapshot: {},
      })
      .returning()
      .then((rows) => rows[0]!);
    const otherCompany = await createCompany(db);
    const otherAgent = await createAgent(db, otherCompany.id);
    const { issue: otherIssue } = await createIssueAndRun(db, otherCompany.id, otherAgent.id);
    const gateway = createTestToolGatewayService(db);

    await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
      issueId: otherIssue.id,
    }).then(
      () => {
        throw new Error("Expected cross-company issue context to fail");
      },
      (error) => expectGatewayError(error, 403, "run_context_mismatch"),
    );
  });
});
