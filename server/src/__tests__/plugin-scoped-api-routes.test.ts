import express from "express";
import { createServer, request as httpRequest, type Server } from "node:http";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { setupPluginApiWebSocketServer } from "../realtime/plugin-api-ws.js";

// Keep a real upstream WebSocket and byte stream; only TLS is replaced locally.
vi.mock("node:https", () => ({ request: (url: URL, options: object) => {
  const local = new URL(url); local.protocol = "http:";
  return httpRequest(local, options);
} }));
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pluginManifestV1Schema, type PaperclipPluginManifestV1 } from "@paperclipai/shared";

const mockAccess = vi.hoisted(() => ({ decide: vi.fn().mockResolvedValue({ allowed: true }) }));
vi.mock("../services/authorization.js", () => ({ authorizationService: () => mockAccess }));

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
}));

const mockLifecycle = vi.hoisted(() => ({
  load: vi.fn(),
  upgrade: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => mockLifecycle,
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => mockIssueService,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(),
}));

vi.mock("../services/live-events.js", () => ({
  publishGlobalLiveEvent: vi.fn(),
}));

function manifest(apiRoutes: NonNullable<PaperclipPluginManifestV1["apiRoutes"]>): PaperclipPluginManifestV1 {
  return {
    id: "paperclip.scoped-api-test",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Scoped API Test",
    description: "Test plugin for scoped API routes",
    author: "Paperclip",
    categories: ["automation"],
    capabilities: ["api.routes.register", "http.outbound"],
    entrypoints: { worker: "dist/worker.js" },
    apiRoutes,
  };
}

async function createApp(input: {
  actor: Record<string, unknown>;
  plugin?: Record<string, unknown> | null;
  workerRunning?: boolean;
  workerResult?: unknown;
  db?: unknown;
}) {
  const [{ pluginRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/plugins.js"),
    import("../middleware/index.js"),
  ]);

  const workerManager = {
    isRunning: vi.fn().mockReturnValue(input.workerRunning ?? true),
    call: vi.fn().mockResolvedValue(input.workerResult ?? { status: 200, body: { ok: true } }),
  };

  mockRegistry.getById.mockResolvedValue(input.plugin ?? null);
  mockRegistry.getByKey.mockResolvedValue(input.plugin ?? null);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = input.actor as typeof req.actor;
    next();
  });
  app.use(
    "/api",
    pluginRoutes(
      (input.db ?? {}) as never,
      { installPlugin: vi.fn() } as never,
      undefined,
      undefined,
      undefined,
      { workerManager } as never,
    ),
  );
  app.use(errorHandler);

  return { app, workerManager };
}

describe("plugin scoped API routes", () => {
  const pluginId = "11111111-1111-4111-8111-111111111111";
  const companyId = "22222222-2222-4222-8222-222222222222";
  const agentId = "33333333-3333-4333-8333-333333333333";
  const peerAgentId = "33333333-3333-4333-8333-333333333334";
  const runId = "44444444-4444-4444-8444-444444444444";
  const issueId = "55555555-5555-4555-8555-555555555555";

  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(null);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({
      id: issueId,
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      adoptedFromRunId: null,
    });
  });

  it("dispatches a board GET route with params, query, actor, and company context", async () => {
    const apiRoutes = manifest([
      {
        routeKey: "summary.get",
        method: "GET",
        path: "/companies/:companySlug/summary",
        auth: "board",
        capability: "api.routes.register",
        companyResolution: { from: "query", key: "companyId" },
      },
    ]);
    const { app, workerManager } = await createApp({
      actor: {
        type: "board",
        userId: "user-1",
        source: "local_implicit",
        isInstanceAdmin: true,
      },
      plugin: {
        id: pluginId,
        pluginKey: apiRoutes.id,
        status: "ready",
        manifestJson: apiRoutes,
      },
      workerResult: { status: 201, body: { handled: true } },
    });

    const res = await request(app)
      .get(`/api/plugins/${pluginId}/api/companies/acme/summary?companyId=${companyId}&view=compact`)
      .set("Authorization", "Bearer should-not-forward");

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ handled: true });
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "handleApiRequest", expect.objectContaining({
      routeKey: "summary.get",
      method: "GET",
      params: { companySlug: "acme" },
      query: { companyId, view: "compact" },
      companyId,
      actor: expect.objectContaining({ actorType: "user", actorId: "user-1" }),
    }));
    expect(workerManager.call.mock.calls[0]?.[2].headers.authorization).toBeUndefined();
  });

  it("only forwards allowlisted response headers from plugin routes", async () => {
    const apiRoutes = manifest([
      {
        routeKey: "summary.get",
        method: "GET",
        path: "/companies/:companySlug/summary",
        auth: "board",
        capability: "api.routes.register",
        companyResolution: { from: "query", key: "companyId" },
      },
    ]);
    const { app } = await createApp({
      actor: {
        type: "board",
        userId: "user-1",
        source: "local_implicit",
        isInstanceAdmin: true,
      },
      plugin: {
        id: pluginId,
        pluginKey: apiRoutes.id,
        status: "ready",
        manifestJson: apiRoutes,
      },
      workerResult: {
        status: 200,
        body: { handled: true },
        headers: {
          "cache-control": "no-store",
          "content-security-policy": "default-src 'none'",
          location: "https://example.invalid",
          "x-request-id": "plugin-request",
        },
      },
    });

    const res = await request(app)
      .get(`/api/plugins/${pluginId}/api/companies/acme/summary?companyId=${companyId}`);

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-request-id"]).toBe("plugin-request");
    expect(res.headers["content-security-policy"]).toBeUndefined();
    expect(res.headers.location).toBeUndefined();
  });

  it("enforces agent checkout ownership before dispatching issue-scoped POST routes", async () => {
    const apiRoutes = manifest([
      {
        routeKey: "issue.advance",
        method: "POST",
        path: "/issues/:issueId/advance",
        auth: "agent",
        capability: "api.routes.register",
        checkoutPolicy: "required-for-agent-in-progress",
        companyResolution: { from: "issue", param: "issueId" },
      },
    ]);
    mockIssueService.getById.mockResolvedValue({
      id: issueId,
      companyId,
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    const { app, workerManager } = await createApp({
      actor: {
        type: "agent",
        agentId,
        companyId,
        runId,
        source: "agent_key",
      },
      plugin: {
        id: pluginId,
        pluginKey: apiRoutes.id,
        status: "ready",
        manifestJson: apiRoutes,
      },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/api/issues/${issueId}/advance`)
      .send({ step: "next" });

    expect(res.status).toBe(200);
    expect(mockIssueService.assertCheckoutOwner).toHaveBeenCalledWith(issueId, agentId, runId);
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "handleApiRequest", expect.objectContaining({
      routeKey: "issue.advance",
      params: { issueId },
      body: { step: "next" },
      actor: expect.objectContaining({ actorType: "agent", agentId, runId }),
      companyId,
    }));
  });

  it("allows non-assignee agents on in-progress required checkout routes without claiming checkout ownership", async () => {
    const apiRoutes = manifest([
      {
        routeKey: "issue.advance",
        method: "POST",
        path: "/issues/:issueId/advance",
        auth: "agent",
        capability: "api.routes.register",
        checkoutPolicy: "required-for-agent-in-progress",
        companyResolution: { from: "issue", param: "issueId" },
      },
    ]);
    mockIssueService.getById.mockResolvedValue({
      id: issueId,
      companyId,
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    const { app, workerManager } = await createApp({
      actor: {
        type: "agent",
        agentId: peerAgentId,
        companyId,
        runId,
        source: "agent_key",
      },
      plugin: {
        id: pluginId,
        pluginKey: apiRoutes.id,
        status: "ready",
        manifestJson: apiRoutes,
      },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/api/issues/${issueId}/advance`)
      .send({ step: "next" });

    expect(res.status).toBe(200);
    expect(mockIssueService.assertCheckoutOwner).not.toHaveBeenCalled();
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "handleApiRequest", expect.objectContaining({
      routeKey: "issue.advance",
      params: { issueId },
      body: { step: "next" },
      actor: expect.objectContaining({ actorType: "agent", agentId: peerAgentId, runId }),
      companyId,
    }));
  });

  it("rejects checkout-protected agent routes without a run id before worker dispatch", async () => {
    const apiRoutes = manifest([
      {
        routeKey: "issue.advance",
        method: "POST",
        path: "/issues/:issueId/advance",
        auth: "agent",
        capability: "api.routes.register",
        checkoutPolicy: "required-for-agent-in-progress",
        companyResolution: { from: "issue", param: "issueId" },
      },
    ]);
    mockIssueService.getById.mockResolvedValue({
      id: issueId,
      companyId,
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    const { app, workerManager } = await createApp({
      actor: {
        type: "agent",
        agentId,
        companyId,
        source: "agent_key",
      },
      plugin: {
        id: pluginId,
        pluginKey: apiRoutes.id,
        status: "ready",
        manifestJson: apiRoutes,
      },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/api/issues/${issueId}/advance`)
      .send({});

    expect(res.status).toBe(401);
    expect(workerManager.call).not.toHaveBeenCalled();
  });

  it("rejects checkout-protected agent routes when the active checkout belongs to another run", async () => {
    const apiRoutes = manifest([
      {
        routeKey: "issue.advance",
        method: "POST",
        path: "/issues/:issueId/advance",
        auth: "agent",
        capability: "api.routes.register",
        checkoutPolicy: "always-for-agent",
        companyResolution: { from: "issue", param: "issueId" },
      },
    ]);
    mockIssueService.getById.mockResolvedValue({
      id: issueId,
      companyId,
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    const conflict = new Error("Issue run ownership conflict") as Error & { status?: number };
    conflict.status = 409;
    mockIssueService.assertCheckoutOwner.mockRejectedValue(conflict);
    const { app, workerManager } = await createApp({
      actor: {
        type: "agent",
        agentId,
        companyId,
        runId,
        source: "agent_key",
      },
      plugin: {
        id: pluginId,
        pluginKey: apiRoutes.id,
        status: "ready",
        manifestJson: apiRoutes,
      },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/api/issues/${issueId}/advance`)
      .send({});

    expect(res.status).toBe(409);
    expect(workerManager.call).not.toHaveBeenCalled();
  });

  it("returns a clear error for disabled plugins without worker dispatch", async () => {
    const apiRoutes = manifest([
      {
        routeKey: "summary.get",
        method: "GET",
        path: "/summary",
        auth: "board",
        capability: "api.routes.register",
        companyResolution: { from: "query", key: "companyId" },
      },
    ]);
    const { app, workerManager } = await createApp({
      actor: {
        type: "board",
        userId: "user-1",
        source: "local_implicit",
        isInstanceAdmin: true,
      },
      plugin: {
        id: pluginId,
        pluginKey: apiRoutes.id,
        status: "disabled",
        manifestJson: apiRoutes,
      },
    });

    const res = await request(app)
      .get(`/api/plugins/${pluginId}/api/summary?companyId=${companyId}`);

    expect(res.status).toBe(503);
    expect(res.body.error).toContain("disabled");
    expect(workerManager.call).not.toHaveBeenCalled();
  });

  it("returns a clear error when a ready plugin has no running worker", async () => {
    const apiRoutes = manifest([
      {
        routeKey: "summary.get",
        method: "GET",
        path: "/summary",
        auth: "board",
        capability: "api.routes.register",
        companyResolution: { from: "query", key: "companyId" },
      },
    ]);
    const { app, workerManager } = await createApp({
      actor: {
        type: "board",
        userId: "user-1",
        source: "local_implicit",
        isInstanceAdmin: true,
      },
      plugin: {
        id: pluginId,
        pluginKey: apiRoutes.id,
        status: "ready",
        manifestJson: apiRoutes,
      },
      workerRunning: false,
    });

    const res = await request(app)
      .get(`/api/plugins/${pluginId}/api/summary?companyId=${companyId}`);

    expect(res.status).toBe(503);
    expect(res.body.error).toContain("worker is not running");
    expect(workerManager.call).not.toHaveBeenCalled();
  });

  it("rejects manifest routes that try to claim core API paths", () => {
    const result = pluginManifestV1Schema.safeParse(manifest([
      {
        routeKey: "bad.shadow",
        method: "POST",
        path: "/api/issues/:issueId",
        auth: "board",
        capability: "api.routes.register",
      },
    ]));

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected manifest validation to fail");
    expect(result.error.issues.map((issue) => issue.message).join("\n")).toContain(
      "path must stay inside the plugin api namespace",
    );
  });
});


describe("plugin browser WebSockets", () => {
  const companyId = "22222222-2222-4222-8222-222222222222";
  const pluginId = "11111111-1111-4111-8111-111111111111";
  const apiRoutes = manifest([{ routeKey: "channel.connect", method: "GET", path: "/channels/:channelId", transport: "websocket", auth: "board", capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" } }]);
  const plugin = { id: pluginId, pluginKey: apiRoutes.id, status: "ready", manifestJson: apiRoutes };
  const board = { type: "board", userId: "user-1", source: "local_implicit", isInstanceAdmin: true };
  const endpoint = `/api/plugins/${pluginId}/api/channels/build-output?companyId=${companyId}`;
  async function listen(server: Server) {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }
  async function rejection(actor: Record<string, unknown>, origin?: string) {
    const { app, workerManager } = await createApp({ actor, plugin });
    const server = createServer(app); setupPluginApiWebSocketServer(server, app);
    const base = await listen(server);
    try {
      return await new Promise<{ status: number; calls: number }>((resolve, reject) => {
        const ws = new WebSocket(`${base}${endpoint}`, origin ? { origin } : {});
        ws.on("unexpected-response", (_request, response) => { response.resume(); resolve({ status: response.statusCode!, calls: workerManager.call.mock.calls.length }); });
        ws.on("error", reject);
      });
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
  it("rejects missing/bad Origin, anonymous callers and agents before worker dispatch", async () => {
    expect(await rejection(board)).toEqual({ status: 403, calls: 0 });
    expect(await rejection(board, "https://attacker.test")).toEqual({ status: 403, calls: 0 });
    expect(await rejection({ type: "none" }, "http://localhost:3100")).toEqual({ status: 403, calls: 0 });
    expect(await rejection({ type: "agent", agentId: "agent", companyId }, "http://localhost:3100")).toEqual({ status: 403, calls: 0 });
  });
  it("never exposes a worker's upstream credentials over ordinary HTTP", async () => {
    const { app, workerManager } = await createApp({ actor: board, plugin, workerResult: { websocket: { url: "wss://private.test", headers: { Authorization: "fixture-secret" } } } });
    const response = await request(app).get(endpoint);
    expect(response.status).toBe(426);
    expect(response.text).not.toContain("fixture-secret");
    expect(workerManager.call).not.toHaveBeenCalled();
  });
  it.each(["build-output", "metrics"])("proxies text and binary %s channels without resource or protocol assumptions", async (channelId) => {
    const upstream = createServer();
    const upstreamWs = new WebSocketServer({ noServer: true });
    let upstreamHeaders: Record<string, unknown> = {};
    upstream.on("upgrade", (req, socket, head) => { upstreamHeaders = req.headers; upstreamWs.handleUpgrade(req, socket, head, ws => upstreamWs.emit("connection", ws)); });
    upstreamWs.on("connection", ws => { ws.on("message", (bytes, isBinary) => ws.send(bytes, { binary: isBinary })); });
    const upstreamBase = await listen(upstream);
    const { app, workerManager } = await createApp({ actor: board, plugin, workerResult: { websocket: { url: upstreamBase.replace("http:", "wss:") + `/channels/${channelId}`, headers: { Authorization: "Bearer fixture-only" } } } });
    const server = createServer(app); setupPluginApiWebSocketServer(server, app);
    const base = await listen(server);
    const ws = new WebSocket(`${base}${endpoint.replace("build-output", channelId)}`, { origin: "http://localhost:3100", headers: { Cookie: "browser=fixture", Authorization: "browser-only" } });
    try {
      await once(ws, "open");
      const payload = Buffer.from([0, 1, 127, 128, 255]);
      const reply = once(ws, "message"); ws.send(payload);
      const binaryReply = await reply;
      expect(binaryReply[0]).toEqual(payload);
      expect(binaryReply[1]).toBe(true);
      const event = JSON.stringify({ event: "progress", value: 42 });
      const textReply = once(ws, "message"); ws.send(event);
      const [text, isBinary] = await textReply;
      expect(text.toString()).toBe(event);
      expect(isBinary).toBe(false);
      expect(workerManager.call).toHaveBeenCalledWith(pluginId, "handleApiRequest", expect.objectContaining({ routeKey: "channel.connect", params: { channelId }, companyId }));
      expect(upstreamHeaders.authorization).toBe("Bearer fixture-only");
      expect(upstreamHeaders.cookie).toBeUndefined();
      expect(upstreamHeaders.origin).toBeUndefined();
      const remote = [...upstreamWs.clients][0];
      const closed = once(remote, "close"); ws.close(); await closed;
    } finally {
      ws.terminate(); for (const client of upstreamWs.clients) client.terminate();
      upstreamWs.close(); server.closeAllConnections(); upstream.closeAllConnections();
      await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))]);
    }
  });
  it("only permits declared board GET WebSockets", () => {
    expect(pluginManifestV1Schema.safeParse(apiRoutes).success).toBe(true);
    const bad = structuredClone(apiRoutes); bad.apiRoutes![0].auth = "agent";
    expect(pluginManifestV1Schema.safeParse(bad).success).toBe(false);
  });
});

it("agent-scoped plugin routes reuse agent:read and refuse denied access before worker dispatch", async () => {
  const agentId = "33333333-3333-4333-8333-333333333333", companyId = "22222222-2222-4222-8222-222222222222", pluginId = "11111111-1111-4111-8111-111111111111";
  const chain = { from: () => chain, where: () => chain, limit: vi.fn(async () => [{ id: agentId, companyId }]) };
  const apiRoutes = manifest([{ routeKey: "status", method: "GET", path: "/agents/:agentId/status", auth: "board", capability: "api.routes.register", companyResolution: { from: "agent", param: "agentId" } }]);
  const actor: Record<string, unknown> = { type: "board", source: "local_implicit", userId: "user", isInstanceAdmin: true };
  const { app, workerManager } = await createApp({ db: { select: () => chain }, actor, plugin: { id: pluginId, pluginKey: apiRoutes.id, status: "ready", manifestJson: apiRoutes } });
  mockAccess.decide.mockResolvedValue({ allowed: true });
  expect((await request(app).get(`/api/plugins/${pluginId}/api/agents/${agentId}/status`)).status).toBe(200);
  expect(mockAccess.decide).toHaveBeenCalledWith(expect.objectContaining({ action: "agent:read", resource: { type: "agent", companyId, agentId } }));
  workerManager.call.mockClear(); mockAccess.decide.mockResolvedValue({ allowed: false });
  expect((await request(app).get(`/api/plugins/${pluginId}/api/agents/${agentId}/status`)).status).toBe(404);
  actor.source = "session"; actor.companyIds = ["another-company"];
  const crossCompany = await request(app).get(`/api/plugins/${pluginId}/api/agents/${agentId}/status`);
  chain.limit.mockResolvedValue([]);
  const missing = await request(app).get(`/api/plugins/${pluginId}/api/agents/${agentId}/status`);
  expect(crossCompany.status).toBe(404);
  expect(crossCompany.body).toEqual(missing.body);
  expect(workerManager.call).not.toHaveBeenCalled();
});
