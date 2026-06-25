import type { Server } from "node:http";
import express from "express";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { environmentRoutes } from "../routes/environments.js";
import { errorHandler } from "../middleware/index.js";

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockEnvironmentService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  listLeases: vi.fn(),
  getLeaseById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockProbeEnvironment = vi.hoisted(() => vi.fn());
const mockSecretService = vi.hoisted(() => ({
  create: vi.fn(),
  resolveSecretValue: vi.fn(),
}));
const mockValidatePluginEnvironmentDriverConfig = vi.hoisted(() => vi.fn());
const mockValidatePluginSandboxProviderConfig = vi.hoisted(() => vi.fn());
const mockListReadyPluginEnvironmentDrivers = vi.hoisted(() => vi.fn());
const mockExecutionWorkspaceService = vi.hoisted(() => ({}));
const mockInstanceSettingsService = vi.hoisted(() => ({
  listCompanyIds: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  issueService: () => mockIssueService,
  environmentService: () => mockEnvironmentService,
  instanceSettingsService: () => mockInstanceSettingsService,
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
}));

vi.mock("../services/environment-probe.js", () => ({
  probeEnvironment: mockProbeEnvironment,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => mockEnvironmentService,
}));

vi.mock("../services/execution-workspaces.js", () => ({
  executionWorkspaceService: () => mockExecutionWorkspaceService,
}));

vi.mock("../services/plugin-environment-driver.js", () => ({
  listReadyPluginEnvironmentDrivers: mockListReadyPluginEnvironmentDrivers,
  validatePluginEnvironmentDriverConfig: mockValidatePluginEnvironmentDriverConfig,
  validatePluginSandboxProviderConfig: mockValidatePluginSandboxProviderConfig,
}));

let server: Server | null = null;
let currentActor: Record<string, unknown> = {
  type: "board",
  userId: "user-1",
  source: "local_implicit",
};
const routeOptions: Record<string, unknown> = {};

function createApp(actor: Record<string, unknown>, options: Record<string, unknown> = {}) {
  currentActor = actor;
  for (const key of Object.keys(routeOptions)) {
    delete routeOptions[key];
  }
  Object.assign(routeOptions, options);
  if (server) return server;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = currentActor;
    next();
  });
  app.use("/api", environmentRoutes({} as any, routeOptions as any));
  app.use(errorHandler);
  server = app.listen(0);
  return server;
}

describe("GET /companies/:companyId/environments/capabilities — k8s adapters", () => {
  afterAll(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server?.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    server = null;
  });

  beforeEach(() => {
    mockListReadyPluginEnvironmentDrivers.mockReset();
    mockListReadyPluginEnvironmentDrivers.mockResolvedValue([]);
  });

  it("includes claude_k8s and opencode_k8s rows with drivers.k8s='supported'", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app).get("/api/companies/company-1/environments/capabilities");

    expect(res.status).toBe(200);

    const claudeK8s = res.body.adapters.find((a: any) => a.adapterType === "claude_k8s");
    const opencodeK8s = res.body.adapters.find((a: any) => a.adapterType === "opencode_k8s");
    const claudeLocal = res.body.adapters.find((a: any) => a.adapterType === "claude_local");

    expect(claudeK8s?.drivers.k8s).toBe("supported");
    expect(opencodeK8s?.drivers.k8s).toBe("supported");
    expect(claudeLocal?.drivers.k8s).toBe("unsupported");
  });

  it("preserves existing adapter rows (claude_local local/ssh/sandbox unchanged)", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app).get("/api/companies/company-1/environments/capabilities");

    expect(res.status).toBe(200);

    const claudeLocal = res.body.adapters.find((a: any) => a.adapterType === "claude_local");
    expect(claudeLocal?.drivers.local).toBe("supported");
    expect(claudeLocal?.drivers.ssh).toBe("supported");
    expect(claudeLocal?.drivers.sandbox).toBe("supported");
  });
});
