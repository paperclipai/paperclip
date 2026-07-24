import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pluginManifestV1Schema, type PaperclipPluginManifestV1 } from "@paperclipai/shared";

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
    capabilities: ["api.routes.register"],
    entrypoints: { worker: "dist/worker.js" },
    apiRoutes,
  };
}

async function createApp(input: {
  actor: Record<string, unknown>;
  plugin?: Record<string, unknown> | null;
  workerRunning?: boolean;
  workerResult?: unknown;
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
      {} as never,
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

describe.sequential("plugin scoped API routes", () => {
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
