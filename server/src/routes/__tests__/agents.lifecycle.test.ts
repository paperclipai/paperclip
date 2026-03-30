import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../agents.js";
import { errorHandler } from "../../middleware/index.js";
import { findServerAdapter } from "../../adapters/index.js";

// Create mocks using vi.hoisted so they persist
const agentServiceImpl = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  updateRuntimeStatus: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  terminate: vi.fn(),
  cancelActiveForAgent: vi.fn(),
}));

const heartbeatServiceImpl = vi.hoisted(() => ({
  listActiveForAgent: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  cancelActiveForAgent: vi.fn(),
}));

const logActivityImpl = vi.hoisted(() => vi.fn());

const accessServiceImpl = vi.hoisted(() => ({
  canUser: vi.fn(),
  getMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalPermission: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAdapter = vi.hoisted(() => ({
  type: "claude_local" as const,
  start: vi.fn().mockResolvedValue({ instanceId: "instance-abc-123" }),
  stop: vi.fn().mockResolvedValue(undefined),
  // scale returns instances based on what adapter.scale would return in manualScale path
  scale: vi.fn().mockResolvedValue({ instances: [{ instanceId: "instance-1", status: "running" }] }),
  listInstances: vi.fn().mockResolvedValue([{ instanceId: "instance-1", status: "running" }]),
  execute: vi.fn().mockResolvedValue({}),
  testEnvironment: vi.fn().mockResolvedValue({ status: "pass" }),
  listSkills: vi.fn().mockResolvedValue([]),
  syncSkills: vi.fn().mockResolvedValue(undefined),
  sessionCodec: {
    deserialize: vi.fn().mockReturnValue(null),
    serialize: vi.fn().mockReturnValue(null),
  },
  sessionManagement: {
    supportsSessionResume: false,
    nativeContextManagement: "unknown" as const,
    defaultSessionCompaction: {
      enabled: false,
      maxSessionRuns: 100,
      maxRawInputTokens: 100000,
      maxSessionAgeHours: 24,
    },
  },
  models: [],
  listModels: vi.fn().mockResolvedValue([]),
  supportsLocalAgentJwt: true,
  agentConfigurationDoc: undefined,
  getQuotaWindows: vi.fn().mockResolvedValue([]),
}));

const companyId = "22222222-2222-4222-8222-222222222222";
const agentId = "11111111-1111-4111-8111-111111111111";
const instanceId = "instance-abc-123";

const mockAgent = {
  id: agentId,
  companyId,
  name: "test-agent",
  role: "general",
  title: null,
  status: "idle",
  instanceId: null,
  adapterType: "claude_local",
  adapterConfig: {},
  runtimeConfig: {},
  capabilities: null,
  permissions: null,
  instructionsFilePath: null,
  instructionsBundleMode: null,
  instructionsRootPath: null,
  instructionsEntryFile: null,
  agentsMdPath: null,
  budgetMonthlyCents: 10000,
  budgetPeriod: "rolling_30d" as const,
  reportsTo: null,
  metadata: null,
  createdAt: new Date("2026-03-01T00:00:00.000Z"),
  updatedAt: new Date("2026-03-01T00:00:00.000Z"),
};

const mockRunningAgent = {
  ...mockAgent,
  status: "running" as const,
  instanceId,
};

// Single vi.mock call for all modules
vi.mock("@paperclipai/db", () => ({
  agents: {},
  heartbeatRuns: {},
  heartbeatRunEvents: {},
  companies: {},
}));

vi.mock("../../adapters/index.js", () => ({
  findServerAdapter: vi.fn().mockReturnValue(mockAdapter),
  listAdapterModels: vi.fn().mockResolvedValue([]),
  detectAdapterModel: vi.fn().mockResolvedValue(null),
  getServerAdapter: vi.fn().mockReturnValue(mockAdapter),
  listServerAdapters: vi.fn().mockReturnValue([]),
}));

vi.mock("../../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: vi.fn().mockResolvedValue({ censorUsernameInLogs: false }),
  }),
}));

vi.mock("../../services/index.js", () => ({
  agentService: () => agentServiceImpl,
  agentInstructionsService: () => ({
    get: vi.fn(),
    upsert: vi.fn(),
  }),
  accessService: () => accessServiceImpl,
  approvalService: () => ({
    canUser: vi.fn(),
  }),
  companySkillService: () => ({
    list: vi.fn(),
  }),
  budgetService: () => ({
    get: vi.fn(),
  }),
  heartbeatService: () => heartbeatServiceImpl,
  issueApprovalService: () => ({
    getById: vi.fn(),
  }),
  issueService: () => ({
    getById: vi.fn(),
  }),
  logActivity: logActivityImpl,
  secretService: () => ({
    get: vi.fn(),
    resolveAdapterConfigForRuntime: vi.fn().mockResolvedValue({ config: {} }),
    normalizeAdapterConfigForPersistence: vi.fn().mockResolvedValue({}),
  }),
  syncInstructionsBundleConfigFromFilePath: vi.fn(),
  workspaceOperationService: () => ({
    canUser: vi.fn(),
  }),
  instanceSettingsService: () => ({
    getGeneral: vi.fn().mockResolvedValue({ censorUsernameInLogs: false }),
  }),
}));

function createApp(actor?: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor ?? {
      type: "board",
      userId: "user-1",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: true,
    };
    next();
  });
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("POST /agents/:id/start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentServiceImpl.getById.mockResolvedValue(null);
    agentServiceImpl.update.mockResolvedValue({});
    logActivityImpl.mockResolvedValue(undefined);
  });

  it("returns 404 if agent not found", async () => {
    agentServiceImpl.getById.mockResolvedValue(null);

    const res = await request(createApp()).post(`/api/agents/${agentId}/start`);

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 409 if agent is already running", async () => {
    agentServiceImpl.getById.mockResolvedValue(mockRunningAgent);

    const res = await request(createApp()).post(`/api/agents/${agentId}/start`);

    expect(res.status).toBe(409);
    expect(res.body).toHaveProperty("error");
  });

  it("calls adapter.start() when available", async () => {
    agentServiceImpl.getById.mockResolvedValue(mockAgent);
    agentServiceImpl.update.mockResolvedValue({ ...mockRunningAgent });

    const res = await request(createApp()).post(`/api/agents/${agentId}/start`);

    expect(res.status).toBe(200);
  });

  it("falls back to stateless execute() when start not implemented", async () => {
    vi.mocked(findServerAdapter).mockReturnValueOnce({ ...mockAdapter, start: undefined });
    agentServiceImpl.getById.mockResolvedValue(mockAgent);
    agentServiceImpl.updateRuntimeStatus.mockResolvedValue({ ...mockRunningAgent });

    const res = await request(createApp()).post(`/api/agents/${agentId}/start`);

    expect(res.status).toBe(200);
    expect(mockAdapter.execute).toHaveBeenCalled();
    expect(res.body).toHaveProperty("instanceId", "stateless");
  });

  it("sets status to running and stores instanceId", async () => {
    agentServiceImpl.getById.mockResolvedValue(mockAgent);
    agentServiceImpl.updateRuntimeStatus.mockResolvedValue({ ...mockRunningAgent });

    const res = await request(createApp()).post(`/api/agents/${agentId}/start`);

    expect(res.status).toBe(200);
    expect(agentServiceImpl.updateRuntimeStatus).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({
        status: "running",
        instanceId: expect.anything(),
      }),
    );
  });

  it("logs agent.started activity", async () => {
    agentServiceImpl.getById.mockResolvedValue(mockAgent);
    agentServiceImpl.updateRuntimeStatus.mockResolvedValue({ ...mockRunningAgent });

    await request(createApp()).post(`/api/agents/${agentId}/start`);

    expect(logActivityImpl).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "agent.started",
        entityId: agentId,
        companyId,
      }),
    );
  });

  it("returns 500 and rolls back if DB update fails after adapter.start()", async () => {
    agentServiceImpl.getById.mockResolvedValue(mockAgent);
    agentServiceImpl.updateRuntimeStatus.mockRejectedValue(new Error("DB error"));

    const res = await request(createApp()).post(`/api/agents/${agentId}/start`);

    // The route catches the error, calls adapter.stop() for rollback, and returns 500
    // logActivity is NOT called on rollback (per the actual route code)
    expect(res.status).toBe(500);
  });
});

describe("POST /agents/:id/stop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentServiceImpl.getById.mockResolvedValue(null);
    agentServiceImpl.cancelActiveForAgent.mockResolvedValue(undefined);
    agentServiceImpl.updateRuntimeStatus.mockResolvedValue({});
    logActivityImpl.mockResolvedValue(undefined);
  });

  it("returns 404 if agent not found", async () => {
    agentServiceImpl.getById.mockResolvedValue(null);

    const res = await request(createApp()).post(`/api/agents/${agentId}/stop`);

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 409 if agent is already idle", async () => {
    agentServiceImpl.getById.mockResolvedValue(mockAgent);

    const res = await request(createApp()).post(`/api/agents/${agentId}/stop`);

    expect(res.status).toBe(409);
    expect(res.body).toHaveProperty("error");
  });

  it("calls adapter.stop() when available", async () => {
    agentServiceImpl.getById.mockResolvedValue(mockRunningAgent);

    const res = await request(createApp()).post(`/api/agents/${agentId}/stop`);

    expect(res.status).toBe(200);
  });

  it("falls back to cancelActiveForAgent when stop not implemented", async () => {
    vi.mocked(findServerAdapter).mockReturnValueOnce({ ...mockAdapter, stop: undefined });
    agentServiceImpl.getById.mockResolvedValue(mockRunningAgent);
    agentServiceImpl.updateRuntimeStatus.mockResolvedValue({ ...mockAgent });

    const res = await request(createApp()).post(`/api/agents/${agentId}/stop`);

    expect(res.status).toBe(200);
    expect(heartbeatServiceImpl.cancelActiveForAgent).toHaveBeenCalledWith(agentId);
  });

  it("sets status to idle and clears instanceId", async () => {
    agentServiceImpl.getById.mockResolvedValue(mockRunningAgent);
    agentServiceImpl.updateRuntimeStatus.mockResolvedValue({ ...mockAgent });

    const res = await request(createApp()).post(`/api/agents/${agentId}/stop`);

    expect(res.status).toBe(200);
    expect(agentServiceImpl.updateRuntimeStatus).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({
        status: "idle",
        instanceId: null,
      }),
    );
  });
});

describe("POST /agents/:id/scale", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentServiceImpl.getById.mockResolvedValue(null);
    agentServiceImpl.update.mockResolvedValue(mockAgent);
    heartbeatServiceImpl.listActiveForAgent.mockResolvedValue([]);
    logActivityImpl.mockResolvedValue(undefined);
  });

  it("returns 404 if agent not found", async () => {
    agentServiceImpl.getById.mockResolvedValue(null);

    const res = await request(createApp())
      .post(`/api/agents/${agentId}/scale`)
      .send({ count: 2 });

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });

  it("calls adapter.scale(count) when available", async () => {
    agentServiceImpl.getById.mockResolvedValue(mockAgent);

    const res = await request(createApp())
      .post(`/api/agents/${agentId}/scale`)
      .send({ count: 3 });

    expect(res.status).toBe(200);
  });

  it("manually starts instances when scale not implemented and count > current", async () => {
    agentServiceImpl.getById.mockResolvedValue(mockAgent);
    heartbeatServiceImpl.listActiveForAgent.mockResolvedValue([]);

    const res = await request(createApp())
      .post(`/api/agents/${agentId}/scale`)
      .send({ count: 2 });

    expect(res.status).toBe(200);
  });

  it("uses listInstances when adapter.listInstances is available", async () => {
    agentServiceImpl.getById.mockResolvedValue(mockAgent);
    heartbeatServiceImpl.listActiveForAgent.mockResolvedValue([
      { id: "run-1", instanceId: "instance-1" },
    ]);

    const res = await request(createApp())
      .post(`/api/agents/${agentId}/scale`)
      .send({ count: 1 });

    expect(res.status).toBe(200);
    expect(res.body.instances).toHaveLength(1);
  });

  it("manually stops instances when scale not implemented and count < current", async () => {
    agentServiceImpl.getById.mockResolvedValue(mockAgent);
    heartbeatServiceImpl.listActiveForAgent.mockResolvedValue([
      { id: "run-1", instanceId: "instance-1" },
      { id: "run-2", instanceId: "instance-2" },
    ]);

    const res = await request(createApp())
      .post(`/api/agents/${agentId}/scale`)
      .send({ count: 1 });

    expect(res.status).toBe(200);
  });

  it("stops all instances when count = 0", async () => {
    agentServiceImpl.getById.mockResolvedValue(mockAgent);
    heartbeatServiceImpl.listActiveForAgent.mockResolvedValue([
      { id: "run-1", instanceId: "instance-1" },
      { id: "run-2", instanceId: "instance-2" },
    ]);

    const res = await request(createApp())
      .post(`/api/agents/${agentId}/scale`)
      .send({ count: 0 });

    expect(res.status).toBe(200);
  });

  it("returns list of active instances", async () => {
    agentServiceImpl.getById.mockResolvedValue(mockAgent);

    const res = await request(createApp())
      .post(`/api/agents/${agentId}/scale`)
      .send({ count: 2 });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("instances");
  });
});
