import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  connectionGrants,
  createDb,
  heartbeatRuns,
  issues,
  projects,
  toolAccessAuditEvents,
  toolActionRequests,
  toolCallEvents,
  toolApplications,
  toolCatalogEntries,
  toolConnections,
  toolInvocations,
  toolMcpConnectors,
  toolPolicies,
  toolProfileBindings,
  toolProfiles,
} from "@paperclipai/db";
import { MCP_CONNECTOR_ENROLL_PATH, MCP_CONNECTOR_ROTATE_PATH } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { actorMiddleware } from "../middleware/auth.js";
import { isSecretSensitiveHttpRequest } from "../middleware/http-log-policy.js";
import { setupMcpConnectorWebSocketServer } from "../realtime/mcp-connector-ws.js";
import { mcpConnectorRoutes } from "../routes/mcp-connectors.js";
import { createInviteRateLimiter } from "../services/invite-rate-limit.js";
import { McpConnectorHub } from "../services/mcp-connector-hub.js";
import { mcpConnectorService } from "../services/mcp-connectors.js";
import { toolAccessService } from "../services/tool-access.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import {
  ConnectorFatalError,
  McpConnectorClient,
} from "../../../packages/mcp-connector/src/connector.js";
import type { ConnectorConfig } from "../../../packages/mcp-connector/src/config.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

const UPSTREAM_TOKEN = "connector-local-upstream-secret";
const UPSTREAM_TOOLS = [
  { name: "list_devices", description: "List devices", annotations: { readOnlyHint: true } },
  { name: "restart_device", description: "Restart a device", annotations: { readOnlyHint: false } },
  { name: "slow_read", description: "Slow read", annotations: { readOnlyHint: true } },
];

interface UpstreamRequest {
  method: string | undefined;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown> | null;
}

/**
 * A private-network MCP server stand-in on loopback. It requires the header
 * that only the connector config knows, a Streamable HTTP session, and answers
 * tools/call over an SSE stream it keeps open (the relay must not wait for EOF).
 */
async function startUpstream() {
  const requests: UpstreamRequest[] = [];
  const openResponses = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : null;
      requests.push({ method: req.method, headers: req.headers, body });
      if (req.headers["x-upstream-token"] !== UPSTREAM_TOKEN) {
        res.writeHead(401).end();
        return;
      }
      if (body?.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "upstream-session-1" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }));
        return;
      }
      if (body?.method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }
      if (req.headers["mcp-session-id"] !== "upstream-session-1") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32000, message: "session required" } }));
        return;
      }
      if (body?.method === "tools/list") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: UPSTREAM_TOOLS } }));
        return;
      }
      if (body?.method === "tools/call") {
        const params = body.params as { name: string; arguments: unknown };
        const answer = () => {
          res.write(`event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { content: [{ type: "text", text: `${params.name} ok` }], structuredContent: { tool: params.name } },
          })}\n\n`);
        };
        res.writeHead(200, { "content-type": "text/event-stream" });
        openResponses.add(res);
        res.on("close", () => openResponses.delete(res));
        if (params.name === "slow_read") setTimeout(answer, 3_000).unref();
        else answer();
        // Deliberately keep the SSE stream open.
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    requests,
    close: async () => {
      for (const res of openResponses) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describeEmbeddedPostgres("outbound MCP connector", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let hub!: McpConnectorHub;
  let paperclip!: Server;
  let paperclipUrl = "";
  let ws: ReturnType<typeof setupMcpConnectorWebSocketServer> | null = null;
  let upstream!: Awaited<ReturnType<typeof startUpstream>>;
  let tmp = "";
  const clients: McpConnectorClient[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mcp-connector-");
    db = createDb(tempDb.connectionString);
    hub = new McpConnectorHub();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      // Connector endpoints are unauthenticated at the board layer; board routes get a local operator.
      if (!req.path.startsWith("/api/mcp-connectors/")) {
        req.actor = {
          type: "board",
          userId: "board-user",
          userName: "Board User",
          userEmail: null,
          isInstanceAdmin: true,
          source: "local_implicit",
        };
      } else {
        req.actor = { type: "none", source: "none" } as unknown as Express.Request["actor"];
      }
      next();
    });
    app.use("/api", mcpConnectorRoutes(db, { hub }));
    app.use(errorHandler);
    paperclip = createServer(app);
    ws = setupMcpConnectorWebSocketServer(paperclip, db, { hub, heartbeatIntervalMs: 60_000 });
    await new Promise<void>((resolve) => paperclip.listen(0, "127.0.0.1", resolve));
    paperclipUrl = `http://127.0.0.1:${(paperclip.address() as AddressInfo).port}`;
    upstream = await startUpstream();
    tmp = mkdtempSync(join(tmpdir(), "paperclip-mcp-connector-"));
  }, 30_000);

  afterEach(async () => {
    for (const client of clients.splice(0)) client.stop();
    hub.disconnectAll();
    await db.delete(toolCallEvents);
    await db.delete(toolActionRequests);
    await db.delete(toolInvocations);
    await db.delete(toolAccessAuditEvents);
    await db.delete(activityLog);
    await db.delete(toolPolicies);
    await db.delete(toolProfileBindings);
    await db.delete(toolProfiles);
    await db.delete(toolCatalogEntries);
    await db.delete(connectionGrants);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(toolMcpConnectors);
    upstream.requests.length = 0;
  });

  afterAll(async () => {
    ws?.close();
    await upstream?.close();
    paperclip?.closeAllConnections();
    await new Promise<void>((resolve) => paperclip?.close(() => resolve()));
    rmSync(tmp, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  async function createCompany() {
    const [company] = await db
      .insert(companies)
      .values({ name: `Connector ${randomUUID()}`, issuePrefix: `MC${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning();
    await db.insert(companyMemberships).values({
      companyId: company!.id,
      principalType: "user",
      principalId: "board-user",
      status: "active",
      membershipRole: "admin",
    });
    return company!;
  }

  async function createConnector(companyId: string, name = "Homelab") {
    const response = await request(paperclip)
      .post(`/api/companies/${companyId}/tools/mcp-connectors`)
      .send({ name })
      .expect(201);
    return response.body as { connector: { id: string }; enrollmentToken: string; enrollmentExpiresAt: string };
  }

  function connectorConfig(enrollmentToken: string | null, upstreams: Record<string, string> = { unifi: upstream.url }): ConnectorConfig {
    return {
      paperclipUrl,
      enrollmentToken,
      credentialsFile: join(tmp, `${randomUUID()}.json`),
      upstreams: new Map(Object.entries(upstreams).map(([name, url]) => [
        name,
        { url, headers: { "x-upstream-token": UPSTREAM_TOKEN } },
      ])),
    };
  }

  async function startConnector(enrollmentToken: string) {
    const config = connectorConfig(enrollmentToken);
    const client = new McpConnectorClient({
      config,
      logger: process.env.DEBUG_CONNECTOR ? (level, message, fields) => console.log(level, message, fields) : () => undefined,
      backoff: { baseMs: 50, maxMs: 200 },
    });
    clients.push(client);
    let fatal: Error | null = null;
    const welcomed = new Promise<void>((resolve, reject) => {
      const running = client.run({ onWelcome: resolve });
      running.catch((error: Error) => {
        fatal = error;
        reject(error);
      });
    });
    await welcomed;
    return { client, config, fatal: () => fatal };
  }

  async function createConnectorConnection(
    service: ReturnType<typeof toolAccessService>,
    companyId: string,
    connectorId: string,
    upstreamName = "unifi",
  ) {
    return service.createConnection(companyId, {
      name: `UniFi ${randomUUID().slice(0, 6)}`,
      connectionPurpose: "tool",
      transport: "connector",
      authKind: "none",
      ownership: "customer",
      connectionKind: "managed",
      config: { connectorId, upstream: upstreamName },
      transportConfig: {},
      credentialSecretRefs: [],
      status: "draft",
    }, { actorType: "user", actorId: "board-user" });
  }

  function publicService() {
    // The instance is authenticated + public: the SSRF guard refuses private endpoints.
    return toolAccessService(db, { deploymentMode: "authenticated", deploymentExposure: "public", mcpConnectorHub: hub });
  }

  it("enrolls once with a short-lived token and stores the credential with mode 0600", async () => {
    const company = await createCompany();
    const created = await createConnector(company.id);
    expect(created.enrollmentToken).toMatch(/^pcmce_/);
    const [row] = await db.select().from(toolMcpConnectors).where(eq(toolMcpConnectors.id, created.connector.id));
    expect(row!.enrollmentTokenHash).not.toContain(created.enrollmentToken);
    expect(JSON.stringify(row)).not.toContain(created.enrollmentToken);

    const config = connectorConfig(created.enrollmentToken);
    const client = new McpConnectorClient({ config, logger: () => undefined });
    const credentials = await client.ensureCredentials();
    expect(credentials.credential).toMatch(/^pcmcc_/);
    expect(statSync(config.credentialsFile).mode & 0o777).toBe(0o600);
    const [active] = await db.select().from(toolMcpConnectors).where(eq(toolMcpConnectors.id, created.connector.id));
    expect(active!.status).toBe("active");
    expect(active!.credentialHash).not.toBe(credentials.credential);

    // Single use.
    await request(paperclip).post(MCP_CONNECTOR_ENROLL_PATH).send({ token: created.enrollmentToken }).expect(401);

    // Expiry.
    const second = await createConnector(company.id, "Office");
    await db.update(toolMcpConnectors)
      .set({ enrollmentExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(toolMcpConnectors.id, second.connector.id));
    const expired = await request(paperclip).post(MCP_CONNECTOR_ENROLL_PATH).send({ token: second.enrollmentToken }).expect(401);
    expect(expired.body.error ?? "").not.toContain(second.enrollmentToken);

    // Activity never records token or credential material.
    const activity = await db.select().from(activityLog).where(eq(activityLog.companyId, company.id));
    expect(activity.map((entry) => entry.action)).toEqual(expect.arrayContaining([
      "tool_mcp_connector.created",
      "tool_mcp_connector.enrolled",
    ]));
    const serialized = JSON.stringify(activity);
    expect(serialized).not.toContain(created.enrollmentToken);
    expect(serialized).not.toContain(credentials.credential);
  });

  it("rotates the credential through the real actor middleware and logs no token bodies", async () => {
    const company = await createCompany();
    const created = await createConnector(company.id);
    const client = new McpConnectorClient({ config: connectorConfig(created.enrollmentToken), logger: () => undefined });
    const { credential } = await client.ensureCredentials();

    // Production auth middleware must not treat the connector credential as an agent or board key.
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
    app.use("/api", mcpConnectorRoutes(db, { hub }));
    app.use(errorHandler);
    const rotated = await request(app).post(MCP_CONNECTOR_ROTATE_PATH).set("authorization", `Bearer ${credential}`).expect(200);
    expect(rotated.body.credential).toMatch(/^pcmcc_/);
    expect(rotated.body.credential).not.toBe(credential);
    await request(app).post(MCP_CONNECTOR_ROTATE_PATH).set("authorization", `Bearer ${credential}`).expect(401);
    await request(app).post(MCP_CONNECTOR_ENROLL_PATH).send({ token: created.enrollmentToken }).expect(401);

    expect(isSecretSensitiveHttpRequest("POST", MCP_CONNECTOR_ENROLL_PATH)).toBe(true);
    expect(isSecretSensitiveHttpRequest("POST", MCP_CONNECTOR_ROTATE_PATH)).toBe(true);
  });

  it("rate-limits unauthenticated enrollment attempts per client before touching the database", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", mcpConnectorRoutes(db, { hub, enrollRateLimiter: createInviteRateLimiter({ maxRequests: 2 }) }));
    app.use(errorHandler);
    const token = "pcmce_" + "a".repeat(40);
    await request(app).post(MCP_CONNECTOR_ENROLL_PATH).send({ token }).expect(401);
    await request(app).post(MCP_CONNECTOR_ENROLL_PATH).send({ token }).expect(401);
    const limited = await request(app).post(MCP_CONNECTOR_ENROLL_PATH).send({ token }).expect(429);
    expect(limited.headers["retry-after"]).toBeDefined();
  });

  it("runs health checks and catalog refresh over the connector while the SSRF guard still refuses the same upstream", async () => {
    const company = await createCompany();
    const created = await createConnector(company.id);
    await startConnector(created.enrollmentToken);
    const service = publicService();

    // The existing guard is unchanged: the server itself cannot reach the loopback upstream.
    await expect(service.createConnection(company.id, {
      name: "Direct loopback",
      connectionPurpose: "tool",
      transport: "mcp_remote",
      authKind: "none",
      ownership: "customer",
      connectionKind: "managed",
      config: { url: upstream.url },
      transportConfig: {},
      credentialSecretRefs: [],
    })).rejects.toMatchObject({ details: { code: "remote_http_private_endpoint" } });

    // A connector connection addresses the upstream by name only; URLs are refused.
    await expect(service.createConnection(company.id, {
      name: "URL smuggling",
      connectionPurpose: "tool",
      transport: "connector",
      authKind: "none",
      ownership: "customer",
      connectionKind: "managed",
      config: { connectorId: created.connector.id, upstream: "unifi", url: "http://169.254.169.254/" },
      transportConfig: {},
      credentialSecretRefs: [],
    })).rejects.toMatchObject({ details: { code: "connector_url_not_allowed" } });

    const connection = await createConnectorConnection(service, company.id, created.connector.id);
    const refreshed = await service.refreshCatalog(connection.id);
    expect(refreshed.discoveredCount).toBe(3);
    expect(refreshed.catalog.find((entry) => entry.toolName === "list_devices")?.riskLevel).toBe("read");
    expect(refreshed.catalog.find((entry) => entry.toolName === "restart_device")?.riskLevel).toBe("write");
    const health = await service.checkHealth(connection.id);
    expect(health.connection.healthStatus).toBe("ok");
    expect(health.connection.healthMessage).toBe("MCP connector upstream responded to tools/list.");

    // The connector added its local credential and carried the upstream session.
    expect(upstream.requests.every((entry) => entry.headers["x-upstream-token"] === UPSTREAM_TOKEN)).toBe(true);
    expect(upstream.requests.some((entry) => entry.headers["mcp-session-id"] === "upstream-session-1")).toBe(true);
    // Paperclip never learned the upstream URL.
    const [stored] = await db.select().from(toolMcpConnectors).where(eq(toolMcpConnectors.id, created.connector.id));
    expect(stored!.upstreams).toEqual(["unifi"]);
    expect(JSON.stringify(stored)).not.toContain(upstream.url);
    const [connectionRow] = await db.select().from(toolConnections).where(eq(toolConnections.id, connection.id));
    expect(JSON.stringify(connectionRow)).not.toContain(upstream.url);
  });

  it("allows a read call and blocks a write call by policy, auditing both", async () => {
    const company = await createCompany();
    const created = await createConnector(company.id);
    await startConnector(created.enrollmentToken);
    const service = publicService();
    const connection = await createConnectorConnection(service, company.id, created.connector.id);
    await service.refreshCatalog(connection.id);
    await db.update(toolConnections).set({ status: "active", enabled: true }).where(eq(toolConnections.id, connection.id));

    const [agent] = await db.insert(agents).values({
      companyId: company.id,
      name: `Agent ${randomUUID()}`,
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    }).returning();
    const [project] = await db.insert(projects).values({ companyId: company.id, name: "Ops" }).returning();
    const [issue] = await db.insert(issues).values({
      companyId: company.id,
      projectId: project!.id,
      title: "Check network",
      status: "in_progress",
      assigneeAgentId: agent!.id,
    }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: company.id,
      agentId: agent!.id,
      invocationSource: "assignment",
      status: "running",
      contextSnapshot: { issueId: issue!.id, projectId: project!.id },
    }).returning();
    const [profile] = await db.insert(toolProfiles).values({
      companyId: company.id,
      profileKey: `all-${randomUUID()}`,
      name: "All tools",
      defaultAction: "allow",
    }).returning();
    await db.insert(toolProfileBindings).values({
      companyId: company.id,
      profileId: profile!.id,
      targetType: "agent",
      targetId: agent!.id,
    });
    await db.insert(toolPolicies).values({
      companyId: company.id,
      name: "Block network writes",
      policyType: "block",
      selectors: { connectionId: connection.id, riskLevels: ["write", "destructive"] },
      priority: 10,
    });

    const gateway = createToolGatewayService(db, {
      toolActionSigningSecret: "test-signing-secret",
      mcpConnectorHub: hub,
    });
    const session = await gateway.createSession({ companyId: company.id, agentId: agent!.id, runId: run!.id });
    const tools = (await gateway.listToolsForSession(session.token)).filter((tool) => tool.connectionId === connection.id);
    const read = tools.find((tool) => tool.upstreamToolName === "list_devices")!;
    expect(read.providerType).toBe("mcp_remote_http");
    // The block policy already hides the write tool from the agent's tool list.
    expect(tools.some((tool) => tool.upstreamToolName === "restart_device")).toBe(false);
    const writeName = read.name.replace(/:list-devices$/, ":restart-device");

    const result = await gateway.executeTool({ sessionToken: session.token, tool: read.name, parameters: {} });
    expect(result.status).toBe("completed");
    expect(JSON.stringify(result.result)).toContain("list_devices ok");

    const callsBefore = upstream.requests.filter((entry) => entry.body?.method === "tools/call").length;
    await expect(gateway.executeTool({ sessionToken: session.token, tool: writeName, parameters: { id: "ap-1" } }))
      .rejects.toMatchObject({ status: 403 });
    expect(upstream.requests.filter((entry) => entry.body?.method === "tools/call").length).toBe(callsBefore);

    const events = await db.select().from(toolCallEvents).where(and(
      eq(toolCallEvents.companyId, company.id),
      eq(toolCallEvents.connectionId, connection.id),
    ));
    expect(events.some((event) => event.decision === "allow" && event.outcome === "success")).toBe(true);
    expect(events.some((event) => event.decision === "deny" && event.outcome === "denied")).toBe(true);
  });

  it("refuses an upstream name the connector does not publish", async () => {
    const company = await createCompany();
    const created = await createConnector(company.id);
    await startConnector(created.enrollmentToken);
    const service = publicService();
    const connection = await createConnectorConnection(service, company.id, created.connector.id, "not-configured");
    await expect(service.checkHealth(connection.id)).rejects.toMatchObject({
      status: 422,
      details: { code: "connector_upstream_unknown" },
    });
    expect(upstream.requests).toHaveLength(0);
  });

  it("reports connector_offline when the connector is not connected", async () => {
    const company = await createCompany();
    const created = await createConnector(company.id);
    const { client } = await startConnector(created.enrollmentToken);
    const service = publicService();
    const connection = await createConnectorConnection(service, company.id, created.connector.id);
    await service.checkHealth(connection.id);
    client.stop();
    await waitFor(() => !hub.isOnline(created.connector.id));

    await expect(service.checkHealth(connection.id)).rejects.toMatchObject({
      status: 503,
      details: { code: "connector_offline" },
    });
    const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, connection.id));
    expect(row!.healthStatus).toBe("degraded");
    expect(row!.healthMessage).toBe("The MCP connector for this connection is offline.");

    const listed = await request(paperclip).get(`/api/companies/${company.id}/tools/mcp-connectors`).expect(200);
    expect(listed.body.connectors[0]).toMatchObject({ id: created.connector.id, online: false, upstreams: ["unifi"] });
  });

  it("revoking closes the session, fails in-flight calls and stops the connector", async () => {
    const company = await createCompany();
    const created = await createConnector(company.id);
    const running = await startConnector(created.enrollmentToken);
    const service = publicService();
    const connection = await createConnectorConnection(service, company.id, created.connector.id);
    await service.refreshCatalog(connection.id);

    const listed = await request(paperclip).get(`/api/companies/${company.id}/tools/mcp-connectors`).expect(200);
    expect(listed.body.connectors[0]).toMatchObject({ online: true, version: "0.1.0", upstreams: ["unifi"] });

    // An in-flight call against the slow tool.
    const inFlight = hub.request({
      companyId: company.id,
      connectorId: created.connector.id,
      upstream: "unifi",
      init: {
        method: "POST",
        headers: { "content-type": "application/json", "mcp-session-id": "upstream-session-1" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "slow-1", method: "tools/call", params: { name: "slow_read", arguments: {} } }),
      },
    });
    const inFlightOutcome = inFlight.then(() => null, (error: unknown) => error);
    await waitFor(() => upstream.requests.some((entry) => (entry.body?.params as { name?: string } | undefined)?.name === "slow_read"));

    await request(paperclip)
      .post(`/api/companies/${company.id}/tools/mcp-connectors/${created.connector.id}/revoke`)
      .expect(200);
    expect(await inFlightOutcome).toMatchObject({ code: "connector_revoked" });
    expect(hub.isOnline(created.connector.id)).toBe(false);
    await waitFor(() => running.fatal() instanceof ConnectorFatalError);

    await expect(service.checkHealth(connection.id)).rejects.toMatchObject({
      details: { code: "connector_revoked" },
    });
    // The old credential can no longer open a session.
    const credentialsClient = new McpConnectorClient({
      config: { ...connectorConfig(null), credentialsFile: running.config.credentialsFile },
      logger: () => undefined,
    });
    await expect(credentialsClient.run()).rejects.toBeInstanceOf(ConnectorFatalError);
  });

  it("re-enrolling invalidates the old session immediately and blocks further requests", async () => {
    const company = await createCompany();
    const created = await createConnector(company.id);
    const running = await startConnector(created.enrollmentToken);
    const service = publicService();
    const connection = await createConnectorConnection(service, company.id, created.connector.id);
    await service.checkHealth(connection.id);

    expect(hub.isOnline(created.connector.id)).toBe(true);

    const reenrollRes = await request(paperclip)
      .post(`/api/companies/${company.id}/tools/mcp-connectors/${created.connector.id}/reenroll`)
      .expect(200);
    expect(reenrollRes.body.enrollmentToken).toBeDefined();

    // Session is disconnected immediately
    expect(hub.isOnline(created.connector.id)).toBe(false);

    // Any relayed request is rejected because the connector status is pending, not active
    await expect(hub.request({
      companyId: company.id,
      connectorId: created.connector.id,
      upstream: "unifi",
      init: { method: "POST", body: "{}" },
    })).rejects.toMatchObject({ code: "connector_revoked" });

    // Verifier refuses pending status and non-matching credentials
    const connectors = mcpConnectorService(db);
    const verification = await connectors.verify({
      connectorId: created.connector.id,
      companyId: company.id,
      credential: "pcmcc_dummy_credential",
    });
    expect(verification).toBe("revoked");

    running.client.stop();
  });

  it("never serves another company's connections", async () => {
    const owner = await createCompany();
    const other = await createCompany();
    const created = await createConnector(owner.id);
    await startConnector(created.enrollmentToken);
    const service = publicService();

    await expect(createConnectorConnection(service, other.id, created.connector.id)).rejects.toMatchObject({
      details: { code: "connector_not_found" },
    });

    // Even a row written around the API cannot borrow the session.
    const [application] = await db.insert(toolApplications).values({
      companyId: other.id,
      applicationKey: `borrowed-${randomUUID().slice(0, 8)}`,
      name: "Borrowed",
      type: "mcp_http",
      status: "active",
    }).returning();
    const [foreign] = await db.insert(toolConnections).values({
      companyId: other.id,
      applicationId: application!.id,
      name: "Borrowed connector",
      uid: `test/${randomUUID()}`,
      transport: "connector",
      status: "active",
      enabled: true,
      config: { connectorId: created.connector.id, upstream: "unifi" },
      transportConfig: {},
    }).returning();
    await expect(service.checkHealth(foreign!.id)).rejects.toMatchObject({
      details: { code: "connector_not_found" },
    });
    await expect(hub.request({
      companyId: other.id,
      connectorId: created.connector.id,
      upstream: "unifi",
      init: { method: "POST", body: "{}" },
    })).rejects.toMatchObject({ code: "connector_not_found" });
    expect(upstream.requests).toHaveLength(0);

    await request(paperclip)
      .post(`/api/companies/${other.id}/tools/mcp-connectors/${created.connector.id}/revoke`)
      .expect(404);
    expect(hub.isOnline(created.connector.id)).toBe(true);
  });

  it("does not disconnect a newer replaced session if an older session verification is rejected", async () => {
    const company = await createCompany();
    const fakeSocket1 = { close: vi.fn(), send: vi.fn() } as unknown as WebSocket;
    const fakeSocket2 = { close: vi.fn(), send: vi.fn() } as unknown as WebSocket;

    const s1 = hub.attach({
      connectorId: "connector-test",
      companyId: company.id,
      socket: fakeSocket1,
      version: "0.1.0",
      upstreams: new Set(["unifi"]),
      credential: "cred-old",
    });

    const s2 = hub.attach({
      connectorId: "connector-test",
      companyId: company.id,
      socket: fakeSocket2,
      version: "0.1.0",
      upstreams: new Set(["unifi"]),
      credential: "cred-new",
    });

    expect(hub.isOnline("connector-test")).toBe(true);
    expect(hub.session("connector-test")).toBe(s2);

    // Revoking the old session s1 should NOT disconnect s2
    hub.disconnect("connector-test", "revoked", s1);
    expect(hub.isOnline("connector-test")).toBe(true);
    expect(hub.session("connector-test")).toBe(s2);

    // Targetless revocation disconnects whatever is currently active
    hub.disconnect("connector-test", "revoked");
    expect(hub.isOnline("connector-test")).toBe(false);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
