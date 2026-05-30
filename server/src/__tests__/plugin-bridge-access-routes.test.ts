import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { pluginRoutes } from "../routes/plugins.js";
import { errorHandler } from "../middleware/index.js";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
}));

const mockLifecycle = vi.hoisted(() => ({
  load: vi.fn(),
}));

const mockWorkerManager = vi.hoisted(() => ({
  call: vi.fn(),
  getWorker: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => mockLifecycle,
}));

vi.mock("../services/plugin-loader.js", () => ({
  pluginLoader: () => ({}),
  getPluginUiContributionMetadata: vi.fn(() => null),
}));

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use(
    "/api",
    pluginRoutes(
      {} as any,
      {} as any,
      undefined,
      undefined,
      undefined,
      { workerManager: mockWorkerManager as any },
    ),
  );
  app.use(errorHandler);
  return app;
}

describe("plugin bridge access routes", () => {
  beforeEach(() => {
    vi.resetModules();
    mockRegistry.getById.mockReset();
    mockRegistry.getByKey.mockReset();
    mockLifecycle.load.mockReset();
    mockWorkerManager.call.mockReset();
    mockWorkerManager.getWorker.mockReset();
  });

  it("allows company-scoped agents to read manager-state through the plugin bridge", async () => {
    mockRegistry.getById.mockResolvedValue(null);
    mockRegistry.getByKey.mockResolvedValue({
      id: "plugin-1",
      pluginKey: "blueprint.automation",
      status: "ready",
      manifestJson: { id: "blueprint.automation" },
      version: "0.1.0",
      displayName: "Blueprint Automation",
    });
    mockWorkerManager.call.mockResolvedValue({
      content: "manager state",
      data: { ok: true, kind: "manager-state" },
    });

    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/plugins/blueprint.automation/actions/manager-state")
      .send({
        companyId: "company-1",
        params: { companyName: "Blueprint Autonomous Operations" },
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      content: "manager state",
      data: { ok: true, kind: "manager-state" },
    });
    expect(mockWorkerManager.call).toHaveBeenCalledWith("plugin-1", "performAction", {
      key: "manager-state",
      params: { companyName: "Blueprint Autonomous Operations" },
      renderEnvironment: null,
    });
  });

  it("allows company-scoped agents to read dashboard data through the plugin bridge", async () => {
    mockRegistry.getById.mockResolvedValue(null);
    mockRegistry.getByKey.mockResolvedValue({
      id: "plugin-1",
      pluginKey: "blueprint.automation",
      status: "ready",
      manifestJson: { id: "blueprint.automation" },
      version: "0.1.0",
      displayName: "Blueprint Automation",
    });
    mockWorkerManager.call.mockResolvedValue({
      content: "dashboard",
      data: { ok: true, kind: "dashboard" },
    });

    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/plugins/blueprint.automation/data/dashboard")
      .send({
        companyId: "company-1",
        params: { companyName: "Blueprint Autonomous Operations" },
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      content: "dashboard",
      data: { ok: true, kind: "dashboard" },
    });
    expect(mockWorkerManager.call).toHaveBeenCalledWith("plugin-1", "getData", {
      key: "dashboard",
      params: { companyName: "Blueprint Autonomous Operations" },
      renderEnvironment: null,
    });
  });

  it("keeps unrelated plugin bridge actions board-only", async () => {
    mockRegistry.getById.mockResolvedValue(null);
    mockRegistry.getByKey.mockResolvedValue({
      id: "plugin-1",
      pluginKey: "blueprint.automation",
      status: "ready",
      manifestJson: { id: "blueprint.automation" },
      version: "0.1.0",
      displayName: "Blueprint Automation",
    });

    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/plugins/blueprint.automation/actions/repair-routing")
      .send({
        companyId: "company-1",
        params: {},
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Board access required");
    expect(mockWorkerManager.call).not.toHaveBeenCalled();
  });
});
