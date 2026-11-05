import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  approvals,
  companies,
  companySecrets,
  connectionGrants,
  createDb,
  heartbeatRuns,
  issueApprovals,
  issues,
  projects,
  issueThreadInteractions,
  toolApplications,
  toolCatalogEntries,
  toolConnections,
  toolAccessAuditEvents,
  toolActionRequests,
  toolCallEvents,
  toolGatewaySessions,
  toolInvocations,
  toolPolicies,
} from "@paperclipai/db";
import {
  createToolGatewayService,
  ToolGatewayHttpError,
} from "../services/tool-gateway.js";
import { INSUFFICIENT_CONNECTION_SCOPE_MESSAGE } from "../services/connection-permission-errors.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const testToolActionSigningSecret = "test-tool-action-signing-secret";
type ToolGatewayServiceOptions = NonNullable<Parameters<typeof createToolGatewayService>[1]>;

function createTestToolGatewayService(db: ReturnType<typeof createDb>, options: ToolGatewayServiceOptions = {}) {
  return createToolGatewayService(db, {
    ...options,
    toolActionSigningSecret: options.toolActionSigningSecret ?? testToolActionSigningSecret,
    remoteHttpRequest: options.remoteHttpRequest ?? (async (url, init) => fetch(url, init)),
  });
}

const EARLIER_HEALTH_CHECK_AT = new Date("2000-01-01T00:00:00.000Z");
const LATER_HEALTH_CHECK_AT = new Date("2100-01-01T00:00:00.000Z");

function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
}

function jsonRpcResponse(init: RequestInit | undefined, payload: Record<string, unknown>) {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: requestBody(init).id, ...payload }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function abandonedRequest(
  init: RequestInit | undefined,
  onAbort?: () => Promise<void>,
): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      void (async () => {
        try {
          await onAbort?.();
        } finally {
          const abortError = new Error("The operation was aborted");
          abortError.name = "AbortError";
          reject(abortError);
        }
      })();
    });
  });
}

async function createRunFixture(db: ReturnType<typeof createDb>) {
  const company = await db.insert(companies).values({
    name: `Gateway ${randomUUID()}`,
    issuePrefix: `TG${randomUUID().slice(0, 6).toUpperCase()}`,
  }).returning().then((rows) => rows[0]!);
  const agent = await db.insert(agents).values({
    companyId: company.id,
    name: `Gateway Agent ${randomUUID()}`,
    role: "engineer",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  }).returning().then((rows) => rows[0]!);
  const issue = await db.insert(issues).values({
    companyId: company.id,
    title: "Gateway work",
    status: "in_progress",
    assigneeAgentId: agent.id,
  }).returning().then((rows) => rows[0]!);
  const run = await db.insert(heartbeatRuns).values({
    companyId: company.id,
    agentId: agent.id,
    invocationSource: "assignment",
    status: "running",
    contextSnapshot: { issueId: issue.id },
  }).returning().then((rows) => rows[0]!);
  await db.insert(toolPolicies).values({
    companyId: company.id,
    name: "Allow all tools",
    policyType: "allow",
    selectors: {},
  });
  return { company, agent, issue, run };
}

async function createRemoteMcpFixture(
  db: ReturnType<typeof createDb>,
  companyId: string,
  options?: {
    config?: Record<string, unknown>;
  },
) {
  const toolName = "query_data";

  const application = await db.insert(toolApplications).values({
    companyId,
    applicationKey: `remote-${randomUUID().slice(0, 8)}`,
    name: `Remote MCP Service ${toolName}`,
    type: "mcp_http",
    status: "active",
  }).returning().then((rows) => rows[0]!);

  const connection = await db.insert(toolConnections).values({
    companyId,
    applicationId: application.id,
    name: "Remote MCP Connection",
    uid: `test/${randomUUID()}`,
    transport: "mcp_remote",
    status: "active",
    enabled: true,
    healthStatus: "ok",
    healthCheckedAt: EARLIER_HEALTH_CHECK_AT,
    lastHealthAt: EARLIER_HEALTH_CHECK_AT,
    credentialPolicy: "shared",
    config: { url: "https://8.8.8.8/mcp", ...options?.config },
  }).returning().then((rows) => rows[0]!);

  await db.insert(connectionGrants).values({
    companyId,
    connectionId: connection.id,
    kind: "organization",
    credentialSecretRefs: [],
    status: "active",
    isDefault: true,
  });

  const catalogEntry = await db.insert(toolCatalogEntries).values({
    companyId,
    applicationId: application.id,
    connectionId: connection.id,
    entryKind: "tool",
    name: toolName,
    toolName,
    title: "Remote Tool",
    riskLevel: "read",
    isReadOnly: true,
    status: "active",
    versionHash: randomUUID(),
    schemaHash: randomUUID(),
  }).returning().then((rows) => rows[0]!);

  return { application, connection, catalogEntry };
}

describeEmbeddedPostgres("remote MCP timeout and health resilience", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-remote-mcp-health-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.delete(activityLog);
    await db.delete(agentWakeupRequests);
    await db.delete(toolGatewaySessions);
    await db.delete(toolCallEvents);
    await db.delete(toolAccessAuditEvents);
    await db.delete(toolActionRequests);
    await db.delete(toolInvocations);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issueThreadInteractions);
    await db.delete(toolCatalogEntries);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(companySecrets);
    await db.delete(toolPolicies);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function connectionRow(connectionId: string) {
    const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId));
    return row!;
  }

  async function lastFailedCallEvent(companyId: string) {
    const [row] = await db
      .select()
      .from(toolCallEvents)
      .where(and(eq(toolCallEvents.companyId, companyId), eq(toolCallEvents.eventType, "call_failed")))
      .orderBy(desc(toolCallEvents.createdAt));
    return row ?? null;
  }

  it("keeps an abandoned call's connection in the catalog and records the ambiguous outcome", async () => {
    const { company, agent, run } = await createRunFixture(db);
    const { connection } = await createRemoteMcpFixture(db, company.id);

    const gateway = createTestToolGatewayService(db, {
      remoteHttpRequest: async (_url, init) => abandonedRequest(init),
    });

    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
    const targetTool = (await gateway.listToolsForSession(session.token))
      .find((tool) => tool.providerType === "mcp_remote_http")!;
    expect(targetTool).toBeDefined();

    const error = await gateway.executeTool({
      sessionToken: session.token,
      tool: targetTool.name,
      parameters: { q: "test" },
      timeoutMs: 20,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ToolGatewayHttpError);
    const gatewayError = error as ToolGatewayHttpError;
    expect(gatewayError.status).toBe(504);
    expect(gatewayError.reasonCode).toBe("tool_timeout");
    expect(gatewayError.details.failureKind).toBe("invocation_timeout");
    expect(gatewayError.details.execution).toMatchObject({ failureKind: "invocation_timeout" });

    const stored = await connectionRow(connection.id);
    expect(stored.healthStatus).toBe("degraded");
    expect(stored.healthMessage).toBe("Remote MCP tool call timed out.");

    const sameSession = await gateway.listToolsForSession(session.token);
    expect(sameSession.some((tool) => tool.name === targetTool.name)).toBe(true);
    const fresh = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
    const freshSession = await gateway.listToolsForSession(fresh.token);
    expect(freshSession.some((tool) => tool.name === targetTool.name)).toBe(true);

    const invocations = await db.select().from(toolInvocations).where(eq(toolInvocations.companyId, company.id));
    expect(invocations.length).toBe(1);
    expect(invocations[0]?.status).toBe("timed_out");
    expect(invocations[0]?.errorCode).toBe("tool_timeout");

    const event = await lastFailedCallEvent(company.id);
    expect(event?.outcome).toBe("timeout");
    expect(event?.metadata).toMatchObject({ execution: { failureKind: "invocation_timeout" } });
  });

  it("keeps hiding a connection degraded for another reason than a timeout", async () => {
    const { company, agent, run } = await createRunFixture(db);
    const { connection } = await createRemoteMcpFixture(db, company.id);

    await db
      .update(toolConnections)
      .set({
        healthStatus: "degraded",
        healthMessage: INSUFFICIENT_CONNECTION_SCOPE_MESSAGE,
        updatedAt: new Date(),
      })
      .where(eq(toolConnections.id, connection.id));

    const gateway = createTestToolGatewayService(db);
    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
    const tools = await gateway.listToolsForSession(session.token);
    expect(tools.some((tool) => tool.providerType === "mcp_remote_http")).toBe(false);
  });

  it("restores ok health when a later exchange succeeds", async () => {
    const { company, agent, run } = await createRunFixture(db);
    const { connection } = await createRemoteMcpFixture(db, company.id);

    let answer = false;
    const gateway = createTestToolGatewayService(db, {
      remoteHttpRequest: async (_url, init) =>
        answer
          ? jsonRpcResponse(init, { result: { content: [{ type: "text", text: "success data" }] } })
          : abandonedRequest(init),
    });

    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
    const targetTool = (await gateway.listToolsForSession(session.token))
      .find((tool) => tool.providerType === "mcp_remote_http")!;

    await expect(
      gateway.executeTool({ sessionToken: session.token, tool: targetTool.name, parameters: {}, timeoutMs: 20 }),
    ).rejects.toMatchObject({ status: 504, reasonCode: "tool_timeout" });
    expect((await connectionRow(connection.id)).healthStatus).toBe("degraded");

    answer = true;
    const result = await gateway.executeTool({
      sessionToken: session.token,
      tool: targetTool.name,
      parameters: {},
      timeoutMs: 500,
    });
    expect(result.status).toBe("completed");

    const restored = await connectionRow(connection.id);
    expect(restored.healthStatus).toBe("ok");
    expect(restored.healthMessage).toBe("Remote MCP server responded to tools/call.");
    expect(restored.lastError).toBeNull();
  });

  it("fails closed and withdraws the catalog when the transport never answers", async () => {
    const { company, agent, run } = await createRunFixture(db);
    const { connection } = await createRemoteMcpFixture(db, company.id);

    await db
      .update(toolConnections)
      .set({ healthCheckedAt: LATER_HEALTH_CHECK_AT, lastHealthAt: LATER_HEALTH_CHECK_AT })
      .where(eq(toolConnections.id, connection.id));

    const gateway = createTestToolGatewayService(db, {
      remoteHttpRequest: async () => {
        throw new TypeError("fetch failed: ECONNREFUSED");
      },
    });

    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
    const targetTool = (await gateway.listToolsForSession(session.token))
      .find((tool) => tool.providerType === "mcp_remote_http")!;

    const error = await gateway.executeTool({
      sessionToken: session.token,
      tool: targetTool.name,
      parameters: {},
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ToolGatewayHttpError);
    const gatewayError = error as ToolGatewayHttpError;
    expect(gatewayError.status).toBe(502);
    expect(gatewayError.reasonCode).toBe("mcp_remote_fetch_failed");
    expect(gatewayError.details.failureKind).toBe("transport_failure");

    expect((await connectionRow(connection.id)).healthStatus).toBe("error");

    const remaining = await gateway.listToolsForSession(session.token);
    expect(remaining.some((tool) => tool.name === targetTool.name)).toBe(false);
    await expect(
      gateway.executeTool({ sessionToken: session.token, tool: targetTool.name, parameters: {} }),
    ).rejects.toMatchObject({ status: 404, reasonCode: "tool_not_found" });
  });

  it("reports every protocol failure with its failure kind and keeps the connection healthy", async () => {
    const { company, agent, run } = await createRunFixture(db);
    const { connection } = await createRemoteMcpFixture(db, company.id);

    const cases = [
      {
        name: "HTTP error status",
        reasonCode: "mcp_remote_status",
        respond: () => new Response("Internal Server Error", { status: 500 }),
      },
      {
        name: "body that is not JSON",
        reasonCode: "mcp_remote_invalid_json",
        respond: () =>
          new Response("This is not JSON", { status: 200, headers: { "content-type": "application/json" } }),
      },
      {
        name: "JSON-RPC error",
        reasonCode: "remote_mcp_error",
        respond: (init: RequestInit | undefined) =>
          jsonRpcResponse(init, { error: { code: -32603, message: "Internal JSON-RPC failure" } }),
      },
      {
        name: "answer to a different request",
        reasonCode: "remote_mcp_malformed_response",
        respond: () =>
          new Response(
            JSON.stringify({ jsonrpc: "2.0", id: "some-other-call", result: { content: [] } }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      },
      {
        name: "oversized body",
        reasonCode: "mcp_remote_response_too_large",
        respond: (init: RequestInit | undefined) =>
          jsonRpcResponse(init, { result: { content: [{ type: "text", text: "x".repeat(1_100_000) }] } }),
      },
    ];

    for (const testCase of cases) {
      await db
        .update(toolConnections)
        .set({
          healthStatus: "ok",
          healthMessage: null,
          healthCheckedAt: LATER_HEALTH_CHECK_AT,
          lastHealthAt: LATER_HEALTH_CHECK_AT,
          lastError: null,
        })
        .where(eq(toolConnections.id, connection.id));

      const gateway = createTestToolGatewayService(db, {
        remoteHttpRequest: async (_url, init) => testCase.respond(init),
      });
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      const targetTool = (await gateway.listToolsForSession(session.token))
        .find((tool) => tool.providerType === "mcp_remote_http")!;
      expect(targetTool, testCase.name).toBeDefined();

      const error = await gateway.executeTool({
        sessionToken: session.token,
        tool: targetTool.name,
        parameters: {},
      }).catch((caught: unknown) => caught as ToolGatewayHttpError);

      expect(error.status, testCase.name).toBe(502);
      expect(error.reasonCode, testCase.name).toBe(testCase.reasonCode);
      expect(error.details.failureKind, testCase.name).toBe("protocol_failure");
      expect(error.details.execution, testCase.name).toMatchObject({ failureKind: "protocol_failure" });

      expect((await connectionRow(connection.id)).healthStatus, testCase.name).toBe("ok");
      const remaining = await gateway.listToolsForSession(session.token);
      expect(remaining.some((tool) => tool.name === targetTool.name), testCase.name).toBe(true);
    }
  });

  it("treats an expired remote session as recoverable rather than as a protocol failure", async () => {
    const { company, agent, run } = await createRunFixture(db);
    const { connection } = await createRemoteMcpFixture(db, company.id, {
      config: { mcpSessionRequired: true },
    });

    const gateway = createTestToolGatewayService(db, {
      remoteHttpRequest: async (_url, init) => {
        const body = requestBody(init);
        if (body.method === "initialize") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "test", version: "1" } },
            }),
            { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "session-1" } },
          );
        }
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
        return new Response("session expired", { status: 404 });
      },
    });

    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
    const targetTool = (await gateway.listToolsForSession(session.token))
      .find((tool) => tool.providerType === "mcp_remote_http")!;

    const error = await gateway.executeTool({
      sessionToken: session.token,
      tool: targetTool.name,
      parameters: {},
    }).catch((caught: unknown) => caught as ToolGatewayHttpError);

    expect(error.reasonCode).toBe("mcp_remote_status");
    expect(error.details.sessionExpired).toBe(true);
    expect(error.details.failureKind).toBeUndefined();
    expect(error.details.execution).not.toMatchObject({ failureKind: expect.anything() });
    expect((await connectionRow(connection.id)).healthStatus).toBe("ok");
    const remaining = await gateway.listToolsForSession(session.token);
    expect(remaining.some((tool) => tool.name === targetTool.name)).toBe(true);
  });

  it("does not blame the transport for a failure raised after the response arrived", async () => {
    const { company, agent, issue, run } = await createRunFixture(db);
    const { connection } = await createRemoteMcpFixture(db, company.id);

    const collidingKey = "a".repeat(120);
    const gateway = createTestToolGatewayService(db, {
      remoteHttpRequest: async (_url, init) =>
        jsonRpcResponse(init, {
          result: {
            elicitation: {
              message: "More detail needed",
              requestedSchema: {
                properties: { [`${collidingKey}1`]: { type: "string" }, [`${collidingKey}2`]: { type: "string" } },
              },
            },
          },
        }),
    });

    const session = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
      issueId: issue.id,
    });
    const targetTool = (await gateway.listToolsForSession(session.token))
      .find((tool) => tool.providerType === "mcp_remote_http")!;

    const error = await gateway.executeTool({
      sessionToken: session.token,
      tool: targetTool.name,
      parameters: {},
    }).catch((caught: unknown) => caught as ToolGatewayHttpError);

    expect(error.status).toBe(502);
    expect(error.reasonCode).toBe("mcp_remote_fetch_failed");
    expect(error.details.failureKind).toBeUndefined();
    expect(error.details.execution).toMatchObject({ response: { httpStatus: 200 } });
    expect(error.details.execution).not.toMatchObject({ failureKind: expect.anything() });
    expect((await connectionRow(connection.id)).healthStatus).toBe("error");
  });

  describe("a stale timeout never overwrites a newer settled health state", () => {
    async function timeoutRacingConcurrentWrite(settled: {
      healthStatus: "ok" | "healthy" | "error";
      healthMessage: string;
      withObservationTime?: boolean;
    }) {
      const { company, agent, run } = await createRunFixture(db);
      const { connection } = await createRemoteMcpFixture(db, company.id);

      const gateway = createTestToolGatewayService(db, {
        remoteHttpRequest: async (_url, init) =>
          abandonedRequest(init, async () => {
            const { withObservationTime = true, ...health } = settled;
            const observedAt = new Date();
            await db
              .update(toolConnections)
              .set({
                ...health,
                ...(withObservationTime ? { healthCheckedAt: observedAt, lastHealthAt: observedAt } : {}),
                updatedAt: observedAt,
              })
              .where(eq(toolConnections.id, connection.id));
          }),
      });

      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      const targetTool = (await gateway.listToolsForSession(session.token))
        .find((tool) => tool.providerType === "mcp_remote_http")!;

      await expect(
        gateway.executeTool({
          sessionToken: session.token,
          tool: targetTool.name,
          parameters: {},
          timeoutMs: 20,
        }),
      ).rejects.toMatchObject({ status: 504, reasonCode: "tool_timeout" });

      return { connection, gateway, session, targetTool };
    }

    it("keeps a newer successful health check", async () => {
      const { connection } = await timeoutRacingConcurrentWrite({
        healthStatus: "ok",
        healthMessage: "Tool catalog refreshed concurrently.",
      });
      const stored = await connectionRow(connection.id);
      expect(stored.healthStatus).toBe("ok");
      expect(stored.healthMessage).toBe("Tool catalog refreshed concurrently.");
    });

    it("keeps a newer healthy health check", async () => {
      const { connection } = await timeoutRacingConcurrentWrite({
        healthStatus: "healthy",
        healthMessage: "Connection probe succeeded.",
      });
      const stored = await connectionRow(connection.id);
      expect(stored.healthStatus).toBe("healthy");
      expect(stored.healthMessage).toBe("Connection probe succeeded.");
    });

    it("keeps a newer state written without an observation time", async () => {
      const { connection } = await timeoutRacingConcurrentWrite({
        healthStatus: "error",
        healthMessage: "OAuth authorization expired. Reconnect this app to continue.",
        withObservationTime: false,
      });
      const stored = await connectionRow(connection.id);
      expect(stored.healthStatus).toBe("error");
      expect(stored.healthMessage).toBe("OAuth authorization expired. Reconnect this app to continue.");
    });

    it("records the timeout over an older state that has no observation time", async () => {
      const { company, agent, run } = await createRunFixture(db);
      const { connection } = await createRemoteMcpFixture(db, company.id);
      await db
        .update(toolConnections)
        .set({ healthStatus: "ok", healthMessage: "Adopted without a health check.", healthCheckedAt: null, lastHealthAt: null, updatedAt: EARLIER_HEALTH_CHECK_AT })
        .where(eq(toolConnections.id, connection.id));

      const gateway = createTestToolGatewayService(db, {
        remoteHttpRequest: async (_url, init) => abandonedRequest(init),
      });
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      const targetTool = (await gateway.listToolsForSession(session.token))
        .find((tool) => tool.providerType === "mcp_remote_http")!;
      await expect(
        gateway.executeTool({
          sessionToken: session.token,
          tool: targetTool.name,
          parameters: {},
          timeoutMs: 20,
        }),
      ).rejects.toMatchObject({ status: 504, reasonCode: "tool_timeout" });

      const stored = await connectionRow(connection.id);
      expect(stored.healthStatus).toBe("degraded");
      expect(stored.healthMessage).toBe("Remote MCP tool call timed out.");
    });

    it("does not return a newly failed connection to the catalog", async () => {
      const { connection, gateway, session, targetTool } = await timeoutRacingConcurrentWrite({
        healthStatus: "error",
        healthMessage: "Connection probe failed.",
      });
      const stored = await connectionRow(connection.id);
      expect(stored.healthStatus).toBe("error");
      expect(stored.healthMessage).toBe("Connection probe failed.");
      const remaining = await gateway.listToolsForSession(session.token);
      expect(remaining.some((tool) => tool.name === targetTool.name)).toBe(false);
    });
  });
});
